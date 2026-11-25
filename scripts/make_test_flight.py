#!/usr/bin/env python3
"""動作確認用のフライト JSON を作る：RWY 36 の上を低空で通過し、江戸川（西）へ向けて左旋回しながら上昇する。

  python scripts/make_test_flight.py --out exports/test_lowpass_5s.json --duration 5

形式はシミュレーターの録画（src/sim/recorder.js）と同じ：
  frames[i] = {t, cam: {pos, quat, fov}, plane: {pos, quat}}、座標は x = 東, y = 上, z = 南 [m]、四元数は [x, y, z, w]
"""
import argparse
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RUNWAY_HEADING = -0.131  # RWY 36 の方位（北から時計回り, rad）。src/sim/flight.js と同じ


def ground(detail, x, z):
    """詳細地形の標高（双一次補間）"""
    nx, nz = detail["segx"], detail["segz"]
    u = max(0.0, min(nx - 1e-6, (x - detail["xmin"]) / detail["width"] * nx))
    v = max(0.0, min(nz - 1e-6, (z - detail["zmin"]) / detail["depth"] * nz))
    i, j = int(u), int(v)
    a, b, n, h = u - i, v - j, nx + 1, detail["heights"]
    return ((h[j * n + i] * (1 - a) + h[j * n + i + 1] * a) * (1 - b)
            + (h[(j + 1) * n + i] * (1 - a) + h[(j + 1) * n + i + 1] * a) * b)


def yaw_pitch_roll_quat(heading, pitch, roll):
    """進行方向（北から時計回り）・機首上げ・バンクから、three.js の向き（-Z が前）の四元数 [x, y, z, w]"""
    # three.js：Y 軸まわりに a 回すと -Z が (-sin a, 0, -cos a) を向く。北 = -Z、東 = +X なので a = -heading
    def q_axis(ax, ang):
        s = math.sin(ang / 2)
        return (ax[0] * s, ax[1] * s, ax[2] * s, math.cos(ang / 2))

    def mul(p, q):
        px, py, pz, pw = p
        qx, qy, qz, qw = q
        return (pw * qx + px * qw + py * qz - pz * qy, pw * qy - px * qz + py * qw + pz * qx,
                pw * qz + px * qy - py * qx + pz * qw, pw * qw - px * qx - py * qy - pz * qz)
    q = q_axis((0, 1, 0), -heading)
    q = mul(q, q_axis((1, 0, 0), pitch))
    return list(mul(q, q_axis((0, 0, 1), -roll)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(HERE, "..", "assets", "data"))
    ap.add_argument("--out", default="exports/test_lowpass_5s.json")
    ap.add_argument("--duration", type=float, default=5.0)
    ap.add_argument("--hz", type=float, default=60.0)
    ap.add_argument("--hour", type=float, default=16.5)
    args = ap.parse_args()
    with open(os.path.join(args.data_dir, "detail.json"), encoding="utf-8") as f:
        detail = json.load(f)

    speed, turn_start = 30.0, 0.45  # [m/s]、全体の何割で旋回を始めるか
    x, z, heading = 0.0, 250.0, RUNWAY_HEADING
    frames, n = [], int(args.duration * args.hz) + 1
    for k in range(n):
        t = k / args.hz
        s = t / args.duration
        roll = 0.0 if s < turn_start else -math.radians(28) * min(1.0, (s - turn_start) / 0.2)
        turn_rate = 9.81 * math.tan(-roll) / speed  # 左旋回（西へ）
        heading -= turn_rate / args.hz
        x += math.sin(heading) * speed / args.hz
        z -= math.cos(heading) * speed / args.hz
        agl = 12.0 + 40.0 * max(0.0, s - turn_start) ** 1.5
        y = ground(detail, x, z) + agl
        pitch = math.radians(2.0 + 6.0 * (s > turn_start))
        pq = yaw_pitch_roll_quat(heading, pitch, roll)
        # 追尾カメラ：機体の 25 m 後ろ・6 m 上から前を見る
        cx, cz = x - math.sin(heading) * 25, z + math.cos(heading) * 25
        cq = yaw_pitch_roll_quat(heading, math.radians(-6), roll * 0.4)
        frames.append({"t": round(t, 4), "cam": {"pos": [cx, y + 6, cz], "quat": cq, "fov": 60},
                       "plane": {"pos": [x, y, z], "quat": pq, "agl": round(agl, 2)}})

    # 太陽：16:30 ごろの南西・低め（sunDir は x = 東, y = 上, z = 南）
    el, az = math.radians(12 if args.hour >= 16 else 40), math.radians(240)
    sun = [math.sin(az) * math.cos(el), math.sin(el), -math.cos(az) * math.cos(el)]
    out = {"version": 1, "source": "make_test_flight.py", "hz": args.hz,
           "environment": {"hour": args.hour, "sunDir": sun, "visibility": 60000, "windDir": 0, "windSpeed": 3},
           "frames": frames}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"保存しました：{args.out}（{len(frames)} コマ、{args.duration} 秒）")


if __name__ == "__main__":
    main()
