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
  #   Blender 4.x では Mist・Normal を PNG 連番にも分けて書き出す）
  blender --background --python scripts/blender_import_flight.py -- \
    --data-dir ./assets/data --flight ./clip.json --out ./renders/clip01 \
    --engine CYCLES --samples 32 --width 1280 --height 720 --render

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
    mat.use_nodes = True
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
    build_grid_mesh("Terrain_Detail", detail["xmin"], detail["zmin"], detail["width"], detail["depth"],
                    detail["segx"], detail["segz"], lambda i, j, x, z: det[j * dnx + i],
                    os.path.join(data_dir, "terrain_detail.jpg"))

    far_path = os.path.join(data_dir, "far_dem.bin")
    if skip_far or not os.path.exists(far_path):
        return
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


# ---------------------------------------------------------------- 空と太陽

def setup_world_and_sun(env):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("SekiyadoWorld")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
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

def insert_motion(flight, show_plane=False):
    scene = bpy.context.scene
    fps = int(flight.get("fps", 60)) or 60
    frames = flight.get("frames", [])
    if not frames:
        raise SystemExit("frames が空です")
    scene.render.fps = fps
    scene.frame_start = 1
    scene.frame_end = 1 + int(math.ceil(float(flight.get("duration", frames[-1]["t"])) * fps))

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
        f = 1.0 + float(fr["t"]) * fps
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


# ---------------------------------------------------------------- レンダー設定

def setup_render(out_dir, engine, samples, width, height):
    scene = bpy.context.scene
    engines = enum_items(scene.render, "engine")
    if engine == "EEVEE":
        engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.render.engine = engine
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    if "AgX" in enum_items(scene.view_settings, "view_transform"):
        scene.view_settings.view_transform = "AgX"

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
                if any(d.type == dev for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = True
                    scene.cycles.device = "GPU"
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

    # すべてのパスを 1 枚に持つマルチレイヤー EXR（Blender のバージョンに依存しない）
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    scene.render.filepath = os.path.join(out_dir, "exr", "frame_")
    scene.render.image_settings.file_format = "OPEN_EXR_MULTILAYER"
    scene.render.image_settings.color_depth = "16"

    # Blender 4.x（旧コンポジター API）では Beauty・Mist・Normal を PNG 連番にも分けて書き出す
    if not hasattr(scene, "node_tree"):
        print("[SEKIYADO] このバージョンでは PNG の分割出力を省略（EXR に全パスが入っています）")
        return
    try:
        scene.use_nodes = True
        nt = scene.node_tree
        nt.nodes.clear()
        rl = nt.nodes.new("CompositorNodeRLayers")
        comp = nt.nodes.new("CompositorNodeComposite")
        nt.links.new(rl.outputs["Image"], comp.inputs["Image"])
        fout = nt.nodes.new("CompositorNodeOutputFile")
        fout.base_path = out_dir
        fout.format.file_format = "PNG"
        fout.file_slots.clear()
        for i, (slot, src) in enumerate((("beauty/frame_", "Image"), ("mist/frame_", "Mist"), ("normal/frame_", "Normal"))):
            fout.file_slots.new(slot)
            nt.links.new(rl.outputs[src], fout.inputs[i])
    except Exception as e:
        print("[SEKIYADO] PNG の分割出力を設定できませんでした（EXR は出力されます）:", e)


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
    ap.add_argument("--render", action="store_true")
    args = ap.parse_args(argv)

    with open(args.flight, encoding="utf-8") as f:
        flight = json.load(f)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    build_terrains(args.data_dir, skip_far=args.skip_far)
    setup_world_and_sun(flight.get("environment", {}))
    insert_motion(flight, show_plane=args.show_plane)
    setup_render(args.out, args.engine, args.samples, args.width, args.height)

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
