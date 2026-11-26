"""グライダー運搬用の密閉トレーラー（白い FRP の箱、1 軸、A 型の牽引棒）。

  blender -b -P blender/props/glider_trailer.py -- --out assets/data/models
原点＝地面の上、車体の中心の真下。前（牽引側）が -z。特定メーカーの製品の複製ではありません。
"""
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import common as C  # noqa: E402
from common import sim  # noqa: E402

V = Vector
L, W, H, Y0 = 8.6, 1.56, 1.42, 0.52      # 箱の長さ・幅・高さ・床の高さ
AXLE_Z, WHEEL_R = 1.2, 0.30


def materials():
    return {
        'grp': C.principled('trailer_grp_white', (0.80, 0.80, 0.77), rough=0.32, coat=0.25),
        'skirt': C.principled('trailer_skirt_grey', (0.22, 0.23, 0.24), rough=0.5, metal=0.4),
        'seam': C.principled('trailer_seam', (0.05, 0.05, 0.05), rough=0.7),
        'steel': C.principled('galvanised_steel', (0.50, 0.51, 0.50), rough=0.45, metal=1.0),
        'tire': C.principled('tire_rubber', (0.018, 0.018, 0.02), rough=0.9),
        'metal': C.principled('rim_steel', (0.55, 0.56, 0.57), rough=0.35, metal=1.0),
        'lamp_red': C.principled('lamp_red', (0.55, 0.02, 0.02), rough=0.2),
        'lamp_amber': C.principled('lamp_amber', (0.8, 0.35, 0.02), rough=0.2),
        'dirt': C.principled('mud_grey', (0.30, 0.29, 0.26), rough=0.9),
    }


def body(M, ring, rows):
    """角の丸い箱。前は半楕円体のように丸く、後ろは少しだけ丸める。"""
    zs = [-L / 2 + L * (1 - math.cos(j / rows * math.pi)) / 2 for j in range(rows + 1)]
    grid = []
    for z in zs:
        u = (z + L / 2) / L
        nose = min(1.0, (u / 0.13)) ** 0.5             # 前 13 % で丸める
        tail = min(1.0, ((1 - u) / 0.012)) ** 0.5
        k = max(0.04, min(nose, tail))
        rx, ry = W / 2 * k, H / 2 * (0.35 + 0.65 * k)
        yc = Y0 + H / 2 + (1 - k) * 0.12
        row = []
        for i in range(ring):
            a = i / ring * 2 * math.pi
            c, s = math.cos(a), math.sin(a)
            e = 5.0                                    # 角の丸い四角
            row.append(sim(rx * math.copysign(abs(c) ** (2 / e), c), yc + ry * math.copysign(abs(s) ** (2 / e), s), z))
        grid.append(row)
    def mat(j, i, c):
        y = c.z
        z = -c.y
        if y < Y0 + 0.16:
            return 1                                   # 下の灰色の帯
        if abs(z - 1.9) < 0.012 or abs(z + 2.6) < 0.012:
            return 2                                   # 胴体・主翼部分の分割線（ふた）
        return 0
    zs_ok = zs
    ob = C.grid_mesh('trailer_body', grid, closed_u=True, cap_ends=True, mats=[M['grp'], M['skirt'], M['seam']], face_mat=mat)
    C.set_auto_smooth(ob, 50)
    return ob


def build(detail=True):
    M = materials()
    col = C.collection('GliderTrailer_' + ('LOD0' if detail else 'LOD1'))
    root = bpy.data.objects.new('GliderTrailer' + ('' if detail else '_lod1'), None)
    col.objects.link(root)
    objs = [body(M, 48 if detail else 16, 60 if detail else 14)]
    # 車軸・車輪・泥よけ
    for side in (-1, 1):
        objs += C.wheel('wheel_' + ('R' if side > 0 else 'L'), V((side * (W / 2 + 0.02), WHEEL_R, AXLE_Z)), WHEEL_R, 0.17, M,
                        28 if detail else 10, 10 if detail else 5, hub_r=0.55)
        fender = C.box('fender_' + ('R' if side > 0 else 'L'), 0.24, 0.03, 0.85, M['skirt'], bevel=0.01 if detail else 0)
        fender.location = sim(side * (W / 2 + 0.03), WHEEL_R * 2 + 0.06, AXLE_Z)
        objs.append(fender)
    axle = C.cylinder('axle', 0.035, W + 0.1, 10, M['steel'], axis='x'); axle.location = sim(0, WHEEL_R, AXLE_Z); objs.append(axle)
    # A 型の牽引棒とカプラー、補助輪
    front = -L / 2
    tip = V((0, 0.46, front - 1.45))
    for side in (-1, 1):
        objs.append(C.tube('drawbar_' + ('R' if side > 0 else 'L'), [V((side * 0.55, Y0 - 0.02, front + 0.9)), V((side * 0.3, 0.48, front - 0.3)), tip], 0.04, 8 if detail else 5, M['steel']))
    coupler = C.box('coupler', 0.12, 0.12, 0.35, M['steel'], bevel=0.02 if detail else 0); coupler.location = sim(0, 0.48, front - 1.55); objs.append(coupler)
    if detail:
        objs.append(C.tube('jockey_post', [V((0.15, 0.85, front - 0.9)), V((0.15, 0.12, front - 0.9))], 0.03, 8, M['steel']))
        objs += C.wheel('jockey_wheel', V((0.15, 0.09, front - 0.9)), 0.09, 0.06, M, 16, 6)
        for side in (-1, 1):
            for k, (mat, dx) in enumerate((('lamp_red', 0.0), ('lamp_amber', 0.14))):
                lamp = C.box(f'lamp_{k}_' + ('R' if side > 0 else 'L'), 0.12, 0.07, 0.02, M[mat])
                lamp.location = sim(side * (W / 2 - 0.12 - dx), Y0 + 0.08, L / 2 + 0.01)
                objs.append(lamp)
        # 後ろの扉の蝶番と取っ手
        for side in (-1, 1):
            h = C.box('rear_latch_' + ('R' if side > 0 else 'L'), 0.05, 0.12, 0.03, M['steel'])
            h.location = sim(side * 0.55, Y0 + H * 0.55, L / 2 + 0.015); objs.append(h)
        # 泥はね（下のほうに少しだけ）
        dirt = C.box('mud_splash', W + 0.002, 0.10, 1.8, M['dirt']); dirt.location = sim(0, Y0 + 0.17, AXLE_Z); objs.append(dirt)
    for o in objs:
        if o.name not in col.objects:
            col.objects.link(o)
        if o.parent is None:
            o.parent = root
    root['source'] = 'blender/props/glider_trailer.py'
    return root, col


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    C.run_object_script(argv, build, 'glider_trailer')
