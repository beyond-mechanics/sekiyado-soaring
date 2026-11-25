#!/usr/bin/env python3
"""
SEKIYADO SOARING のフライト録画 JSON（V / Shift+V で保存）を Blender に読み込み、
実際の標高・航空写真の地形とカメラ／機体の動きを再現する。
動画生成 AI（深度・法線ガイド付き Video-to-Video など）向けに、Beauty・Mist（深度）・Normal パスも書き出せる。

使い方（Blender 4.2 以降。Blender 本体の Python で実行する）:
  blender --background --python scripts/blender_import_flight.py -- \
    --data-dir ./assets/data --flight ./sekiyado_clip30s_YYYYMMDD_HHMMSS.json \
    --save-blend ./renders/clip01/scene.blend

  # レンダリングまで行う（各フレームを Beauty・Mist・Normal 入りのマルチレイヤー EXR で保存。
  #   Blender 4.x では Beauty・Mist・Normal を PNG 連番にも分けて書き出す）
  blender --background --python scripts/blender_import_flight.py -- \
    --data-dir ./assets/data --flight ./clip.json --out ./renders/clip01 \
    --fps 24 --start-sec 2 --duration-sec 28 --shutter 0.45 \
    --engine CYCLES --samples 32 --width 1280 --height 720 --render

  録画（60 fps）から出力のフレームレート（--fps、既定 24）に合わせてキーを打ち、モーションブラー（--shutter）を掛ける。
  機体が低く飛んだ区間（対地 140 m 未満）の周りには、Geometry Nodes で草を生やす（--grass-density、0 で無効）。
  録画から AI 実写化までまとめて行う場合は scripts/render_and_ai_v2v.py を使う。

座標系の変換：
  three.js（x=東, y=上, z=南）→ Blender（x=東, y=北, z=上）
  位置 (x, y, z) → (x, -z, y)、回転は x 軸まわり +90° を左から掛ける（カメラは両者とも -Z 向き・+Y 上で同じ）。
"""

import argparse
import json
import math
import os
import struct
import sys

import bpy
from mathutils import Quaternion, Vector

R_EARTH = 6371000.0
Q_T2B = Quaternion((math.sqrt(0.5), math.sqrt(0.5), 0.0, 0.0))  # x 軸まわり +90°


def t2b_pos(x, y, z):
    return (float(x), float(-z), float(y))


def t2b_quat(qx, qy, qz, qw):
    return Q_T2B @ Quaternion((float(qw), float(qx), float(qy), float(qz)))


def enum_items(obj, prop):
    return [i.identifier for i in obj.bl_rna.properties[prop].enum_items]


def enable_nodes(datablock):
    """マテリアル・ワールドをノードで使う。Blender 5.0 以降は常にノードなので use_nodes に触れない（非推奨の警告を出さない）"""
    if bpy.app.version < (5, 0, 0) and hasattr(datablock, "use_nodes"):
        datablock.use_nodes = True
    return datablock.node_tree


def new_node(nt, *types):
    """ノードを作る。Blender のバージョンで型名が違うものは候補を順に試す"""
    for t in types:
        try:
            return nt.nodes.new(t)
        except RuntimeError:
            continue
    raise RuntimeError("ノードを作れません: " + ", ".join(types))


def set_if(obj, name, value):
    if hasattr(obj, name):
        setattr(obj, name, value)


# ---------------------------------------------------------------- 地形

def build_grid_mesh(name, xmin, zmin, width, depth, segx, segz, height_fn, img_path=None):
    nx = segx + 1
    verts, uvs = [], []
    for j in range(segz + 1):
        v = j / segz
        z = zmin + v * depth
        for i in range(nx):
            u = i / segx
            x = xmin + u * width
            verts.append(t2b_pos(x, height_fn(i, j, x, z), z))
            uvs.append((u, 1.0 - v))  # 画像の上端 = 北（three.js の zmin）
    faces = []
    for j in range(segz):
        r0, r1 = j * nx, (j + 1) * nx
        for i in range(segx):
            faces.append((r0 + i, r1 + i, r1 + i + 1, r0 + i + 1))  # Blender で上向きの法線になる順
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for loop in mesh.loops:
        uv_layer.data[loop.index].uv = uvs[loop.vertex_index]
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)

    mat = bpy.data.materials.new(name=f"{name}_Mat")
    enable_nodes(mat)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.95
    if img_path and os.path.exists(img_path):
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(os.path.abspath(img_path))
        tex.extension = "EXTEND"
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        bsdf.inputs["Base Color"].default_value = (0.16, 0.2, 0.12, 1.0)
    obj.data.materials.append(mat)
    return obj


