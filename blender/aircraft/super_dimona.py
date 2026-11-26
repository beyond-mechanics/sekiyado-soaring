"""HOAC/Diamond HK36TC Super Dimona（TC100、並列複座のモーターグライダー）を Blender で組み立て、glTF に書き出す。

  blender -b -P blender/aircraft/super_dimona.py -- --out assets/data/models [--blend out.blend] [--render out.png]

寸法は公開諸元（翼幅 16.3 m、全長 7.3 m、T 尾翼、低翼、前輪式）と部員の写真からの目測で、
メーカー図面の複製ではありません。登録記号は入れていません。
出力：super_dimona.glb（LOD0）・super_dimona_lod1.glb（LOD1）
動く部品：aileron_L/R・elevator・rudder・airbrake_L/R・wheel_main_L/R・wheel_nose・prop（ローカル Z＝回転軸）
目印：eye_left（左席の目）・panel（計器盤の中心）
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import common as C  # noqa: E402
from common import sim  # noqa: E402

V = Vector

# 胴体：z, 半幅, 上端, 下端（機首はエンジンカウル、操縦席は横幅が広い）
FUSE = [
    (-3.08, 0.205, 0.085, -0.235),
    (-3.00, 0.300, 0.150, -0.330),
    (-2.80, 0.430, 0.245, -0.440),
    (-2.45, 0.540, 0.330, -0.520),
    (-2.05, 0.595, 0.400, -0.560),
    (-1.65, 0.620, 0.640, -0.580),
    (-1.15, 0.625, 0.820, -0.580),
    (-0.65, 0.610, 0.800, -0.560),
    (-0.20, 0.560, 0.600, -0.510),
    (0.35, 0.455, 0.450, -0.420),
    (1.10, 0.300, 0.320, -0.270),
    (2.00, 0.175, 0.230, -0.110),
    (2.80, 0.115, 0.200, 0.000),
    (3.30, 0.085, 0.200, 0.060),
    (3.56, 0.020, 0.200, 0.110),
]
CANOPY = (-2.02, -0.12)
COWL_PAINT = -2.10                      # これより前はカウル（パネルの継ぎ目を黒い線で）
STRIPES = (1.62, 1.71, 1.745, 1.775)    # 胴体側面の赤い太線・細線（真上からの角度）
STRIPE_Z = (-2.55, 2.95)
WING = [
    {'x': 0.40, 'z': -0.72, 'c': 1.56, 'th': 0.165},
    {'x': 4.00, 'z': -0.60, 'c': 1.27, 'th': 0.155},
    {'x': 7.55, 'z': -0.30, 'c': 0.78, 'th': 0.145},
    {'x': 8.12, 'z': -0.22, 'c': 0.62, 'th': 0.14},
]
AIL = (4.40, 7.70, 0.76)
BRAKE = (1.75, 3.15, 0.47)
GEAR_MAIN = (1.06, -0.97, 0.14, 0.27, 0.14)   # x, y, z, 半径, 幅
GEAR_NOSE = (0.0, -1.04, -2.35, 0.21, 0.12)
PROP_Z, PROP_R = -3.16, 0.86


def dihedral(x):
    return -0.24 + 0.058 * x + 0.0012 * x * x


def fuse_at(z):
    rx, yt, yb = C.catmull(FUSE, z)
    return max(rx, 0.004), yt, yb


def fuse_point(z, a):
    rx, yt, yb = fuse_at(z)
    yc = yb + 0.46 * (yt - yb)
    c, s = math.cos(a), math.sin(a)
    e = 2.0 if s > 0 else 2.7
    x = rx * math.copysign(abs(c) ** (2 / e), c)
    y = yc + (yt - yc if s > 0 else yc - yb) * math.copysign(abs(s) ** (2 / e), s)
    return V((x, y, z))


def canopy_limit(z):
    zc, hl = (CANOPY[0] + CANOPY[1]) / 2, (CANOPY[1] - CANOPY[0]) / 2
    u = (z - zc) / hl
    if abs(u) >= 1:
        return 0.0
    p = 2.0 if u < 0 else 3.0
    return 1.30 * (1 - abs(u) ** p) ** (1 / p)


def materials():
    return {
        'white': C.principled('gelcoat_white', (0.86, 0.86, 0.83), rough=0.18, coat=0.6, coat_rough=0.05),
        'red': C.principled('stripe_red', (0.30, 0.035, 0.025), rough=0.25, coat=0.5),
        'glass': C.principled('canopy_glass', (0.02, 0.028, 0.034), rough=0.02, alpha=0.40),
        'frame': C.principled('canopy_frame', (0.02, 0.02, 0.022), rough=0.45),
        'seam': C.principled('panel_seam', (0.05, 0.05, 0.05), rough=0.6),
        'tire': C.principled('tire_rubber', (0.018, 0.018, 0.02), rough=0.9),
        'metal': C.principled('steel', (0.62, 0.63, 0.64), rough=0.3, metal=1.0),
        'alu': C.principled('airbrake_alu', (0.55, 0.56, 0.57), rough=0.35, metal=1.0),
        'dark': C.principled('intake_dark', (0.03, 0.03, 0.035), rough=0.7),
        'prop': C.principled('prop_white', (0.80, 0.80, 0.78), rough=0.3, coat=0.4),
        'tip': C.principled('prop_tip_red', (0.70, 0.04, 0.03), rough=0.35),
    }


def build_fuselage(M, kc, kb, rows):
    z0, z1 = FUSE[0][0], FUSE[-1][0]
    zs = [z0 + (z1 - z0) * (1 - math.cos(j / rows * math.pi)) / 2 for j in range(rows + 1)]
    n = rows // 2
    zs += [CANOPY[0] + (CANOPY[1] - CANOPY[0]) * (1 - math.cos(k / n * math.pi)) / 2 for k in range(n + 1)]
    zs += [COWL_PAINT, COWL_PAINT + 0.012, *STRIPE_Z]
    zs = sorted(set(round(z, 5) for z in zs))
    zs = [z for k, z in enumerate(zs) if k == 0 or z - zs[k - 1] > 0.003]
    mats = [M['white'], M['red'], M['glass'], M['frame'], M['seam']]

    def rule(z, phi, kind):
        if kind == 'glass':
            return 2
        if kind == 'frame':
            return 3
        if kind == 'cap':
            return 0
        if COWL_PAINT < z < COWL_PAINT + 0.012:
            return 4                              # カウルの継ぎ目
        if STRIPE_Z[0] < z < STRIPE_Z[1] and (STRIPES[0] < phi < STRIPES[1] or STRIPES[2] < phi < STRIPES[3]):
            return 1
        return 0
    return C.canopy_fuselage('fuselage', fuse_point, zs, canopy_limit, kc, kb, mats, rule, lines=STRIPES)


def wing_stations(side, x0, x1, n):
    st = []
    for k in range(n + 1):
        x = x0 + (x1 - x0) * k / n
        p = C.lerp_stations(WING, x)
        slope = 0.058 + 0.0024 * x
        up = V((-side * math.sin(math.atan(slope)), math.cos(math.atan(slope)), 0))
        st.append({'le': V((side * x, dihedral(x), p['z'])), 'c': p['c'], 'th': p['th'], 'camber': 0.035, 'up': up})
    return st


def upper_y(x, f):
    p = C.lerp_stations(WING, x)
    prof = C.airfoil(p['th'], 0.035, 48)[:49]
    y = min(prof, key=lambda q: abs(q[0] - f))[1]
    return dihedral(x) + y * p['c'], p['z'] + f * p['c']


def build_wing(M, side, m, nspan):
    s = 'R' if side > 0 else 'L'
    w = [M['white']]
    a0, a1, hf = AIL
    parts = [C.loft_airfoil(f'wing_inner_{s}', wing_stations(side, WING[0]['x'], a0, max(2, nspan // 2)), mats=w, m=m),
             C.loft_airfoil(f'wing_outer_{s}', wing_stations(side, a0, a1, max(2, nspan // 3)), mats=w, m=m, f1=hf),
             C.loft_airfoil(f'wing_tip_{s}', wing_stations(side, a1, WING[-1]['x'], 2), mats=w, m=m)]
    st = wing_stations(side, a0 + 0.01, a1 - 0.01, max(2, nspan // 3))
    ha = st[0]['le'] + V((0, 0, hf * st[0]['c'])); hb = st[-1]['le'] + V((0, 0, hf * st[-1]['c']))
    ail = C.loft_airfoil(f'aileron_{s}', st, mats=w, m=max(6, m // 2), f0=hf)
    a, b = (ha, hb) if side > 0 else (hb, ha)
    C.place_hinged(ail, (ha + hb) / 2, C.hinge_frame(a, b))
    ail['control'] = 'aileron'; ail['side'] = side
    parts.append(ail)
    # 小さなウイングレット
    tip = WING[-1]
    base = V((side * tip['x'], dihedral(tip['x']), tip['z']))
    cant = 0.30
    wl = [{'le': base + V((side * math.sin(cant) * h, math.cos(cant) * h + 0.01, dz)), 'c': c, 'th': 0.10, 'up': V((side, 0, 0))}
          for h, c, dz in ((0.0, 0.60, 0.0), (0.18, 0.42, 0.14), (0.36, 0.26, 0.30))]
    parts.append(C.loft_airfoil(f'winglet_{s}', wl, mats=w, m=max(6, m // 2)))
    for p in parts:
        C.set_auto_smooth(p, 40)
    return parts


def build_airbrake(M, side, detail):
    s = 'R' if side > 0 else 'L'
    x0, x1, f = BRAKE
    y0, z0 = upper_y(x0, f); y1, z1 = upper_y(x1, f)
    a, b = V((side * x0, y0, z0)), V((side * x1, y1, z1))
    length = (b - a).length
    root = bpy.data.objects.new(f'airbrake_{s}', None)
    root.empty_display_type = 'SINGLE_ARROW'; root.empty_display_size = 0.2
    pa, pb = (a, b) if side > 0 else (b, a)
    root.matrix_world = Matrix.Translation(sim(*((a + b) / 2 + V((0, 0.003, 0))))) @ C.hinge_frame(pa, pb)
    cap = C.box(f'airbrake_cap_{s}', length, 0.012, 0.07, M['white'])
    plate = C.box(f'airbrake_plate_{s}', length - 0.03, 0.12, 0.014, M['alu'])
    plate.location = sim(0, -0.066, 0)
    out = [root, cap, plate]
    if detail:
        # Schempp-Hirth 式：2 枚の板が少し前後にずれて立つ
        plate2 = C.box(f'airbrake_plate2_{s}', length - 0.03, 0.12, 0.010, M['alu'])
        plate2.location = sim(0, -0.066, 0.045)
        slot = C.box(f'airbrake_slot_{s}', length + 0.01, 0.004, 0.08, M['dark'])
        slot.location = sim(0, -0.006, 0)
        out += [plate2, slot]
    for o in out[1:]:
        o.parent = root
    root['control'] = 'airbrake'; root['travel'] = 0.13; root['side'] = side
    return out


def build_tail(M, m):
    w = [M['white']]
    ux = V((1, 0, 0))
    fin = [{'le': V((0, 0.05, 2.42)), 'c': 1.08, 'th': 0.11, 'up': ux},
           {'le': V((0, 0.80, 2.70)), 'c': 0.82, 'th': 0.11, 'up': ux},
           {'le': V((0, 1.50, 2.98)), 'c': 0.58, 'th': 0.11, 'up': ux}]
    hf = 0.68
    parts = [C.loft_airfoil('fin', fin, mats=w, m=m, f1=hf)]
    ha = fin[0]['le'] + V((0, 0, hf * fin[0]['c'])); hb = fin[-1]['le'] + V((0, 0, hf * fin[-1]['c']))
    rud = C.loft_airfoil('rudder', [dict(fin[0], le=fin[0]['le'] + V((0, 0.06, 0))), fin[1], dict(fin[2], le=fin[2]['le'] - V((0, 0.02, 0)))],
                         mats=w, m=max(6, m // 2), f0=hf)
    ya = (sim(*hb) - sim(*ha)).normalized(); xa = sim(1, 0, 0) - sim(0, 0, 0)
    za = xa.cross(ya).normalized(); xa = ya.cross(za).normalized()
    C.place_hinged(rud, ha, Matrix((xa, ya, za)).transposed().to_4x4())
    rud['control'] = 'rudder'
    parts.append(rud)
    ys = 1.545
    stab = lambda side: [{'le': V((0.0, ys, 2.92)), 'c': 0.64, 'th': 0.10}, {'le': V((side * 1.68, ys + 0.01, 3.07)), 'c': 0.42, 'th': 0.09}]
    ef = 0.62
    for side in (-1, 1):
        parts.append(C.loft_airfoil('stab_' + ('R' if side > 0 else 'L'), stab(side), mats=w, m=m, f1=ef))
    est = stab(-1)[::-1] + stab(1)[1:]
    eh = V((0, ys, 2.92 + ef * 0.64))
    elev = C.loft_airfoil('elevator', est, mats=w, m=max(6, m // 2), f0=ef)
    C.place_hinged(elev, eh, C.hinge_frame(V((-1, ys, eh.z)), V((1, ys, eh.z))))
    elev['control'] = 'elevator'
    parts.append(elev)
    rows = []
    for k in range(13):
        z = 2.86 + 0.80 * k / 12
        r = 0.06 * math.sin(math.pi * min(1, (k / 12) * 1.15 + 0.02)) ** 0.6 + 0.004
        rows.append([sim(r * math.cos(t * math.pi / 8), ys + 0.005 + r * 0.8 * math.sin(t * math.pi / 8), z) for t in range(16)])
    parts.append(C.grid_mesh('tail_bullet', rows, mats=w, cap_ends=True))
    for p in parts:
        if p.type == 'MESH':
            C.set_auto_smooth(p, 40)
    return parts


def build_gear(M, detail):
    gx, gy, gz, r, wd = GEAR_MAIN
    parts = []
    for side in (-1, 1):
        s = 'R' if side > 0 else 'L'
        parts += C.wheel(f'wheel_main_{s}', V((side * gx, gy, gz)), r, wd, M, 28 if detail else 12, 10 if detail else 6)
        # ばね鋼の脚：胴体下面から車軸まで弓なりに
        _, _, yb = fuse_at(gz)
        pts = [V((side * (0.30 + 0.75 * t), yb + 0.04 - (gy - yb + 0.04) * -(t ** 1.25), gz)) for t in (0, 0.25, 0.5, 0.75, 1.0)]
        pts[-1] = V((side * (gx - wd * 0.55), gy, gz))
        parts.append(C.tube(f'gear_leg_{s}', pts, 0.035 if detail else 0.04, 8 if detail else 5, M['white']))
    nx, ny, nz, nr, nw = GEAR_NOSE
    parts += C.wheel('wheel_nose', V((nx, ny, nz)), nr, nw, M, 24 if detail else 10, 10 if detail else 6)
    _, _, ybn = fuse_at(nz)
    for side in (-1, 1):   # 前輪のフォーク
        parts.append(C.tube(f'nose_fork_{"R" if side > 0 else "L"}', [V((side * 0.08, ybn + 0.05, nz - 0.05)), V((side * 0.08, ny, nz))], 0.022, 8, M['metal']))
    return parts


def build_nose(M, detail):
    """スピナー（固定）とプロペラ（ノード prop、ローカル Z が回転軸）、吸気口と排気管。"""
    parts = []
    rows = []
    for k in range(13):
        t = k / 12
        z = PROP_Z - 0.36 * (1 - t)
        r = 0.185 * t ** 0.72 * (1.0 - 0.08 * t)          # 先の尖ったスピナー
        rows.append([sim(r * math.cos(a * math.pi / 12), r * math.sin(a * math.pi / 12), z) for a in range(24)])
    rows.append([sim(0.205 * math.cos(a * math.pi / 12), 0.205 * math.sin(a * math.pi / 12), PROP_Z + 0.08) for a in range(24)])
    sp = C.grid_mesh('spinner', rows, mats=[M['prop']], cap_ends=True)
    parts.append(sp)
    prop = bpy.data.objects.new('prop', None)
    prop.empty_display_type = 'CIRCLE'; prop.empty_display_size = PROP_R
    prop.location = sim(0, 0, PROP_Z + 0.02)
    # 空ノードのまま Blender の Y 軸（=シムの -Z）回りに回すと、glTF でローカル Z が軸になる
    prop['control'] = 'prop'
    parts.append(prop)
    m = 14 if detail else 6
    for k, ang in enumerate((math.pi / 2, -math.pi / 2)):
        st = []
        for r, c, tw in ((0.20, 0.13, 0.55), (0.45, 0.12, 0.35), (0.74, 0.095, 0.22), (PROP_R, 0.06, 0.16)):
            st.append({'le': V((r, 0, -c * 0.35)), 'c': c, 'th': 0.12, 'camber': 0.03, 'up': V((0, math.cos(tw), math.sin(tw))),
                       'cdir': V((0, -math.sin(tw), math.cos(tw)))})
        blade = C.loft_airfoil(f'prop_blade_{k}', st, mats=[M['prop'], M['tip']], m=m,
                               face_mat=lambda j, i, c: 1 if Vector((c.x, -c.y, c.z)).length > 0.0 and abs(c.x) > 0.74 else 0)
        blade.data.transform(Matrix.Rotation(ang - math.pi / 2, 4, 'Y'))   # 2 枚目は 180° 反対側
        blade.parent = prop
        parts.append(blade)
    if detail:
        # カウル下の吸気口と排気管
        intake = C.box('cowl_intake', 0.30, 0.07, 0.10, M['dark'], bevel=0.02)
        _, _, yb = fuse_at(-2.95)
        intake.location = sim(0, yb + 0.06, -2.95)
        parts.append(intake)
        _, _, yb2 = fuse_at(-2.2)
        parts.append(C.tube('exhaust', [V((0.12, yb2 + 0.05, -2.5)), V((0.14, yb2 - 0.02, -2.25)), V((0.15, yb2 - 0.03, -2.05))], 0.03, 10, M['metal']))
    return parts


def build_decals(M, fuselage):
    out = []
    for side in (-1, 1):
        for text, size, z, y in (('TC100 DIMONA', 0.15, -0.55, -0.02), ('SUPER', 0.075, 0.55, 0.06)):
            bpy.ops.object.text_add()
            t = bpy.context.object
            t.data.body = text; t.data.size = size; t.data.shear = 0.18; t.data.align_x = 'CENTER'
            try:
                t.data.font = bpy.data.fonts.load('<builtin>')
            except Exception:
                pass
            bpy.ops.object.convert(target='MESH')
            t = bpy.context.object
            t.name = f'decal_{text.split()[0].lower()}_' + ('R' if side > 0 else 'L')
            t.data.materials.clear(); t.data.materials.append(M['red'])
            rx, _, _ = fuse_at(z)
            rot = Matrix.Rotation(math.pi / 2 if side > 0 else -math.pi / 2, 4, 'Z') @ Matrix.Rotation(math.pi / 2, 4, 'X')
            t.matrix_world = Matrix.Translation(sim(side * (rx + 0.03), y, z)) @ rot
            sw = t.modifiers.new('onto_fuselage', 'SHRINKWRAP')
            sw.target = fuselage; sw.wrap_method = 'NEAREST_SURFACEPOINT'; sw.offset = 0.0025
            out.append(t)
    return out


def build(detail=True):
    M = materials()
    col = C.collection('SuperDimona_' + ('LOD0' if detail else 'LOD1'))
    root = bpy.data.objects.new('SuperDimona' + ('' if detail else '_lod1'), None)
    root.empty_display_type = 'ARROWS'
    col.objects.link(root)
    kc, kb, rows, m, nspan = (12, 28, 80, 22, 24) if detail else (4, 12, 28, 9, 8)
    fuse = build_fuselage(M, kc, kb, rows)
    objs = [fuse]
    for side in (-1, 1):
        objs += build_wing(M, side, m, nspan)
        objs += build_airbrake(M, side, detail)
    objs += build_tail(M, m)
    objs += build_gear(M, detail)
    objs += build_nose(M, detail)
    for o in objs:
        if o.name not in col.objects:
            col.objects.link(o)
        if o.parent is None:
            o.parent = root
    if detail:
        for d in build_decals(M, fuse):
            for c in d.users_collection:
                c.objects.unlink(d)
            col.objects.link(d); d.parent = root
    for name, p in (('eye_left', V((-0.30, 0.66, -0.90))), ('panel', V((0, 0.47, -1.50)))):
        e = bpy.data.objects.new(name, None); e.location = sim(*p); e.parent = root; col.objects.link(e)
    root['source'] = 'blender/aircraft/super_dimona.py'
    root['span_m'] = 2 * WING[-1]['x']
    return root, col


def main(argv):
    import argparse
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from duo_discus_t import render_preview
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='assets/data/models')
    ap.add_argument('--blend', default=None)
    ap.add_argument('--render', default=None)
    ap.add_argument('--views', default='front34,side,nose,rear34')
    ap.add_argument('--samples', type=int, default=96)
    a = ap.parse_args(argv)
    C.reset_scene()
    r0, c0 = build(True)
    r1, c1 = build(False)
    for o in c1.objects:
        o.name = o.name.split('.')[0].replace('_lod1', '') + '_LOD1'
    os.makedirs(a.out, exist_ok=True)
    C.export_glb(os.path.join(a.out, 'super_dimona.glb'), [r0])
    C.export_glb(os.path.join(a.out, 'super_dimona_lod1.glb'), [r1])
    print(f'[super_dimona] LOD0 {C.triangle_count([r0]):,} tris, LOD1 {C.triangle_count([r1]):,} tris')
    if a.blend:
        c1.hide_render = True; c1.hide_viewport = True
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.blend))
    if a.render:
        c1.hide_render = True
        for p in render_preview(a.render, r0, tuple(a.views.split(',')), samples=a.samples, ground_z=-1.24):
            print('[super_dimona] render', p)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    main(argv)
