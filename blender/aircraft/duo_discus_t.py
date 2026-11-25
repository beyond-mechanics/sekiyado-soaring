"""Schempp-Hirth Duo Discus T（複座グライダー）を Blender で組み立て、glTF に書き出す。

  blender -b -P blender/aircraft/duo_discus_t.py -- --out assets/data/models [--blend out.blend] [--render out.png]
  （bpy モジュールでも可：python blender/aircraft/duo_discus_t.py --out ...）

寸法は公開されている諸元（翼幅 20 m、全長 8.6 m、T 尾翼、タンデム複座）と部員の写真からの目測で、
メーカー図面の複製ではありません。登録記号は入れていません。
出力：
  duo_discus_t.glb       … LOD0（近く・コックピット用）
  duo_discus_t_lod1.glb  … LOD1（遠景・内蔵 GPU のノート PC 用）
動く部品は名前つきのノードで、原点がヒンジ上、ローカル X（方向舵はローカル Y）がヒンジ軸です：
  aileron_L / aileron_R / elevator / rudder / airbrake_L / airbrake_R / wheel_main / wheel_nose / wheel_tail
目印の空ノード：eye_front（前席の目の位置）/ panel（計器盤の取り付け位置）/ tow_hook
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

# ---------------- 形の定義（シム座標：右 +x・上 +y・後ろ +z） ----------------
# 胴体：z, 半幅, 上端, 下端
FUSE = [
    (-4.08, 0.010, -0.02, -0.06),
    (-4.00, 0.105, 0.040, -0.150),
    (-3.85, 0.185, 0.115, -0.255),
    (-3.60, 0.255, 0.200, -0.345),
    (-3.30, 0.300, 0.300, -0.410),
    (-2.95, 0.330, 0.500, -0.445),
    (-2.45, 0.345, 0.630, -0.465),
    (-1.95, 0.350, 0.655, -0.470),
    (-1.50, 0.345, 0.590, -0.465),
    (-1.10, 0.335, 0.440, -0.450),
    (-0.70, 0.320, 0.330, -0.425),
    (-0.20, 0.295, 0.295, -0.385),
    (0.40, 0.235, 0.255, -0.300),
    (1.20, 0.160, 0.200, -0.180),
    (2.20, 0.105, 0.165, -0.070),
    (3.20, 0.080, 0.165, 0.000),
    (3.90, 0.070, 0.180, 0.035),
    (4.35, 0.055, 0.200, 0.075),
    (4.58, 0.012, 0.205, 0.120),
]
CANOPY = (-3.36, -1.10)          # キャノピーの前端・後端（z）
WING_LE = [  # 翼の平面形（半翼）。後縁がほぼ直線で、外翼の前縁が後退する Discus 系の形
    {'x': 0.10, 'z': -0.63, 'c': 1.08, 'th': 0.160},
    {'x': 3.00, 'z': -0.57, 'c': 1.00, 'th': 0.150},
    {'x': 6.40, 'z': -0.41, 'c': 0.77, 'th': 0.140},
    {'x': 8.80, 'z': -0.22, 'c': 0.53, 'th': 0.135},
    {'x': 9.72, 'z': -0.09, 'c': 0.36, 'th': 0.130},
    {'x': 9.96, 'z': -0.01, 'c': 0.25, 'th': 0.130},
]
AIL = (6.05, 9.55, 0.78)          # 補助翼：内端・外端・ヒンジ位置（翼弦比）
BRAKE = (3.30, 4.80, 0.50)        # エアブレーキ：内端・外端・翼弦比
WHEEL_MAIN = (V((0, -0.76, -0.30)), 0.19, 0.12)


def dihedral(x):
    """上反角に、飛行中のたわみ（写真で翼端がはっきり上がる）を少し足した翼の高さ。"""
    return 0.14 + 0.030 * x + 0.0034 * x * x


def fuse_at(z):
    rx, yt, yb = C.catmull(FUSE, z)
    return max(rx, 0.004), yt, yb


def fuse_point(z, a):
    """断面の角度 a（0=右、π/2=上）の点。上はやや丸く、下は少し角ばる超楕円。"""
    rx, yt, yb = fuse_at(z)
    yc = yb + 0.52 * (yt - yb)
    c, s = math.cos(a), math.sin(a)
    e = 2.15 if s > 0 else 2.6
    x = rx * math.copysign(abs(c) ** (2 / e), c)
    y = yc + (yt - yc if s > 0 else yc - yb) * math.copysign(abs(s) ** (2 / e), s)
    return V((x, y, z))


# ---------------- マテリアル ----------------
def materials():
    return {
        'white': C.principled('gelcoat_white', (0.86, 0.86, 0.83), rough=0.16, coat=0.6, coat_rough=0.04),
        'navy': C.principled('paint_navy', (0.025, 0.045, 0.22), rough=0.2, coat=0.6, coat_rough=0.04),
        'glass': C.principled('canopy_glass', (0.02, 0.028, 0.034), rough=0.02, alpha=0.42),
        'frame': C.principled('canopy_frame', (0.02, 0.02, 0.022), rough=0.45),
        'red': C.principled('dayglo_red', (0.80, 0.05, 0.025), rough=0.35),
        'tire': C.principled('tire_rubber', (0.018, 0.018, 0.02), rough=0.9),
        'metal': C.principled('hub_metal', (0.62, 0.63, 0.64), rough=0.3, metal=1.0),
        'dark': C.principled('wheel_well', (0.05, 0.05, 0.055), rough=0.8),
    }


# ---------------- 部品 ----------------
def canopy_limit(z):
    """キャノピー（枠を含む）が真上から左右へ何ラジアンまで広がるか。外では 0。"""
    zc, hl = (CANOPY[0] + CANOPY[1]) / 2, (CANOPY[1] - CANOPY[0]) / 2
    u = (z - zc) / hl
    if abs(u) >= 1:
        return 0.0
    p = 2.2 if u < 0 else 3.5          # 前は尖り気味、後ろは丸く切れる
    return 1.02 * (1 - abs(u) ** p) ** (1 / p)


NOSE_PAINT = -3.50                     # 機首の紺の塗り分け位置（z）
FRAME_W = 0.075                        # キャノピー枠の幅（ラジアン）


def build_fuselage(M, kc, kb, rows):
    """キャノピーの縁と機首の塗り分けがメッシュの線に一致するよう、断面ごとに頂点を配る。
    kc：ガラス部分の分割数、kb：胴体部分の分割数（いずれも片側）。"""
    z0, z1 = FUSE[0][0], FUSE[-1][0]
    zs = [z0 + (z1 - z0) * (1 - math.cos(j / rows * math.pi)) / 2 for j in range(rows + 1)]
    n = rows // 2
    zs += [CANOPY[0] + (CANOPY[1] - CANOPY[0]) * (1 - math.cos(k / n * math.pi)) / 2 for k in range(n + 1)]
    zs += [NOSE_PAINT]
    zs = sorted(set(round(z, 5) for z in zs))
    zs = [z for k, z in enumerate(zs) if k == 0 or z - zs[k - 1] > 0.004]
    grid, kinds = [], []
    for z in zs:
        lim = canopy_limit(z)
        glass = max(lim - FRAME_W, 0.0)
        eps = 0.002
        phis = [max(glass * k / kc, eps * k) for k in range(kc + 1)]      # ガラス（上→縁）
        phis.append(max(lim, phis[-1] + eps))                              # 枠の外縁
        phis += [phis[-1] + (math.pi - phis[-1]) * k / kb for k in range(1, kb + 1)]  # 胴体（縁→真下）
        right = phis
        left = list(reversed(phis[1:-1]))
        ring = [math.pi / 2 - f for f in right] + [math.pi / 2 + f for f in left]
        grid.append([sim(*fuse_point(z, a)) for a in ring])
    half = kc + 1 + kb                 # 片側の区間数

    def kind(i):
        k = i if i < half else (2 * half - 1 - i)   # 左側は鏡映
        return 'glass' if k < kc else ('frame' if k == kc else 'body')
    def face_mat(j, i, cb):
        if j < 0:
            return 1 if cb.y > 0 else 0
        z = -cb.y
        kd = kind(i)
        if kd == 'glass' and canopy_limit(z) > FRAME_W:
            return 2
        if kd in ('glass', 'frame') and canopy_limit(z) > 0:
            return 3
        return 1 if z < NOSE_PAINT else 0
    return C.grid_mesh('fuselage', grid, closed_u=True, cap_ends=True,
                       mats=[M['white'], M['navy'], M['glass'], M['frame']], face_mat=face_mat)


def wing_stations(side, x0, x1, n, fixed=None):
    st = []
    for k in range(n + 1):
        x = x0 + (x1 - x0) * k / n
        p = C.lerp_stations(WING_LE, x)
        y = dihedral(x)
        slope = 0.030 + 0.0068 * x
        up = V((-side * math.sin(math.atan(slope)), math.cos(math.atan(slope)), 0))
        st.append({'le': V((side * x, y, p['z'])), 'c': p['c'], 'th': p['th'], 'camber': 0.032, 'up': up})
    return st


def hinge_frame(a, b, up=V((0, 1, 0))):
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


def upper_surface_y(x, f):
    p = C.lerp_stations(WING_LE, x)
    prof = C.airfoil(p['th'], 0.032, 48)
    up = [q for q in prof[:49]]
    y = min(up, key=lambda q: abs(q[0] - f))[1]
    return dihedral(x) + y * p['c'], p['z'] + f * p['c']


def build_wing(M, side, m, nspan):
    s = 'R' if side > 0 else 'L'
    parts = []
    w = [M['white']]
    a0, a1, hf = AIL
    parts.append(C.loft_airfoil(f'wing_inner_{s}', wing_stations(side, WING_LE[0]['x'], a0, max(2, nspan // 2)), mats=w, m=m))
    parts.append(C.loft_airfoil(f'wing_outer_{s}', wing_stations(side, a0, a1, max(2, nspan // 3)), mats=w, m=m, f1=hf))
    parts.append(C.loft_airfoil(f'wing_tip_{s}', wing_stations(side, a1, WING_LE[-1]['x'], 2), mats=w, m=m))
    for p in parts:
        C.set_auto_smooth(p, 40)
    # 補助翼
    st = wing_stations(side, a0 + 0.01, a1 - 0.01, max(2, nspan // 3))
    ha = st[0]['le'] + V((0, 0, hf * st[0]['c'])); hb = st[-1]['le'] + V((0, 0, hf * st[-1]['c']))
    ail = C.loft_airfoil(f'aileron_{s}', st, mats=w, m=max(6, m // 2), f0=hf)
    a, b = (ha, hb) if side > 0 else (hb, ha)      # ローカル X は常に機体の右向き
    place_hinged(ail, (ha + hb) / 2, hinge_frame(a, b))
    C.set_auto_smooth(ail, 40)
    ail['control'] = 'aileron'; ail['side'] = side
    parts.append(ail)
    # ウイングレット（外へ少し傾けて立てる）
    tip = C.lerp_stations(WING_LE, WING_LE[-1]['x'])
    base = V((side * WING_LE[-1]['x'], dihedral(WING_LE[-1]['x']), tip['z']))
    cant = 0.22
    wl = []
    for k, (h, c, dz) in enumerate([(0.0, 0.25, 0.0), (0.22, 0.20, 0.035), (0.44, 0.12, 0.10)]):
        le = base + V((side * math.sin(cant) * h, math.cos(cant) * h + 0.02, dz))
        wl.append({'le': le, 'c': c, 'th': 0.10, 'camber': -0.02 * side * 0, 'up': V((math.cos(cant), -side * math.sin(cant) * 0, 0)) * side})
    wlo = C.loft_airfoil(f'winglet_{s}', wl, mats=w, m=max(6, m // 2))
    C.set_auto_smooth(wlo, 40)
    parts.append(wlo)
    return parts


def build_airbrake(M, side, detail):
    s = 'R' if side > 0 else 'L'
    x0, x1, f = BRAKE
    xm = (x0 + x1) / 2
    y0, z0 = upper_surface_y(x0, f)
    y1, z1 = upper_surface_y(x1, f)
    a, b = V((side * x0, y0, z0)), V((side * x1, y1, z1))
    length = (b - a).length
    cap = C.box(f'airbrake_cap_{s}', length, 0.012, 0.065, M['white'])
    plate = C.box(f'airbrake_plate_{s}', length - 0.02, 0.10, 0.016, M['red'])
    plate.location = sim(0, -0.056, 0)
    # 原点＝閉じたときのふたの位置。ローカル Y（シムの上）方向にせり上がる
    root = bpy.data.objects.new(f'airbrake_{s}', None)
    root.empty_display_type = 'SINGLE_ARROW'; root.empty_display_size = 0.2
    pa, pb = (a, b) if side > 0 else (b, a)
    rot = hinge_frame(pa, pb)
    root.matrix_world = Matrix.Translation(sim(*((a + b) / 2 + V((0, 0.003, 0))))) @ rot
    cap.parent = root; plate.parent = root
    root['control'] = 'airbrake'; root['travel'] = 0.11; root['side'] = side
    if detail:
        # 閉じたときに見える細いすき間（黒い線）
        slot = C.box(f'airbrake_slot_{s}', length + 0.01, 0.004, 0.075, M['dark'])
        slot.location = sim(0, -0.006, 0)
        slot.parent = root
        return [root, cap, plate, slot]
    return [root, cap, plate]


def build_tail(M, m, detail):
    w = [M['white']]
    up_x = V((1, 0, 0))
    fin_st = [{'le': V((0, 0.10, 3.26)), 'c': 1.14, 'th': 0.11, 'up': up_x},
              {'le': V((0, 0.85, 3.56)), 'c': 0.90, 'th': 0.11, 'up': up_x},
              {'le': V((0, 1.52, 3.86)), 'c': 0.66, 'th': 0.11, 'up': up_x}]
    hf = 0.70
    fin = C.loft_airfoil('fin', fin_st, mats=w, m=m, f1=hf)
    C.set_auto_smooth(fin, 40)
    ha = fin_st[0]['le'] + V((0, 0, hf * fin_st[0]['c'])); hb = fin_st[-1]['le'] + V((0, 0, hf * fin_st[-1]['c']))
    rud = C.loft_airfoil('rudder', [dict(fin_st[0], le=fin_st[0]['le'] + V((0, 0.02, 0))), fin_st[1], dict(fin_st[2], le=fin_st[2]['le'] - V((0, 0.02, 0)))],
                         mats=w, m=max(6, m // 2), f0=hf)
    # 方向舵：ローカル Y がヒンジ軸（上向き）、ローカル X は機体の右
    ya = (sim(*hb) - sim(*ha)).normalized()
    xa = sim(1, 0, 0) - sim(0, 0, 0)
    za = xa.cross(ya).normalized(); xa = ya.cross(za).normalized()
    place_hinged(rud, ha, Matrix((xa, ya, za)).transposed().to_4x4())
    rud['control'] = 'rudder'
    C.set_auto_smooth(rud, 40)
    # 水平尾翼（T 尾翼）と昇降舵
    ys = 1.565
    stab_st = lambda side: [{'le': V((side * 0.0, ys, 3.80)), 'c': 0.70, 'th': 0.10, 'camber': 0.0},
                            {'le': V((side * 1.72, ys + 0.01, 3.99)), 'c': 0.41, 'th': 0.09, 'camber': 0.0}]
    ef = 0.66
    parts = [fin, rud]
    for side in (-1, 1):
        sst = stab_st(side)
        stab = C.loft_airfoil('stab_' + ('R' if side > 0 else 'L'), sst, mats=w, m=m, f1=ef)
        C.set_auto_smooth(stab, 40); parts.append(stab)
    est = [dict(s) for s in stab_st(-1)][::-1] + [dict(s) for s in stab_st(1)][1:]
    eh = V((0, ys, 3.80 + ef * 0.70))
    elev = C.loft_airfoil('elevator', [dict(s, le=s['le'] + V((0, 0, 0))) for s in est], mats=w, m=max(6, m // 2), f0=ef)
    place_hinged(elev, eh, hinge_frame(V((-1, ys, eh.z)), V((1, ys, eh.z))))
    elev['control'] = 'elevator'
    C.set_auto_smooth(elev, 40)
    parts.append(elev)
    # 尾翼の付け根の弾頭形フェアリング
    rows = []
    for k in range(13):
        z = 3.72 + 0.86 * k / 12
        r = 0.065 * math.sin(math.pi * min(1, (k / 12) * 1.15 + 0.02)) ** 0.6 + 0.004
        rows.append([sim(r * math.cos(t * math.pi / 8), ys + 0.005 + r * 0.8 * math.sin(t * math.pi / 8), z) for t in range(16)])
    bul = C.grid_mesh('tail_bullet', rows, mats=w, cap_ends=True)
    parts.append(bul)
    if detail:
        # 総エネルギー（TE）プローブ：垂直尾翼の前縁から前へ突き出す細い管
        parts.append(C.tube('te_probe', [V((0, 1.12, 3.72)), V((0, 1.12, 3.44)), V((0, 1.14, 3.30)), V((0, 1.20, 3.25))], 0.0065, 8, M['metal']))
    return parts


def build_wheel(M, name, center, r, width, seg, detail=True):
    w = C.torus(name, r * 0.72, r * 0.28, seg, 10 if detail else 6, M['tire'])
    w.data.transform(Matrix.Scale(1.0, 4))
    w.location = sim(*center)
    hub = C.cylinder(name + '_hub', r * 0.46, width * 0.9, 16 if detail else 8, M['metal'], axis='x')
    hub.parent = w
    w['control'] = 'wheel'
    return [w, hub]


def build_gear(M, detail):
    c, r, wdt = WHEEL_MAIN
    parts = build_wheel(M, 'wheel_main', c, r, wdt, 28 if detail else 14, detail)
    # 前輪（胴体下面から少しだけ出る）と尾輪
    zn = -3.08; _, _, ybn = fuse_at(zn)
    parts += build_wheel(M, 'wheel_nose', V((0, ybn + 0.03, zn)), 0.10, 0.06, 20 if detail else 10, detail)
    zt = 4.22; _, _, ybt = fuse_at(zt)
    parts += build_wheel(M, 'wheel_tail', V((0, ybt - 0.015, zt)), 0.065, 0.04, 16 if detail else 8, detail)
    if detail:
        _, _, yb = fuse_at(c.z)
        for side in (-1, 1):
            d = C.box('gear_door_' + ('R' if side > 0 else 'L'), 0.008, 0.17, 0.60, M['white'], bevel=0.003)
            d.location = sim(side * 0.11, yb - 0.065, c.z - 0.02)
            d.rotation_euler = (0, side * 0.12, 0)
            parts.append(d)
        well = C.box('gear_well', 0.2, 0.05, 0.6, M['dark'])
        well.location = sim(0, yb + 0.015, c.z - 0.02)
        parts.append(well)
        # 曳航フック（機首下）
        hook = C.box('tow_hook_fairing', 0.05, 0.03, 0.08, M['metal'])
        _, _, yb2 = fuse_at(-3.55)
        hook.location = sim(0, yb2 + 0.005, -3.55)
        parts.append(hook)
    return parts


def build_decals(M, fuselage):
    """機種名の文字（文字は形状として作り、胴体表面に沿わせる）。"""
    out = []
    for side in (-1, 1):
        bpy.ops.object.text_add()
        t = bpy.context.object
        t.data.body = 'Duo Discus T'
        t.data.size = 0.125
        t.data.shear = 0.25
        t.data.align_x = 'CENTER'
        t.data.extrude = 0.0
        bpy.ops.object.convert(target='MESH')
        t = bpy.context.object
        t.name = 'decal_name_' + ('R' if side > 0 else 'L')
        t.data.materials.clear(); t.data.materials.append(M['navy'])
        z = -0.95
        rx, yt, yb = fuse_at(z)
        # テキストは XY 平面 → 胴体の横（シムの YZ 平面）に立てる
        rot = Matrix.Rotation(math.pi / 2, 4, 'X')
        rot = Matrix.Rotation(math.pi / 2 if side > 0 else -math.pi / 2, 4, 'Z') @ rot   # 外から見て左→右に読める向き
        t.matrix_world = Matrix.Translation(sim(side * (rx + 0.02), -0.12, z)) @ rot
        sw = t.modifiers.new('onto_fuselage', 'SHRINKWRAP')
        sw.target = fuselage; sw.wrap_method = 'NEAREST_SURFACEPOINT'; sw.offset = 0.0025
        out.append(t)
    return out


def build(detail=True):
    M = materials()
    lod = 'LOD0' if detail else 'LOD1'
    col = C.collection(f'DuoDiscusT_{lod}')
    root = bpy.data.objects.new('DuoDiscusT' + ('' if detail else '_lod1'), None)
    root.empty_display_type = 'ARROWS'
    col.objects.link(root)
    kc, kb, rows, m, nspan = (10, 26, 90, 22, 30) if detail else (3, 9, 30, 9, 9)
    fuse = build_fuselage(M, kc, kb, rows)
    objs = [fuse]
    for side in (-1, 1):
        objs += build_wing(M, side, m, nspan)
        objs += build_airbrake(M, side, detail)
    objs += build_tail(M, m, detail)
    objs += build_gear(M, detail)
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
    # 目印
    for name, p in (('eye_front', V((0, 0.50, -2.55))), ('panel', V((0, 0.34, -3.02))), ('tow_hook', V((0, -0.36, -3.55)))):
        e = bpy.data.objects.new(name if detail else name + '_lod1', None)
        e.location = sim(*p); e.parent = root; col.objects.link(e)
    root['source'] = 'blender/aircraft/duo_discus_t.py'
    root['span_m'] = 2 * WING_LE[-1]['x']
    return root, col


# ---------------- プレビュー描画（Cycles） ----------------
def render_preview(path, root, views=('front34',), res=(1600, 900), samples=96):
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.device = 'CPU'
    s.cycles.samples = samples
    try:
        s.cycles.use_denoising = True
    except Exception:
        pass
    s.render.resolution_x, s.render.resolution_y = res
    s.render.film_transparent = False
    s.view_settings.view_transform = 'AgX' if 'AgX' in [i.identifier for i in s.view_settings.bl_rna.properties['view_transform'].enum_items] else 'Filmic'
    w = bpy.data.worlds.new('sky'); s.world = w; w.use_nodes = True
    nt = w.node_tree; bg = nt.nodes['Background']
    sky = nt.nodes.new('ShaderNodeTexSky')
    try:
        sky.sky_type = 'NISHITA'; sky.sun_elevation = math.radians(38); sky.sun_rotation = math.radians(210)
    except Exception:
        pass
    nt.links.new(sky.outputs['Color'], bg.inputs['Color']); bg.inputs['Strength'].default_value = 0.35
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); s.collection.objects.link(sun)
    sun.data.energy = 4.0; sun.data.angle = math.radians(1.0)
    sun.rotation_euler = (math.radians(52), 0, math.radians(210 - 180))
    gm = C.principled('ground', (0.09, 0.12, 0.06), rough=0.95)
    s.view_settings.exposure = -0.9
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.95))
    bpy.context.object.data.materials.append(gm)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); s.collection.objects.link(cam); s.camera = cam
    cam.data.lens = 40
    shots = {
        'front34': (V((-8.5, 11.0, 1.6)), V((0.8, -0.6, 0.15)), 30),
        'rear34': (V((-9.5, -11.5, 2.1)), V((0.6, 0.2, 0.05)), 32),
        'side': (V((-16.0, 1.0, 0.6)), V((0, 0.4, 0.1)), 50),
        'nose': (V((-3.4, 5.6, 0.9)), V((0, 1.9, 0.15)), 40),
    }
    out = []
    for v in views:
        loc, tgt, lens = shots[v]
        cam.location = loc; cam.data.lens = lens
        d = (tgt - loc); cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        p = path.replace('.png', f'_{v}.png') if len(views) > 1 else path
        s.render.filepath = p
        bpy.ops.render.render(write_still=True)
        out.append(p)
    return out


def main(argv):
    import argparse
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
    for o in c1.objects:       # LOD1 は「名前_LOD1」（UE5 の LOD 命名と同じ）。three.js 側は前方一致で探す
        o.name = o.name.split('.')[0].replace('_lod1', '') + '_LOD1'
    os.makedirs(a.out, exist_ok=True)
    C.export_glb(os.path.join(a.out, 'duo_discus_t.glb'), [r0])
    C.export_glb(os.path.join(a.out, 'duo_discus_t_lod1.glb'), [r1])
    print(f'[duo_discus_t] LOD0 {C.triangle_count([r0]):,} tris, LOD1 {C.triangle_count([r1]):,} tris')
    if a.blend:
        c1.hide_render = True; c1.hide_viewport = True
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.blend))
    if a.render:
        c1.hide_render = True
        for p in render_preview(a.render, r0, tuple(a.views.split(',')), samples=a.samples):
            print('[duo_discus_t] render', p)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    main(argv)