def build_terrains(data_dir, skip_far=False):
    def load(name):
        with open(os.path.join(data_dir, name), encoding="utf-8") as f:
            return json.load(f)

    meta, dem, detail = load("terrain.json"), load("elevation.json"), load("detail.json")

    # 広域（約 8 km 四方、128 分割）。詳細域の下に少し沈めて重なりのちらつきを防ぐ
    wide = dem["heights"]
    dx0, dx1 = detail["xmin"], detail["xmin"] + detail["width"]
    dz0, dz1 = detail["zmin"], detail["zmin"] + detail["depth"]

    def wide_h(i, j, x, z):
        h = wide[j * 129 + i]
        return h - 2.0 if (dx0 + 15 < x < dx1 - 15 and dz0 + 15 < z < dz1 - 15) else h

    build_grid_mesh("Terrain_Wide", meta["xmin"], meta["zmin"], meta["size"], meta["size"], 128, 128,
                    wide_h, os.path.join(data_dir, "terrain_wide.jpg"))

    det = detail["heights"]
    dnx = detail["segx"] + 1
    detail_obj = build_grid_mesh("Terrain_Detail", detail["xmin"], detail["zmin"], detail["width"], detail["depth"],
                    detail["segx"], detail["segz"], lambda i, j, x, z: det[j * dnx + i],
                    os.path.join(data_dir, "terrain_detail.jpg"))

    far_path = os.path.join(data_dir, "far_dem.bin")
    if skip_far or not os.path.exists(far_path):
        return detail_obj, detail
    with open(far_path, "rb") as f:
        buf = f.read()
    far_n = struct.unpack_from("<I", buf, 0)[0]
    far_half = struct.unpack_from("<f", buf, 4)[0]
    heights = struct.unpack_from(f"<{(far_n + 1) * (far_n + 1)}h", buf, 16)
    step = 2
    mx0, mx1 = meta["xmin"] + 120, meta["xmin"] + meta["size"] - 120
    mz0, mz1 = meta["zmin"] + 120, meta["zmin"] + meta["size"] - 120

    def far_h(i, j, x, z):
        h = heights[(j * step) * (far_n + 1) + i * step]
        if mx0 < x < mx1 and mz0 < z < mz1:
            h -= 8.0
        return h - (x * x + z * z) / (2.0 * R_EARTH)  # 地球の丸み

    build_grid_mesh("Terrain_Far", -far_half, -far_half, 2 * far_half, 2 * far_half,
                    far_n // step, far_n // step, far_h, None)
    return detail_obj, detail


# ---------------------------------------------------------------- 低空区間の草（Geometry Nodes）

def gn_socket(node, name, kind=None, output=False):
    """同名のソケットが型違いで複数あるノード（Random Value など）から、型を指定して取り出す"""
    socks = node.outputs if output else node.inputs
    for sk in socks:
        if sk.name == name and getattr(sk, "enabled", True) and (kind is None or sk.type == kind):
            return sk
    for sk in socks:
        if sk.name == name and (kind is None or sk.type == kind):
            return sk
    raise KeyError(f"{node.bl_idname} に {name}（{kind}）がありません")


def gn_interface(ng, name, in_out):
    if hasattr(ng, "interface"):  # Blender 4.0 以降
        ng.interface.new_socket(name=name, in_out=in_out, socket_type="NodeSocketGeometry")
    elif in_out == "INPUT":
        ng.inputs.new("NodeSocketGeometry", name)
    else:
        ng.outputs.new("NodeSocketGeometry", name)


def make_grass_tuft():
    """草の株（長さ 30〜48 cm の葉 4 枚）。色は地面の航空写真（インスタンス元の UV）から取る"""
    verts, faces = [], []
    for ang, w, h, bend in ((0.0, 0.14, 0.36, 0.08), (2.094, 0.13, 0.44, 0.10), (4.188, 0.12, 0.30, 0.06), (1.047, 0.11, 0.48, 0.12)):
        b = len(verts)
        ca, sa = math.cos(ang), math.sin(ang)
        rx, ry = -sa, ca
        verts += [(-rx * w / 2, -ry * w / 2, 0.0), (rx * w / 2, ry * w / 2, 0.0),
                  (-rx * w * 0.32 + ca * bend * 0.35, -ry * w * 0.32 + sa * bend * 0.35, h * 0.52),
                  (rx * w * 0.32 + ca * bend * 0.35, ry * w * 0.32 + sa * bend * 0.35, h * 0.52),
                  (ca * bend, sa * bend, h)]
        faces += [(b, b + 1, b + 3, b + 2), (b + 2, b + 3, b + 4)]
    mesh = bpy.data.meshes.new("GrassTuft")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Asset_GrassTuft", mesh)
    obj.hide_render = True
    obj.hide_viewport = True
    bpy.context.collection.objects.link(obj)

    mat = bpy.data.materials.new("GrassTuft_Mat")
    nt = enable_nodes(mat)
    bsdf = nt.nodes.get("Principled BSDF")
    return obj, mat, nt, bsdf


def attach_low_pass_grass(detail_obj, detail, frames, img_path, density=6.0, radius=170.0):
    """機体が対地 140 m 未満で飛んだ区間の周り（半径 radius m）だけに草を生やす（全域に生やすと重すぎる）"""
    if density <= 0:
        return
    low = [(fr["plane"]["pos"][0], fr["plane"]["pos"][2]) for fr in frames[::max(1, len(frames) // 300)]
           if float(fr["plane"].get("agl", 1e9)) < 140.0]
    if not low:
        print("[SEKIYADO] 低空区間がないので草は省略")
        return
    nx = detail["segx"] + 1
    r_out2, r_in2 = radius ** 2, (radius * 0.55) ** 2
    vg = detail_obj.vertex_groups.new(name="GrassMask")
    for j in range(detail["segz"] + 1):
        z = detail["zmin"] + j / detail["segz"] * detail["depth"]
        for i in range(nx):
            x = detail["xmin"] + i / detail["segx"] * detail["width"]
            d2 = min((x - px) ** 2 + (z - pz) ** 2 for px, pz in low)
            if d2 < r_out2:
                vg.add([j * nx + i], 1.0 if d2 <= r_in2 else (r_out2 - d2) / (r_out2 - r_in2), "REPLACE")

    tuft, mat, nt, bsdf = make_grass_tuft()
    # 色：インスタンス元（地面）の UV で航空写真を引き、根元を暗く・先を明るくする
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_type = "INSTANCER"
    attr.attribute_name = "UVMap"
    tex = nt.nodes.new("ShaderNodeTexImage")
    if img_path and os.path.exists(img_path):
        tex.image = bpy.data.images.load(os.path.abspath(img_path), check_existing=True)
    nt.links.new(attr.outputs["Vector"], tex.inputs["Vector"])
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sep.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.35, 0.42, 0.28, 1.0)
    ramp.color_ramp.elements[1].color = (1.0, 1.1, 0.8, 1.0)
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    mix = nt.nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MULTIPLY"
    mix.inputs["Fac"].default_value = 0.9
    nt.links.new(tex.outputs["Color"], mix.inputs["Color1"])
    nt.links.new(ramp.outputs["Color"], mix.inputs["Color2"])
    nt.links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.8
    tuft.data.materials.append(mat)

    ng = bpy.data.node_groups.new("SekiyadoGrass", "GeometryNodeTree")
    gn_interface(ng, "Geometry", "INPUT")
    gn_interface(ng, "Geometry", "OUTPUT")
    N, L = ng.nodes, ng.links
    gin, gout = N.new("NodeGroupInput"), N.new("NodeGroupOutput")
    mask = N.new("GeometryNodeInputNamedAttribute")
    mask.data_type = "FLOAT"
    gn_socket(mask, "Name").default_value = "GrassMask"
    dist = N.new("GeometryNodeDistributePointsOnFaces")
    dist.distribute_method = "RANDOM"
    gn_socket(dist, "Density").default_value = float(density)
    gn_socket(dist, "Seed").default_value = 42
    info = N.new("GeometryNodeObjectInfo")
    gn_socket(info, "Object").default_value = tuft
    rot = N.new("FunctionNodeRandomValue")
    rot.data_type = "FLOAT_VECTOR"
    gn_socket(rot, "Min", "VECTOR").default_value = (-0.18, -0.18, 0.0)
    gn_socket(rot, "Max", "VECTOR").default_value = (0.18, 0.18, 6.2831853)
    scl = N.new("FunctionNodeRandomValue")
    scl.data_type = "FLOAT"
    gn_socket(scl, "Min", "VALUE").default_value = 0.75
    gn_socket(scl, "Max", "VALUE").default_value = 1.6
    inst = N.new("GeometryNodeInstanceOnPoints")
    join = N.new("GeometryNodeJoinGeometry")
    L.new(gn_socket(gin, "Geometry", output=True), gn_socket(dist, "Mesh"))
    L.new(gn_socket(mask, "Attribute", "VALUE", output=True), gn_socket(dist, "Density Factor"))
    L.new(gn_socket(dist, "Points", output=True), gn_socket(inst, "Points"))
    L.new(gn_socket(info, "Geometry", output=True), gn_socket(inst, "Instance"))
    L.new(gn_socket(rot, "Value", "VECTOR", output=True), gn_socket(inst, "Rotation"))
    L.new(gn_socket(scl, "Value", "VALUE", output=True), gn_socket(inst, "Scale"))
    L.new(gn_socket(gin, "Geometry", output=True), join.inputs[0])
    L.new(gn_socket(inst, "Instances", output=True), join.inputs[0])
    L.new(gn_socket(join, "Geometry", output=True), gn_socket(gout, "Geometry"))
    mod = detail_obj.modifiers.new(name="LowPassGrass", type="NODES")
    mod.node_group = ng
    print(f"[SEKIYADO] 草：低空区間 {len(low)} 点の周り、密度 {density}/m²")


# ---------------------------------------------------------------- 空と太陽

def setup_world_and_sun(env):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("SekiyadoWorld")
    scene.world = world
    nt = enable_nodes(world)
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    sky = nt.nodes.new("ShaderNodeTexSky")

    sx, sy, sz = env.get("sunDir", [0.3, 0.7, -0.6])
    bx, by, bz = t2b_pos(sx, sy, sz)
    elevation = math.asin(max(-1.0, min(1.0, bz)))
    types = enum_items(sky, "sky_type")
    for t in ("MULTIPLE_SCATTERING", "NISHITA", "SINGLE_SCATTERING"):
        if t in types:
            sky.sky_type = t
            break
    set_if(sky, "sun_disc", False)  # 直射光は下の Sun ライトで与える（二重にしない）
    set_if(sky, "sun_elevation", elevation)
    # 物理空の sun_rotation は北(+Y)を 0 として反時計回り（西向き）に測る
    set_if(sky, "sun_rotation", math.atan2(-bx, by))
    vis = float(env.get("visibility", 60000))
    haze = 2.2 if vis < 40000 else (1.2 if vis < 90000 else 0.7)
    set_if(sky, "dust_density", haze)
    set_if(sky, "aerosol_density", haze)
    set_if(sky, "air_density", 1.0)
    bg.inputs["Strength"].default_value = 0.3
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    # 太陽：ライトの -Z 軸を太陽光の進む向き（-sunDir）に合わせる（シミュレーターと同じ方向）
    sun_data = bpy.data.lights.new("Sun", "SUN")
    sun_data.energy = 4.0 * max(0.15, min(1.0, bz / 0.6))
    sun_data.angle = math.radians(0.53)
    sun = bpy.data.objects.new("Sun", sun_data)
    sun.rotation_mode = "QUATERNION"
    sun.rotation_quaternion = Vector((0.0, 0.0, 1.0)).rotation_difference(Vector((bx, by, bz)))
    bpy.context.collection.objects.link(sun)


# ---------------------------------------------------------------- カメラと機体の動き

def select_frames(flight, start_sec=0.0, duration_sec=0.0):
    """録画の一部（start_sec から duration_sec 秒）を取り出す。前後 1 コマずつ残して区間の端も補間できるようにする。"""
    frames = flight.get("frames", [])
    if not frames:
        raise SystemExit("frames が空です")
    t_end = float(frames[-1]["t"])
    t0 = max(0.0, min(float(start_sec), t_end))
    t1 = min(t_end, t0 + float(duration_sec)) if duration_sec > 0 else t_end
    i0 = max(0, max((i for i, fr in enumerate(frames) if fr["t"] <= t0), default=0))
    i1 = min(len(frames) - 1, min((i for i, fr in enumerate(frames) if fr["t"] >= t1), default=len(frames) - 1))
    return frames[i0:i1 + 1], t0, t1


def insert_motion(flight, fps=24, start_sec=0.0, duration_sec=0.0, show_plane=False):
    scene = bpy.context.scene
    frames, t0, t1 = select_frames(flight, start_sec, duration_sec)
    # 出力のフレームレート（録画は 60 fps。動画は 24 fps などにしてキーは録画の時刻どおりに打つ）
    scene.render.fps = int(fps)
    scene.render.fps_base = 1.0
    scene.frame_start = 1
    scene.frame_end = 1 + max(1, int(math.floor((t1 - t0) * fps)))

    cam_data = bpy.data.cameras.new("FlightCam")
    cam_data.sensor_fit = "VERTICAL"
    cam_data.sensor_height = 24.0
    cam_data.clip_start = 0.2
    cam_data.clip_end = 400000.0
    cam = bpy.data.objects.new("FlightCam", cam_data)
    cam.rotation_mode = "QUATERNION"
    bpy.context.collection.objects.link(cam)
    scene.camera = cam

    plane = bpy.data.objects.new("Aircraft", None)
    plane.rotation_mode = "QUATERNION"
    bpy.context.collection.objects.link(plane)
    if show_plane:
        # 目安の形（機首 = ローカル +Y、主翼 = ±X）
        for name, scale, loc in (("Fuselage", (0.45, 7.5, 0.6), (0, 0, 0)), ("Wing", (17.0, 1.0, 0.1), (0, 0.6, 0.15))):
            mesh = bpy.data.meshes.new(name)
            sx, sy, sz = (s / 2 for s in scale)
            mesh.from_pydata([(x * sx, y * sy, z * sz) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], [],
                             [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)])
            part = bpy.data.objects.new(name, mesh)
            part.location = loc
            part.parent = plane
            bpy.context.collection.objects.link(part)

    # 記録は描画の fps に左右されて間隔が揺れるので、時刻 t からフレーム番号を決める（小数フレーム可）。
    # 補間は直線にして、行き過ぎ（オーバーシュート）を防ぐ。
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    prev = {}

    def continuous(key, q):
        # 四元数の符号反転による一回転を防ぐ
        p = prev.get(key)
        if p is not None and p.dot(q) < 0:
            q.negate()
        prev[key] = q.copy()
        return q

    for fr in frames:
        f = 1.0 + (float(fr["t"]) - t0) * fps
        c = fr["cam"]
        cam.location = t2b_pos(*c["pos"])
        cam.rotation_quaternion = continuous("cam", t2b_quat(*c["quat"]))
        fov = math.radians(max(5.0, min(140.0, float(c.get("fov", 60.0)))))
        cam_data.lens = 12.0 / math.tan(fov / 2)  # 縦の画角（three.js と同じ）
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_quaternion", frame=f)
        cam_data.keyframe_insert("lens", frame=f)
        p = fr["plane"]
        plane.location = t2b_pos(*p["pos"])
        plane.rotation_quaternion = continuous("plane", t2b_quat(*p["quat"]))
        plane.keyframe_insert("location", frame=f)
        plane.keyframe_insert("rotation_quaternion", frame=f)
    return frames


# ---------------------------------------------------------------- レンダー設定

def setup_render(out_dir, engine, samples, width, height, shutter=0.45):
    scene = bpy.context.scene
    engines = enum_items(scene.render, "engine")
    if engine == "EEVEE":
        engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.render.engine = engine
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    if "AgX" in enum_items(scene.view_settings, "view_transform"):
        scene.view_settings.view_transform = "AgX"
    # モーションブラー（シャッターはフレーム間隔に対する割合。0 で無効）
    scene.render.use_motion_blur = shutter > 0
    scene.render.motion_blur_shutter = max(0.0, float(shutter))

    if engine == "CYCLES":
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for dev in ("OPTIX", "CUDA", "METAL", "HIP", "ONEAPI"):
                try:
                    prefs.compute_device_type = dev
                except TypeError:
                    continue
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type == dev]
                if gpus:
                    # GPU だけを使う（CPU を混ぜると、速い GPU が CPU の担当分を待って遅くなることがある）
                    for d in prefs.devices:
                        d.use = d.type == dev
                    scene.cycles.device = "GPU"
                    print(f"[SEKIYADO] Cycles {dev}:", ", ".join(d.name for d in gpus))
                    break
        except Exception as e:  # GPU が使えなければ CPU のまま
            print("[SEKIYADO] GPU 設定をスキップ:", e)
    elif hasattr(scene, "eevee"):
        set_if(scene.eevee, "taa_render_samples", samples)

    vl = scene.view_layers[0]
    vl.use_pass_mist = True
    vl.use_pass_normal = True
    scene.world.mist_settings.start = 5.0
    scene.world.mist_settings.depth = 3500.0
    scene.world.mist_settings.falloff = "QUADRATIC"

    # すべてのパスを 1 枚に持つマルチレイヤー EXR（後から別の用途に取り出せる控え）
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    scene.render.filepath = os.path.join(out_dir, "exr", "frame_")
    fmt = scene.render.image_settings
    if hasattr(fmt, "media_type"):  # Blender 5.x：形式の種類（画像・マルチレイヤー・動画）を先に選ぶ
        fmt.media_type = "MULTI_LAYER_IMAGE"
        fmt.file_format = "OPEN_EXR"
    else:
        fmt.file_format = "OPEN_EXR_MULTILAYER"
    fmt.color_depth = "16"

    # コンポジターで Beauty・Mist・Normal を PNG 連番に分けて書き出す（AI 実写化の入力と制御用）
    try:
        if hasattr(scene, "compositing_node_group"):  # Blender 5.x：コンポジターはノードグループ
            nt = bpy.data.node_groups.new("SekiyadoComp", "CompositorNodeTree")
            nt.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            scene.compositing_node_group = nt
            rl = nt.nodes.new("CompositorNodeRLayers")
            gout = nt.nodes.new("NodeGroupOutput")
            nt.links.new(rl.outputs["Image"], gout.inputs[0])
        else:  # Blender 4.x
            scene.use_nodes = True
            nt = scene.node_tree
            nt.nodes.clear()
            rl = nt.nodes.new("CompositorNodeRLayers")
            comp = nt.nodes.new("CompositorNodeComposite")
            nt.links.new(rl.outputs["Image"], comp.inputs["Image"])
        # 法線は -1〜1 なので、PNG に入れる前に 0〜1 へ移す（そのままだと負の成分が 0 に切られる）
        sep = new_node(nt, "CompositorNodeSeparateColor", "ShaderNodeSeparateColor")
        comb = new_node(nt, "CompositorNodeCombineColor", "ShaderNodeCombineColor")
        nt.links.new(rl.outputs["Normal"], sep.inputs[0])
        for k in range(3):
            m = new_node(nt, "CompositorNodeMath", "ShaderNodeMath")
            m.operation = "MULTIPLY_ADD"
            m.inputs[1].default_value = 0.5
            m.inputs[2].default_value = 0.5
            nt.links.new(sep.outputs[k], m.inputs[0])
            nt.links.new(m.outputs[0], comb.inputs[k])
        for name, src, kind in (("beauty", rl.outputs["Image"], "RGBA"), ("mist", rl.outputs["Mist"], "FLOAT"),
                                ("normal", comb.outputs[0], "RGBA")):
            add_png_output(nt, os.path.join(out_dir, name), src, kind)
    except Exception as e:
        print("[SEKIYADO] PNG の分割出力を設定できませんでした（EXR は出力されます）:", e)


