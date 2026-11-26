// 質点＋姿勢の簡易6自由度風モデル。
// 力：揚力（迎角から CL）、抗力（極曲線 CD0 + k·CL² + エアブレーキ）、推力、重力、車輪の転がり抵抗。
// スティック前後 = 迎角の指示（手を離すとトリム迎角＝トリム速度に戻る、実機と同じ速度安定）。
import { RHO, G } from './atmosphere.js';

export const AIRCRAFT = {
  glider: {
    name: '複座練習グライダー', mass: 540, S: 17.9, span: 17, CLa: 5.4, alpha0: -0.045, CLmax: 1.42,
    CD0: 0.0105, k: 0.0205, CDbrake: 0.05, trim: 25, vne: 77, gearH: 0.95, groundAlpha: 0.035,
    mu: 0.07, brakeMu: 0.35, rollRate: 0.75, power: 0, staticThrust: 0
  },
  dimona: {
    name: 'SUPER DIMONA TC100', mass: 770, S: 15.3, span: 16.3, CLa: 5.3, alpha0: -0.04, CLmax: 1.6,
    CD0: 0.0185, k: 0.0225, CDbrake: 0.045, trim: 28, vne: 72, gearH: 1.25, groundAlpha: 0.02,
    mu: 0.06, brakeMu: 0.35, rollRate: 0.85, power: 73500, propEff: 0.5, staticThrust: 2100
  }
};

export const RUNWAY_HEADING = -0.131;   // RWY 36 の方位（北から時計回り, rad）
// 離陸・着陸の向き：普段は RWY 18（北端から南へ）を使う（2026-11 部員の指摘で反転）
export const TAKEOFF_HEADING = RUNWAY_HEADING + Math.PI;
export const RUNWAY_LENGTH = 1500, RUNWAY_WIDTH = 90;

export function runwayCoords(x, z) {
  const s = Math.sin(RUNWAY_HEADING), c = Math.cos(RUNWAY_HEADING);
  return { along: x * s - z * c, cross: x * c + z * s };
}
export function inRunway(x, z) {
  const { along, cross } = runwayCoords(x, z);
  return Math.abs(along) < RUNWAY_LENGTH / 2 && Math.abs(cross) < RUNWAY_WIDTH / 2;
}

const wind = { x: 0, y: 0, z: 0, lift: 0 };

export function createState(type, opts) {
  const a = AIRCRAFT[type];
  return {
    type, a,
    x: opts.x, y: opts.y, z: opts.z,
    vx: 0, vy: 0, vz: 0,
    heading: opts.heading, bank: 0, pitch: 0, alpha: 0, beta: 0,
    airspeed: 0, onGround: !!opts.onGround, hasFlown: !opts.onGround,
    trim: a.trim, brake: 0, stall: 0, te: 0, teRaw: 0, lift: 0, g: 1,
    engine: { on: false, throttle: opts.onGround ? 1 : 0.65, rpm: 0 },
    time: 0, touchdown: null, prevV: 0, distance: 0, maxAgl: 0,
    aileron: 0, elevator: 0, rudder: 0, wheelSpin: 0
  };
}

// 対気速度ベクトル v を与えて、初期化（空中スタート）
export function launch(s, speed) {
  s.vx = Math.sin(s.heading) * speed; s.vz = -Math.cos(s.heading) * speed; s.vy = 0;
  s.airspeed = speed; s.prevV = speed;
  s.alpha = trimAlpha(s.a, s.trim);
}

export function trimAlpha(a, v) {
  const CL = 2 * a.mass * G / (RHO * a.S * v * v);
  return CL / a.CLa + a.alpha0;
}

function CLof(a, alpha) {
  const stallA = a.CLmax / a.CLa + a.alpha0;
  if (alpha <= stallA) return { CL: a.CLa * (alpha - a.alpha0), stall: 0 };
  const over = alpha - stallA;
  return { CL: Math.max(0.75, a.CLmax - over * 4.0), stall: Math.min(1, over / 0.06) };
}

/**
 * 1 ステップ進める。
 * input: { roll, pitch, yaw }  (-1..1)   assist: bool
 * env:   { atmo, height(x,z) }
 */
