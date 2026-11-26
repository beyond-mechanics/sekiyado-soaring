"""Blender で機体・小物を組み立てるときの共通部品。

座標は「シム座標」で書きます：右 +x、上 +y、後ろ +z（機首は -z）。単位はメートル。
Blender（Z が上、-Y が手前）へは sim() で変換します。glTF に Y-up で書き出すと
シム座標のまま three.js / UE5 に入ります（UE5 側は読み込み時に自動で軸変換）。
"""
import math
import bmesh
import bpy
from mathutils import Matrix, Vector


def sim(x, y, z):
    """シム座標 → Blender 座標（glTF の Y-up 書き出しで元に戻る）。"""
    return Vector((x, -z, y))


# ---------- シーン ----------
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.unit_settings.system = 'METRIC'
    return s


def collection(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(c)
    return c


# ---------- 補間 ----------
def catmull(points, t):
    """points: [(t, value...)] を t で滑らかに補間（Catmull-Rom、端は折り返し）。"""
    ts = [p[0] for p in points]
    if t <= ts[0]:
        return list(points[0][1:])
    if t >= ts[-1]:
        return list(points[-1][1:])
    i = max(k for k in range(len(ts) - 1) if ts[k] <= t)
    p0 = points[max(i - 1, 0)][1:]
    p1, p2 = points[i][1:], points[i + 1][1:]
    p3 = points[min(i + 2, len(points) - 1)][1:]
    u = (t - ts[i]) / (ts[i + 1] - ts[i])
    out = []
    for a, b, c, d in zip(p0, p1, p2, p3):
        # 単調性を崩しにくいよう、接線は弱め（張力 0.5 の半分）
        m1, m2 = (c - a) * 0.25, (d - b) * 0.25
        h00, h10, h01, h11 = 2*u**3 - 3*u**2 + 1, u**3 - 2*u**2 + u, -2*u**3 + 3*u**2, u**3 - u**2
        out.append(h00 * b + h10 * m1 * 2 + h01 * c + h11 * m2 * 2)
    return out


def lerp_stations(stations, t, key='x'):
    """翼の平面形（直線テーパー）を key 方向に線形補間。"""
    for a, b in zip(stations, stations[1:]):
        if a[key] <= t <= b[key]:
            u = (t - a[key]) / (b[key] - a[key])
            return {k: a[k] + (b[k] - a[k]) * u for k in a}
    return dict(stations[-1] if t > stations[-1][key] else stations[0])


# ---------- メッシュ生成 ----------
def grid_mesh(name, rows, closed_u=True, cap_ends=False, mats=None, face_mat=None, smooth=True):
    """rows: [[Vector, ...], ...]（各行が 1 断面）。四角形でつないでメッシュにする。
    face_mat(row_index, col_index, center) -> マテリアル番号。"""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in row] for row in rows]
    n = len(rows[0])
    cols = n if closed_u else n - 1
    for j in range(len(rows) - 1):
        for i in range(cols):
            a, b = vs[j][i], vs[j][(i + 1) % n]
            c, d = vs[j + 1][(i + 1) % n], vs[j + 1][i]
            if a == b or c == d:
                continue
            try:
                f = bm.faces.new((a, b, c, d))
            except ValueError:
                continue
            if face_mat:
                f.material_index = face_mat(j, i, (a.co + b.co + c.co + d.co) / 4)
    if cap_ends:
        for row in (vs[0], vs[-1]):
            try:
                f = bm.faces.new(row if row is vs[-1] else list(reversed(row)))
                if face_mat:
                    f.material_index = face_mat(-1, -1, sum((v.co for v in row), Vector()) / len(row))
            except ValueError:
                pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    ob = bpy.data.objects.new(name, me)
    for m in mats or []:
        me.materials.append(m)
    return ob


def airfoil(th, camber, m=24, f0=0.0, f1=1.0, pos=0.4):
    """NACA 4 桁型の翼型。上面（後縁→前縁）→下面（前縁→後縁）の順に (f, y) を返す（翼弦で正規化）。"""
    def yt(f):
        return 5 * th * (0.2969 * math.sqrt(max(f, 0)) - 0.126 * f - 0.3516 * f**2 + 0.2843 * f**3 - 0.1036 * f**4)

    def yc(f):
        if camber == 0:
            return 0.0
        return camber * ((2 * pos * f - f * f) / pos**2 if f < pos else ((1 - 2 * pos) + 2 * pos * f - f * f) / (1 - pos)**2)
    fs = [f0 + (f1 - f0) * (1 - math.cos(i / m * math.pi)) / 2 for i in range(m + 1)]
    upper = [(f, yc(f) + yt(f)) for f in reversed(fs)]
    lower = [(f, yc(f) - yt(f)) for f in fs[1:-1]]
    return upper + lower


