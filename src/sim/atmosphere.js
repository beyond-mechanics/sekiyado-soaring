// 大気モデル：平均風（高度による変化）、乱気流、上昇気流（周囲の下降気流と風下への傾き付き）。
// 座標系：x=東, y=上, z=南（北は -z）。

export const RHO = 1.225;
export const G = 9.81;

// 練習用に位置を固定した上昇気流（地図とガイドに表示）。旧版と同じ3か所＋追加。
const FIXED_THERMALS = [
  { x: -900, z: -900, r: 260, w: 3.0 },
  { x: 1250, z: 500, r: 300, w: 3.5 },
  { x: 500, z: -2000, r: 230, w: 2.6 },
  { x: -2600, z: 1800, r: 280, w: 2.8 },
  { x: 2900, z: -2700, r: 320, w: 3.2 },
  { x: -1800, z: -3600, r: 250, w: 2.4 }
];

function hash(n) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }
// 滑らかな1次元ノイズ（乱気流用）
function noise1(t, seed) {
  const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  return (hash(i + seed * 17.3) * (1 - u) + hash(i + 1 + seed * 17.3) * u) * 2 - 1;
}

export class Atmosphere {
  constructor({ windSpeed = 0, windFrom = 0, thermalScale = 1, turbulence = 0.5, cloudBase = 1350 } = {}) {
    this.windSpeed = windSpeed;
    this.windFrom = windFrom * Math.PI / 180; // 風が吹いてくる方位
    this.thermalScale = thermalScale;
    this.turbulence = turbulence;
    this.cloudBase = cloudBase;
    // 吹いていく方向の単位ベクトル
    const to = this.windFrom + Math.PI;
    this.wdx = Math.sin(to); this.wdz = -Math.cos(to);
    this.thermals = thermalScale > 0 ? FIXED_THERMALS.map(t => ({ ...t, w: t.w * thermalScale, phase: hash(t.x) * 6.28 })) : [];
  }

  // 高度（対地）での平均風の倍率：対数則、10m で 1.0、300m 以上で約 1.6
  profile(agl) {
    const z0 = 0.05, h = Math.max(1, Math.min(300, agl));
    return Math.log(h / z0) / Math.log(10 / z0);
  }

  // 上昇気流中心は風に流されて高度とともに風下へずれる
  thermalCenter(t, agl) {
    const drift = this.windSpeed * this.profile(agl) * agl / 2.5;
    return [t.x + this.wdx * drift, t.z + this.wdz * drift];
  }

  // 上昇気流の鉛直速度 [m/s]
  lift(x, z, agl, time = 0) {
    let w = 0;
    if (!this.thermals.length) return 0;
    const ramp = Math.min(1, Math.max(0, agl) / 160);
    const top = 1 - smooth((agl - this.cloudBase * 0.82) / (this.cloudBase * 0.18));
    if (top <= 0) return 0;
    for (const t of this.thermals) {
      const [cx, cz] = this.thermalCenter(t, agl);
      const d = Math.hypot(x - cx, z - cz);
      if (d > t.r * 3.2) continue;
      const pulse = 0.85 + 0.15 * Math.sin(time * 0.01 + t.phase);
      const core = Math.exp(-(d * d) / (t.r * t.r));
      const ring = Math.exp(-((d - 1.7 * t.r) ** 2) / ((0.55 * t.r) ** 2));
      w += t.w * pulse * (core - 0.32 * ring);
    }
    // 熱的な一般沈下（気流のない場所はわずかに下降）
    return (w - 0.12 * this.thermalScale) * ramp * top;
  }

  // 位置 (x, y, z) と対地高度 agl における風ベクトル（大気の速度）
  wind(x, z, agl, time, out) {
    const m = this.windSpeed * this.profile(agl);
    const turb = this.turbulence * (0.35 + 0.08 * this.windSpeed) * (agl < 2 ? 0.2 : 1);
    const nx = noise1(time * 0.9 + x * 0.004, 1) * 0.6 + noise1(time * 2.7 + z * 0.01, 2) * 0.4;
    const nz = noise1(time * 0.8 + z * 0.004, 3) * 0.6 + noise1(time * 2.3 + x * 0.01, 4) * 0.4;
    const ny = noise1(time * 1.1 + (x + z) * 0.006, 5) * 0.7 + noise1(time * 3.1, 6) * 0.3;
    const lift = this.lift(x, z, agl, time);
    // 上昇気流の中は乱れが強い
    const tb = turb * (1 + Math.min(1.5, Math.abs(lift) * 0.35));
    out.x = this.wdx * m + nx * tb;
    out.z = this.wdz * m + nz * tb;
    out.y = lift + ny * tb * 0.8 * Math.min(1, agl / 30);
    out.lift = lift;
    return out;
  }
}

function smooth(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
