// 航空機曳航（自動追従アシスト）。索の張力は計算せず、曳航機の経路にグライダーを追従させる。
import { TAKEOFF_HEADING } from './flight.js';

const ROPE = 55;

export function createTow(height) {
  const x = -Math.sin(TAKEOFF_HEADING) * 600, z = Math.cos(TAKEOFF_HEADING) * 600; // 滑走路の手前の端から
  return { x, z, y: height(x, z) + 1.5, v: 0, heading: TAKEOFF_HEADING, bank: 0, pitch: 0, climb: 0,
    airborne: false, attached: true, departTime: 0, turnDir: 0, time: 0, propSpin: 0 };
}

export function stepTow(t, s, dt, height) {
  t.time += dt; t.v = Math.min(31, t.v + (t.airborne ? 0.6 : 1.15) * dt);
  t.propSpin += dt * 40;
  const agl = t.y - height(t.x, t.z);
  if (t.v >= 24 && !t.airborne) t.airborne = true;
  let turnRate = 0;
  if (t.airborne) {
    t.climb = Math.min(3.2, t.climb + dt * 0.7);
    // 上空 150 m 以降は場周を大きく左旋回しながら上昇
    if (agl > 150) turnRate = -0.045;
    t.heading += turnRate * dt;
    t.y += t.climb * dt;
  } else {
    t.y = height(t.x, t.z) + 1.5;
  }
  t.bank += (Math.atan(turnRate * t.v / 9.81) - t.bank) * Math.min(1, dt * 1.5);
  t.pitch = Math.asin(Math.min(0.3, t.climb / Math.max(t.v, 1))) + 0.04;
  t.x += Math.sin(t.heading) * t.v * dt; t.z -= Math.cos(t.heading) * t.v * dt;

  // グライダー：曳航機の後方 ROPE m、わずかに上（ハイトウ）。滑らかに追従。
  const tx = t.x - Math.sin(t.heading) * ROPE, tz = t.z + Math.cos(t.heading) * ROPE;
  const ground = height(tx, tz) + s.a.gearH;
  const ty = Math.max(ground, t.airborne ? t.y + 2.0 : ground);
  const px = s.x, py = s.y, pz = s.z;
  const k = Math.min(1, dt * 3.5);
  s.x += (tx - s.x) * k; s.z += (tz - s.z) * k; s.y += (ty - s.y) * k;
  // グライダーは曳航機より先に浮く（地面効果で 20 m/s 前後）
  if (!t.airborne && t.v > 19) s.y = Math.max(s.y, ground + Math.min(1.2, (t.v - 19) * 0.3));
  s.vx = (s.x - px) / dt; s.vy = (s.y - py) / dt; s.vz = (s.z - pz) / dt;
  s.heading += angleDiff(t.heading, s.heading) * k; s.bank += (t.bank - s.bank) * k;
  s.pitch = t.pitch - 0.03; s.airspeed = t.v; s.onGround = s.y <= ground + 0.02; s.hasFlown = !s.onGround || s.hasFlown;
  s.brake = 0; s.stall = 0; s.g = 1; s.time += dt; s.wheelSpin += t.v * dt / 0.3;
  return s.y - height(s.x, s.z) >= 600;
}

export function releaseTow(t, s, height) {
  if (!t?.attached || s.y - height(s.x, s.z) < 30) return false;
  t.attached = false; t.departTime = 0;
  s.onGround = false; s.hasFlown = true; s.prevV = s.airspeed;
  return true;
}

// 切り離し後：曳航機は左へ降下旋回して離脱（グライダーは右へ）
export function stepDeparture(t, dt) {
  t.departTime += dt; t.heading -= 0.12 * dt; t.bank += (-0.45 - t.bank) * Math.min(1, dt * 2);
  t.pitch += (-0.08 - t.pitch) * Math.min(1, dt); t.propSpin += dt * 40;
  t.x += Math.sin(t.heading) * t.v * dt; t.z -= Math.cos(t.heading) * t.v * dt; t.y -= 4 * dt;
}

function angleDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