def loft_airfoil(name, stations, mats=None, m=24, f0=0.0, f1=1.0, cap=True, origin=None, smooth=True, face_mat=None):
    """stations: [{'le': Vector(sim), 'c': 翼弦, 'th': 厚さ比, 'camber': 反り, 'up': Vector(sim、厚さ方向)}]
    翼弦方向はシムの +z（後ろ向き）。origin(sim) を与えると、その点を物体の原点にする。"""
    rows = []
    for st in stations:
        prof = airfoil(st['th'], st.get('camber', 0.0), m, f0, f1)
        up = st.get('up', Vector((0, 1, 0)))
        cdir = st.get('cdir', Vector((0, 0, 1)))
        row = []
        for f, y in prof:
            p = st['le'] + cdir * (f * st['c']) + up * (y * st['c'])
            if origin is not None:
                p = p - origin
            row.append(sim(*p))
        rows.append(row)
    ob = grid_mesh(name, rows, closed_u=True, cap_ends=cap, mats=mats, smooth=smooth, face_mat=face_mat)
    if origin is not None:
        ob.location = sim(*origin)
    return ob


def set_auto_smooth(ob, angle_deg=35):
    """硬いエッジ（後縁など）を保ちつつ滑らかに。Blender 4.1 以降は修正子、それ以前は auto smooth。"""
    me = ob.data
    if hasattr(me, 'use_auto_smooth'):
        me.use_auto_smooth = True
        me.auto_smooth_angle = math.radians(angle_deg)
        return
    try:
        mod = ob.modifiers.new('Smooth by Angle', 'NODES')
        ng = bpy.data.node_groups.get('Smooth by Angle')
        if ng is None:
            # 4.1+ に同梱の資産を使わず、エッジ分割で同じ見た目にする
            ob.modifiers.remove(mod)
            es = ob.modifiers.new('EdgeSplit', 'EDGE_SPLIT')
            es.split_angle = math.radians(angle_deg)
            es.use_edge_sharp = True
        else:
            mod.node_group = ng
    except Exception:
        es = ob.modifiers.new('EdgeSplit', 'EDGE_SPLIT')
        es.split_angle = math.radians(angle_deg)


def cylinder(name, r, length, segments=24, mat=None, axis='x'):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=r, radius2=r, depth=length)
    rot = {'x': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'y': Matrix(), 'z': Matrix.Rotation(math.pi / 2, 4, 'X')}[axis]
    bmesh.ops.transform(bm, matrix=rot, verts=bm.verts)
    bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    if mat:
        me.materials.append(mat)
    return ob


def torus(name, R, r, seg=32, ring=12, mat=None):
    """車輪のタイヤ。軸はシムの x（Blender の x）。"""
    rows = []
    for j in range(seg + 1):
        a = j / seg * 2 * math.pi
        row = []
        for i in range(ring):
            b = i / ring * 2 * math.pi
            rr = R + r * math.cos(b)
            row.append(Vector((r * math.sin(b), rr * math.cos(a), rr * math.sin(a))))
        rows.append(row)
    ob = grid_mesh(name, rows, closed_u=True, mats=[mat] if mat else None)
    return ob


def box(name, sx, sy, sz, mat=None, bevel=0.0):
    """シム座標で幅 sx・高さ sy・長さ sz の箱（原点は中心）。"""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((sx, sz, sy)), verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:] + bm.verts[:], offset=bevel, segments=2, affect='EDGES')
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    if mat:
        me.materials.append(mat)
    return ob


def tube(name, pts, r, seg=10, mat=None):
    """シム座標の折れ線 pts に沿った細い管（TE プローブ、ピトー管など）。"""
    rows = []
    for k, p in enumerate(pts):
        a = pts[max(k - 1, 0)]; b = pts[min(k + 1, len(pts) - 1)]
        t = (b - a).normalized()
        n = t.cross(Vector((0, 1, 0)))
        if n.length < 1e-3:
            n = t.cross(Vector((1, 0, 0)))
        n.normalize(); bn = t.cross(n)
        rows.append([sim(*(p + (n * math.cos(i / seg * 2 * math.pi) + bn * math.sin(i / seg * 2 * math.pi)) * r)) for i in range(seg)])
    return grid_mesh(name, rows, closed_u=True, cap_ends=True, mats=[mat] if mat else None)


