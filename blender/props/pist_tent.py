"""ピスト（発航点）のワンタッチテント・折りたたみ机・椅子・クーラーボックス・無線機を置く台。

  blender -b -P blender/props/pist_tent.py -- --out assets/data/models
原点＝テントの中心の地面。テントの正面（机のある側）が +x（滑走路側に向けて置く）。
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
S, LEG_H, PEAK = 3.0, 2.05, 2.85


def build(detail=True):
    M = {
        'canvas': C.principled('tent_canvas_blue', (0.05, 0.16, 0.45), rough=0.85),
        'frame': C.principled('tent_frame_alu', (0.70, 0.71, 0.72), rough=0.35, metal=1.0),
        'table': C.principled('table_top', (0.75, 0.74, 0.70), rough=0.6),
        'chair': C.principled('chair_fabric', (0.10, 0.25, 0.12), rough=0.9),
        'cooler': C.principled('cooler_blue', (0.12, 0.35, 0.65), rough=0.5),
        'white': C.principled('cooler_lid', (0.85, 0.85, 0.82), rough=0.5),
        'black': C.principled('radio_black', (0.03, 0.03, 0.03), rough=0.6),
    }
    M['canvas'].use_backface_culling = False
    col = C.collection('PistTent_' + ('LOD0' if detail else 'LOD1'))
    root = bpy.data.objects.new('PistTent' + ('' if detail else '_lod1'), None)
    col.objects.link(root)
    objs = []
    h = S / 2
    # 屋根：四角すい（少しふくらませる）と垂れ（バランス）
    n = 8 if detail else 2
    rows = []
    for k in range(n + 1):
        t = k / n
        r = h * (1 - t)
        y = LEG_H + (PEAK - LEG_H) * (1 - (1 - t) ** 1.25)
        ring = []
        for a in range(16 if detail else 4):
            ang = a / (16 if detail else 4) * 2 * math.pi + math.pi / 4
            c, s = math.cos(ang), math.sin(ang)
            sq = max(abs(c), abs(s))              # 正方形の周上へ
            ring.append(sim(r * c / sq, y, r * s / sq))
        rows.append(ring)
    roof = C.grid_mesh('tent_roof', rows, closed_u=True, mats=[M['canvas']], smooth=False)
    objs.append(roof)
    for i, (dx, dz, rot) in enumerate(((0, -h, 0), (0, h, 0), (-h, 0, 1), (h, 0, 1))):
        v = C.box(f'valance_{i}', S if not rot else 0.01, 0.22, 0.01 if not rot else S, M['canvas'])
        v.location = sim(dx, LEG_H - 0.11, dz); objs.append(v)
    for i, (sx, sz) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
        leg = C.box(f'leg_{i}', 0.035, LEG_H, 0.035, M['frame']); leg.location = sim(sx * h, LEG_H / 2, sz * h); objs.append(leg)
        if detail:
            foot = C.box(f'foot_{i}', 0.12, 0.01, 0.12, M['frame']); foot.location = sim(sx * h, 0.005, sz * h); objs.append(foot)
            # 斜めの支え（X 型の骨）
            objs.append(C.tube(f'truss_{i}', [V((sx * h, LEG_H - 0.05, sz * h)), V((sx * h * 0.5, LEG_H - 0.35, sz * h))], 0.012, 5, M['frame']))
    # 折りたたみ机
    top = C.box('table_top', 0.6, 0.03, 1.8, M['table'], bevel=0.005 if detail else 0); top.location = sim(0.7, 0.72, 0); objs.append(top)
    for sz in (-0.8, 0.8):
        for sx in (0.45, 0.95):
            lg = C.box('table_leg', 0.025, 0.7, 0.025, M['frame']); lg.location = sim(sx, 0.35, sz); objs.append(lg)
    if detail:
        # 椅子 2 脚（座面・背もたれ・X 脚）
        for k, z in enumerate((-0.5, 0.5)):
            seat = C.box(f'chair_seat_{k}', 0.45, 0.03, 0.45, M['chair']); seat.location = sim(0.1, 0.45, z); objs.append(seat)
            back = C.box(f'chair_back_{k}', 0.03, 0.45, 0.45, M['chair']); back.location = sim(-0.12, 0.72, z); back.rotation_euler = (0, 0.15, 0); objs.append(back)
            for sz in (-0.2, 0.2):
                objs.append(C.tube(f'chair_x_{k}', [V((-0.12, 0.0, z + sz)), V((0.32, 0.45, z + sz))], 0.012, 5, M['frame']))
                objs.append(C.tube(f'chair_x2_{k}', [V((0.32, 0.0, z + sz)), V((-0.12, 0.45, z + sz))], 0.012, 5, M['frame']))
        cooler = C.box('cooler', 0.4, 0.35, 0.6, M['cooler'], bevel=0.02); cooler.location = sim(-0.8, 0.175, 0.9); objs.append(cooler)
        lid = C.box('cooler_lid', 0.42, 0.06, 0.62, M['white'], bevel=0.02); lid.location = sim(-0.8, 0.38, 0.9); objs.append(lid)
        radio = C.box('radio', 0.22, 0.08, 0.3, M['black'], bevel=0.01); radio.location = sim(0.7, 0.78, -0.4); objs.append(radio)
        objs.append(C.tube('radio_antenna', [V((0.75, 0.82, -0.5)), V((0.75, 1.35, -0.5))], 0.005, 5, M['black']))
    for o in objs:
        if o.name not in col.objects:
            col.objects.link(o)
        if o.parent is None:
            o.parent = root
    root['source'] = 'blender/props/pist_tent.py'
    return root, col


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    C.run_object_script(argv, build, 'pist_tent')