export function stepFlight(s, input, dt, env, assist) {
  const a = s.a, atmo = env.atmo;
  const ground = env.height(s.x, s.z);
  const agl = s.y - ground - a.gearH;
  atmo.wind(s.x, s.z, Math.max(0, agl), s.time, wind);
  s.lift = wind.lift;

  // エンジン回転数（一次遅れ）と推力
  let T = 0;
  if (a.power) {
    const e = s.engine, target = e.on ? 1800 + 3700 * e.throttle : 0;
    e.rpm += (target - e.rpm) * Math.min(1, dt * (e.on ? 1.6 : 0.7));
    const p = Math.max(0, (e.rpm - 1400) / 4100);
    const Vf = Math.max(s.airspeed, 1);
    T = e.on ? Math.min(a.staticThrust * p, a.power * p ** 1.5 * a.propEff / Vf) : 0;
  }

  // 対気速度
  let ax = s.vx - wind.x, ay = s.vy - wind.y, az = s.vz - wind.z;
  let V = Math.hypot(ax, ay, az);

  // 操縦舵面（描画用）
  s.aileron += (input.roll - s.aileron) * Math.min(1, dt * 8);
  s.elevator += (input.pitch - s.elevator) * Math.min(1, dt * 8);
  s.rudder += (input.yaw - s.rudder) * Math.min(1, dt * 8);
  s.beta += (input.yaw * 0.1 - s.beta) * Math.min(1, dt * 2);

  const brakeCD = s.brake * a.CDbrake;

  if (s.onGround) {
    // ---- 地上滑走 ----
    const hx = Math.sin(s.heading), hz = -Math.cos(s.heading);
    let gs = s.vx * hx + s.vz * hz;                       // 対地速度（機軸方向）
    const Va = Math.max(0, gs - (wind.x * hx + wind.z * hz)); // 機軸方向の対気速度
    // 昇降舵：一定速度以上で機首上げ可能
    const authority = Math.min(1, Math.max(0, (Va - 12) / 10));
    const alphaCmd = a.groundAlpha + Math.max(0, input.pitch) * 0.17 * authority;
    s.alpha += (alphaCmd - s.alpha) * Math.min(1, dt * 3);
    const { CL } = CLof(a, s.alpha);
    const q = 0.5 * RHO * Va * Va;
    const L = q * a.S * CL, D = q * a.S * (a.CD0 + a.k * CL * CL + brakeCD);
    const W = a.mass * G, N = Math.max(0, W - L);
    const mu = a.mu + s.brake * a.brakeMu;
    const fr = gs > 0.05 ? mu * N : 0;
    const acc = (T - D - fr) / a.mass;
    gs = Math.max(0, gs + acc * dt);
    // 方向：ラダー／前輪（左右キー＋ラダーキー）
    const steer = (input.roll * 0.9 + input.yaw) * 0.32 * Math.min(1, gs / 4 + 0.15);
    s.heading += steer * dt;
    s.bank += (0 - s.bank) * Math.min(1, dt * 4);
    s.vx = Math.sin(s.heading) * gs; s.vz = -Math.cos(s.heading) * gs; s.vy = 0;
    s.x += s.vx * dt; s.z += s.vz * dt;
    s.y = env.height(s.x, s.z) + a.gearH;
    s.pitch = s.alpha - a.groundAlpha * 0.5;
    s.airspeed = Va; s.stall = 0; s.g = 1;
    s.wheelSpin += gs * dt / 0.3;
    // 離陸：揚力が重量を上回ったら浮揚
    if (L > W * 1.02 && Va > 15) { s.onGround = false; s.vy = 0.3; s.y += 0.05; s.hasFlown = true; s.touchdown = null; }
  } else {
    // ---- 空中 ----
    if (V < 3) { V = 3; }
    const vx = ax / V, vy = ay / V, vz = az / V;
    // 迎角：トリム迎角 ± スティック（一次遅れ）
    const aTrim = trimAlpha(a, s.trim);
    const alphaCmd = aTrim + (input.pitch >= 0 ? input.pitch * 0.17 : input.pitch * 0.2);
    // 速度が低いと舵の効きが落ちる
    const eff = Math.min(1, V / 18);
    s.alpha += (alphaCmd - s.alpha) * Math.min(1, dt * 3.2 * eff);
    const { CL, stall } = CLof(a, s.alpha);
    s.stall = stall;
    const q = 0.5 * RHO * V * V;
    const L = q * a.S * CL;
    // 地面効果：翼幅程度の高さ以下で誘導抗力が減る（McCormick の近似）
    const hb = Math.max(0.05, (agl + a.gearH) / a.span), ge = (16 * hb * hb) / (1 + 16 * hb * hb);
    const CD = a.CD0 + a.k * ge * CL * CL + brakeCD + stall * 0.09 + Math.abs(s.beta) * 0.15;
    const D = q * a.S * CD;

    // バンク
    const roll = input.roll * a.rollRate * Math.min(1, V / 20) * (1 - stall * 0.5);
    if (assist) {
      const target = input.roll * 0.95;
      s.bank += (target - s.bank) * Math.min(1, dt * 1.6 * Math.min(1, V / 20));
    } else {
      s.bank += roll * dt;
    }
    // 失速時は片翼が落ちる
    if (stall > 0.4) s.bank += Math.sin(s.time * 0.7 + 1.3) * stall * 0.9 * dt;
    s.bank = Math.max(-1.35, Math.min(1.35, s.bank));

    // 右方向ベクトル r = v × up、揚力方向 = (r × v)·cos(bank) + r·sin(bank)
    let rx = -vz, rz = vx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    const ux = -rz * vy, uy = rz * vx - rx * vz, uz = rx * vy; // r × v (ry = 0)
    const cb = Math.cos(s.bank), sb = Math.sin(s.bank);
    const lx = ux * cb + rx * sb, ly = uy * cb, lz = uz * cb + rz * sb;
    const side = q * a.S * 0.25 * s.beta;   // ラダーによる横力（滑り）

    const fx = L * lx - D * vx + T * vx + side * rx;
    const fy = L * ly - D * vy + T * vy;
    const fz = L * lz - D * vz + T * vz + side * rz;
    s.g = L / (a.mass * G);

    s.vx += fx / a.mass * dt;
    s.vy += (fy / a.mass - G) * dt;
    s.vz += fz / a.mass * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;

    ax = s.vx - wind.x; ay = s.vy - wind.y; az = s.vz - wind.z;
    V = Math.hypot(ax, ay, az);
    s.airspeed = V;
    s.heading = Math.atan2(ax, -az) + s.beta;
    const gamma = Math.asin(Math.max(-1, Math.min(1, ay / Math.max(V, 0.1))));
    s.pitch = gamma + s.alpha - 0.03;
    s.maxAgl = Math.max(s.maxAgl, agl);

    // 接地判定
    const g2 = env.height(s.x, s.z) + a.gearH;
    if (s.y <= g2) {
      const { along, cross } = runwayCoords(s.x, s.z);
      s.touchdown = {
        vs: s.vy, bank: s.bank, speed: s.airspeed, groundSpeed: Math.hypot(s.vx, s.vz),
        onRunway: Math.abs(along) < RUNWAY_LENGTH / 2 && Math.abs(cross) < RUNWAY_WIDTH / 2, along, cross
      };
      s.onGround = true; s.y = g2;
      // 機軸方向へ速度をそろえる
      const gs = Math.max(0, s.vx * Math.sin(s.heading) - s.vz * Math.cos(s.heading));
      s.vx = Math.sin(s.heading) * gs; s.vz = -Math.cos(s.heading) * gs; s.vy = 0;
      s.alpha = a.groundAlpha;
    }
  }

  // 総エネルギー（TE）補正付き昇降計：vy + V·dV/dt / g、計器の遅れ 0.6 s
  const dV = (s.airspeed - s.prevV) / dt;
  s.prevV = s.airspeed;
  s.teRaw = s.onGround ? 0 : s.vy + s.airspeed * dV / G;
  s.te += (Math.max(-12, Math.min(12, s.teRaw)) - s.te) * Math.min(1, dt / 0.6);
  s.distance += Math.hypot(s.vx, s.vz) * dt;
  s.time += dt;
  return s;
}

export function stallSpeed(a) { return Math.sqrt(2 * a.mass * G / (RHO * a.S * a.CLmax)); }
export function clampTrim(s, v) { s.trim = Math.max(stallSpeed(s.a) * 1.15, Math.min(s.a.vne * 0.8, v)); return s.trim; }