# ---------- マテリアル（glTF の metallic-roughness にそのまま載る範囲だけ使う） ----------
def principled(name, color, rough=0.5, metal=0.0, coat=0.0, coat_rough=0.05, alpha=1.0, emission=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1.0)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    for key in ('Coat Weight', 'Clearcoat'):
        if key in b.inputs:
            b.inputs[key].default_value = coat
            break
    for key in ('Coat Roughness', 'Clearcoat Roughness'):
        if key in b.inputs:
            b.inputs[key].default_value = coat_rough
            break
    if alpha < 1.0:
        b.inputs['Alpha'].default_value = alpha
        if hasattr(m, 'blend_method'):            # 4.2 では非推奨、5.x では無いことがある
            try:
                m.blend_method = 'BLEND'
            except Exception:
                pass
        if hasattr(m, 'surface_render_method'):
            m.surface_render_method = 'BLENDED'
        m.use_backface_culling = False
    m.diffuse_color = (*color, alpha)
    return m


# ---------- 書き出し ----------
def export_glb(path, objects):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
        for c in o.children_recursive:
            c.select_set(True)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
              export_extras=True, export_cameras=False, export_lights=False, export_texcoords=True, export_normals=True)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError:
        kw.pop('export_lights'); bpy.ops.export_scene.gltf(**kw)


def triangle_count(objects):
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in objects:
        for ob in [o, *o.children_recursive]:
            if ob.type == 'MESH':
                me = ob.evaluated_get(dg).to_mesh()
                me.calc_loop_triangles(); n += len(me.loop_triangles)
                ob.evaluated_get(dg).to_mesh_clear()
    return n


# ---------- 機体で共通に使う部品（Super Dimona 以降。Duo Discus T のスクリプトは同じ考え方の旧版） ----------
def hinge_frame(a, b, up=Vector((0, 1, 0))):
    """シム座標のヒンジ線 a→b を Blender の回転行列に（ローカル X＝ヒンジ方向）。"""
    xa = (sim(*b) - sim(*a)).normalized()
    zb = sim(*up) - sim(0, 0, 0)
    ya = zb.cross(xa).normalized()
    za = xa.cross(ya).normalized()
    return Matrix((xa, ya, za)).transposed().to_4x4()


def place_hinged(ob, origin_sim, rot):
    """メッシュを「原点＝ヒンジ・ローカル軸＝ヒンジ」に付け替える。"""
    inv = (Matrix.Translation(sim(*origin_sim)) @ rot).inverted()
    ob.data.transform(inv)
    ob.matrix_world = Matrix.Translation(sim(*origin_sim)) @ rot
    return ob


def wheel(name, center, r, width, mats, seg=28, ring=10, hub_r=0.46):
    """タイヤ（トーラス）とハブ。原点＝車軸の中心、ローカル X＝車軸。"""
    w = torus(name, r * 0.72, r * 0.28, seg, ring, mats['tire'])
    w.location = sim(*center)
    hub = cylinder(name + '_hub', r * hub_r, width * 0.9, max(8, seg // 2), mats['metal'], axis='x')
    hub.parent = w
    w['control'] = 'wheel'
    return [w, hub]


def canopy_fuselage(name, section, z_list, canopy, kc, kb, mats, face_rule, lines=()):
    """キャノピーの縁や塗り分けの線がメッシュの辺に一致する胴体。
    section(z, a) -> Vector(sim)：断面の角度 a（0=右、π/2=上）の点
    canopy(z) -> 真上から左右へのキャノピー（枠込み）の広がり [rad]、外では 0
    face_rule(z, phi, kind) -> マテリアル番号。phi は真上からの角度、kind は 'glass'/'frame'/'body'
    kc / kb：片側のガラス／胴体の分割数。z_list：断面の位置（塗り分けの境目を含めておく）。
    lines：胴体の帯（ストライプ）の境目の角度 phi。必ず頂点の列が通るので、帯の縁がギザギザにならない。"""
    grid = []
    frame_w = 0.07
    phis_all = []
    for z in z_list:
        lim = canopy(z)
        glass = max(lim - frame_w, 0.0)
        eps = 0.002
        phis = [max(glass * k / kc, eps * k) for k in range(kc + 1)]
        phis.append(max(lim, phis[-1] + eps))
        p0 = phis[-1]
        if lines:
            # 帯の境目は毎断面で同じ番号の頂点にする（番号がずれると面がねじれて縁がギザギザになる）
            ls = sorted(lines)
            n_mid = len(ls) - 1
            n_first = max(1, round((ls[0]) / math.pi * (kb - n_mid)))
            n_last = max(1, kb - n_mid - n_first)
            a0 = min(p0, ls[0] - 0.02)
            phis[-1] = a0 if a0 < p0 else p0
            body = [phis[-1] + (ls[0] - phis[-1]) * k / n_first for k in range(1, n_first + 1)]
            body += ls[1:]
            body += [ls[-1] + (math.pi - ls[-1]) * k / n_last for k in range(1, n_last + 1)]
            phis += body
        else:
            phis += [p0 + (math.pi - p0) * k / kb for k in range(1, kb + 1)]
        ring = [math.pi / 2 - f for f in phis] + [math.pi / 2 + f for f in reversed(phis[1:-1])]
        grid.append([sim(*section(z, a)) for a in ring])
        phis_all.append(phis)
    half = kc + 1 + kb

    def face_mat(j, i, cb):
        z = -cb.y
        if j < 0:
            return face_rule(z, math.pi / 2, 'cap')
        k = i if i < half else (2 * half - 1 - i)
        phi = (phis_all[j][k] + phis_all[j][k + 1]) / 2
        kind = 'glass' if k < kc else ('frame' if k == kc else 'body')
        if kind != 'body' and canopy(z) <= 0:
            kind = 'body'
        elif kind == 'glass' and canopy(z) <= frame_w:
            kind = 'frame'
        return face_rule(z, phi, kind)
    return grid_mesh(name, grid, closed_u=True, cap_ends=True, mats=mats, face_mat=face_mat)



def run_object_script(argv, build, name, ground_z=0.0, views='front34,side'):
    """小物スクリプトの共通の main：LOD0/LOD1 を作り、glb・blend・プレビューを書き出す。
    build(detail: bool) -> (root, collection)。"""
    import argparse
    import os
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='assets/data/models')
    ap.add_argument('--blend', default=None)
    ap.add_argument('--render', default=None)
    ap.add_argument('--views', default=views)
    ap.add_argument('--samples', type=int, default=64)
    a = ap.parse_args(argv)
    reset_scene()
    r0, c0 = build(True)
    r1, c1 = build(False)
    for o in c1.objects:
        o.name = o.name.split('.')[0].replace('_lod1', '') + '_LOD1'
    os.makedirs(a.out, exist_ok=True)
    export_glb(os.path.join(a.out, f'{name}.glb'), [r0])
    export_glb(os.path.join(a.out, f'{name}_lod1.glb'), [r1])
    print(f'[{name}] LOD0 {triangle_count([r0]):,} tris, LOD1 {triangle_count([r1]):,} tris')
    if a.blend:
        c1.hide_render = True; c1.hide_viewport = True
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.blend))
    if a.render:
        c1.hide_render = True
        for p in render_props(a.render, tuple(a.views.split(',')), a.samples, ground_z):
            print(f'[{name}] render', p)


