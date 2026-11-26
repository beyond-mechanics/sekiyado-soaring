"""吹き流し（支柱・回転部・5 つの輪の布）。

  blender -b -P blender/props/windsock.py -- --out assets/data/models
原点＝支柱の根元。回転部 sock_pivot はローカル Y 回り、布 sock_seg_0..4 は sock_pivot の子で、風下（ローカル +z）へ並ぶ。
シムでは風向で sock_pivot を回し、風が弱いと各輪を下げて垂れさせる。
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
POLE_H, SEG_L, R0, TAPER = 6.5, 0.6, 0.34, 0.04


def build(detail=True):
    M = {
        'pole': C.principled('pole_galv', (0.55, 0.56, 0.55), rough=0.4, metal=1.0),
        'orange': C.principled('sock_orange', (0.85, 0.22, 0.04), rough=0.8),
        'white': C.principled('sock_white', (0.86, 0.84, 0.80), rough=0.8),
        'concrete': C.principled('footing', (0.45, 0.44, 0.42), rough=0.95),
    }
    for m in (M['orange'], M['white']):
        m.use_backface_culling = False
    col = C.collection('Windsock_' + ('LOD0' if detail else 'LOD1'))
    root = bpy.data.objects.new('Windsock' + ('' if detail else '_lod1'), None)
    col.objects.link(root)
    seg = 16 if detail else 8
    objs = []
    pole = C.cylinder('pole', 0.075, POLE_H, seg, M['pole'], axis='y')
    pole.data.transform(__import__('mathutils').Matrix.Translation((0, 0, POLE_H / 2)))
    objs.append(pole)
    if detail:
        base = C.box('footing', 0.5, 0.15, 0.5, M['concrete'], bevel=0.02); base.location = sim(0, 0.07, 0); objs.append(base)
        cap = C.cylinder('pole_cap', 0.09, 0.08, seg, M['pole'], axis='y'); cap.location = sim(0, POLE_H + 0.04, 0); objs.append(cap)
    pivot = bpy.data.objects.new('sock_pivot', None); pivot.location = sim(0, POLE_H - 0.2, 0); objs.append(pivot)
    arm = C.tube('sock_arm', [V((0, 0, 0)), V((0, 0, 0.05)), V((0, 0, 0.12))], 0.02, 6, M['pole']); arm.parent = pivot; objs.append(arm)
    # 口の輪（枠）
    hoop = C.torus('sock_hoop', R0, 0.012, 24 if detail else 10, 6 if detail else 4, M['pole'])
    hoop.rotation_euler = (0, 0, math.pi / 2)   # トーラスの軸（ローカル x）を風下へ
    hoop.location = sim(0, 0, 0.12); hoop.parent = pivot; objs.append(hoop)
    for i in range(5):
        r1, r2 = R0 - i * TAPER, R0 - (i + 1) * TAPER
        rows = []
        for k in range(3):
            t = k / 2
            r = r1 + (r2 - r1) * t
            rows.append([sim(r * math.cos(a / seg * 2 * math.pi), r * math.sin(a / seg * 2 * math.pi), t * SEG_L) for a in range(seg)])
        s = C.grid_mesh(f'sock_seg_{i}', rows, closed_u=True, mats=[M['orange'] if i % 2 == 0 else M['white']])
        s.location = sim(0, 0, 0.12 + i * SEG_L)
        s.parent = pivot
        s['control'] = 'sock'
        objs.append(s)
    for o in objs:
        if o.name not in col.objects:
            col.objects.link(o)
        if o.parent is None:
            o.parent = root
    root['source'] = 'blender/props/windsock.py'
    return root, col


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    C.run_object_script(argv, build, 'windsock')