def add_png_output(nt, directory, src, kind):
    """1 つのパスを directory/frame_0001.png … に書き出す File Output ノード（パスごとに 1 つ）"""
    os.makedirs(directory, exist_ok=True)
    fout = nt.nodes.new("CompositorNodeOutputFile")
    if hasattr(fout.format, "media_type"):
        fout.format.media_type = "IMAGE"
    fout.format.file_format = "PNG"
    fout.format.color_mode = "BW" if kind == "FLOAT" else "RGB"
    if hasattr(fout, "file_output_items"):  # Blender 5.x
        fout.directory = directory
        set_if(fout, "file_name", "frame_")
        fout.file_output_items.clear()
        fout.file_output_items.new(kind, "")
    else:  # Blender 4.x
        fout.base_path = directory
        fout.file_slots.clear()
        fout.file_slots.new("frame_")
    nt.links.new(src, fout.inputs[0])


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(description="SEKIYADO SOARING フライト JSON → Blender")
    ap.add_argument("--data-dir", required=True, help="assets/data（terrain.json などがあるフォルダー）")
    ap.add_argument("--flight", required=True, help="シミュレーターで保存したフライト JSON")
    ap.add_argument("--out", default="./renders/clip")
    ap.add_argument("--save-blend", default="")
    ap.add_argument("--engine", default="CYCLES", choices=["CYCLES", "EEVEE"])
    ap.add_argument("--samples", type=int, default=32)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--show-plane", action="store_true", help="機体の位置に目安の形を置く")
    ap.add_argument("--skip-far", action="store_true", help="約 300 km 四方の遠景地形を作らない（軽量化）")
    ap.add_argument("--fps", type=int, default=24, help="出力のフレームレート")
    ap.add_argument("--start-sec", type=float, default=0.0, help="録画のどこから使うか（秒）")
    ap.add_argument("--duration-sec", type=float, default=0.0, help="使う長さ（秒、0 = 最後まで）")
    ap.add_argument("--shutter", type=float, default=0.45, help="モーションブラーのシャッター（0 で無効）")
    ap.add_argument("--grass-density", type=float, default=6.0, help="低空区間の草の密度（本/m²、0 で無効）")
    ap.add_argument("--render", action="store_true")
    args = ap.parse_args(argv)

    with open(args.flight, encoding="utf-8") as f:
        flight = json.load(f)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    detail_obj, detail = build_terrains(args.data_dir, skip_far=args.skip_far)
    setup_world_and_sun(flight.get("environment", {}))
    frames = insert_motion(flight, fps=args.fps, start_sec=args.start_sec, duration_sec=args.duration_sec,
                           show_plane=args.show_plane)
    try:
        attach_low_pass_grass(detail_obj, detail, frames, os.path.join(args.data_dir, "terrain_detail.jpg"),
                              density=args.grass_density)
    except Exception as e:  # Blender のバージョン差で失敗しても、草なしで続ける
        print("[SEKIYADO] 草を作れませんでした（草なしで続けます）:", e)
    setup_render(args.out, args.engine, args.samples, args.width, args.height, shutter=args.shutter)

    if args.save_blend:
        path = os.path.abspath(args.save_blend)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=path)
        print("[SEKIYADO] 保存:", path)
    if args.render:
        bpy.ops.render.render(animation=True)
        print("[SEKIYADO] レンダリング完了:", os.path.abspath(args.out))


if __name__ == "__main__":
    main()