def render_props(path, views, samples, ground_z=0.0, res=(1600, 900)):
    """小物用のプレビュー（被写体の大きさに合わせてカメラを引く）。"""
    s = bpy.context.scene
    s.render.engine = 'CYCLES'; s.cycles.device = 'CPU'; s.cycles.samples = samples
    try:
        s.cycles.use_denoising = True
    except Exception:
        pass
    s.render.resolution_x, s.render.resolution_y = res
    s.view_settings.exposure = -0.9
    w = bpy.data.worlds.new('sky'); s.world = w; w.use_nodes = True
    nt = w.node_tree; bg = nt.nodes['Background']
    sky = nt.nodes.new('ShaderNodeTexSky')
    try:
        sky.sky_type = 'NISHITA'; sky.sun_elevation = math.radians(38); sky.sun_rotation = math.radians(210)
    except Exception:
        pass
    nt.links.new(sky.outputs['Color'], bg.inputs['Color']); bg.inputs['Strength'].default_value = 0.35
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); s.collection.objects.link(sun)
    sun.data.energy = 4.0; sun.rotation_euler = (math.radians(52), 0, math.radians(30))
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, ground_z))
    bpy.context.object.data.materials.append(principled('ground', (0.09, 0.12, 0.06), rough=0.95))
    # 表示中の LOD0 の外接箱
    bpy.context.view_layer.update()
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for o in s.objects:
        if o.type == 'MESH' and o.name != 'Plane' and not o.name.endswith('_LOD1') and all(not c.hide_render for c in o.users_collection):
            for c in o.bound_box:
                p = o.matrix_world @ Vector(c)
                lo = Vector(map(min, lo, p)); hi = Vector(map(max, hi, p))
    ctr, size = (lo + hi) / 2, (hi - lo).length
    print('[preview] bbox', tuple(round(v, 2) for v in lo), tuple(round(v, 2) for v in hi))
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); s.collection.objects.link(cam); s.camera = cam
    cam.data.lens = 40
    dirs = {'front34': Vector((-0.75, 1.0, 0.35)), 'side': Vector((-1, 0.05, 0.12)), 'rear34': Vector((0.8, -1.0, 0.45)), 'top': Vector((0.05, 0.1, 1))}
    out = []
    for v in views:
        d = dirs[v].normalized()
        cam.location = ctr + d * size * 1.9
        cam.rotation_euler = (ctr - cam.location).to_track_quat('-Z', 'Y').to_euler()
        p = path.replace('.png', f'_{v}.png') if len(views) > 1 else path
        s.render.filepath = p
        bpy.ops.render.render(write_still=True)
        out.append(p)
    return out
