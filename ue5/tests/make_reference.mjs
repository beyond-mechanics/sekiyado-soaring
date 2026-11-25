#!/usr/bin/env node
// JS 版の飛行モデル（src/sim/*.js）で試験シナリオを走らせ、参照軌跡を書き出す。
// 出力：<out>/<name>.scn（C++ 側が読む平文のシナリオ）と <name>.csv（参照軌跡）。
//   node ue5/tests/make_reference.mjs [出力フォルダ（既定 ue5/tests/reference）]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIRCRAFT, createState, launch, stepFlight, clampTrim } from '../../src/sim/flight.js';
import { Atmosphere } from '../../src/sim/atmosphere.js';
import { createTow, stepTow, releaseTow } from '../../src/sim/tow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || path.join(HERE, 'reference'));
const spec = JSON.parse(fs.readFileSync(path.join(HERE, 'scenarios.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

// 試験用の地面：緩い起伏（UE では Landscape、ここでは解析関数）。C++ 側と同じ式。
export const testHeight = (x, z) => 8 + 2 * Math.sin(x / 300) * Math.cos(z / 400);

export const COLUMNS = ['t', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'heading', 'bank', 'pitch', 'alpha', 'airspeed', 'te', 'onGround'];
const fmt = v => (typeof v === 'boolean' ? (v ? 1 : 0) : Number(v).toPrecision(17));

function segAt(segs, t) { let cur = segs[0]; for (const s of segs) if (s.t <= t + 1e-9) cur = s; return cur; }

for (const sc of spec.scenarios) {
  const dt = spec.dt, steps = Math.round(sc.duration / dt);
  const atmo = new Atmosphere(sc.atmo);
  const a = AIRCRAFT[sc.aircraft];
  let s, tow = null;
  if (sc.mode === 'tow') {
    tow = createTow(testHeight);
    const x = tow.x + Math.sin(tow.heading) * -55, z = tow.z - Math.cos(tow.heading) * -55;
    s = createState(sc.aircraft, { x, y: testHeight(x, z) + a.gearH, z, heading: tow.heading, onGround: true });
  } else {
    const st = sc.start;
    const y = st.onGround ? testHeight(st.x, st.z) + a.gearH : st.y;
    s = createState(sc.aircraft, { x: st.x, y, z: st.z, heading: st.heading, onGround: st.onGround });
    if (!st.onGround) launch(s, st.launch);
  }
  // C++ 用の平文シナリオ
  const lines = [`aircraft ${sc.aircraft}`, `mode ${sc.mode}`, `dt ${fmt(dt)}`, `steps ${steps}`, `sampleEvery ${spec.sampleEvery}`,
    `assist ${sc.assist ? 1 : 0}`, `release ${fmt(sc.release ?? -1)}`,
    `atmo ${[sc.atmo.windSpeed, sc.atmo.windFrom, sc.atmo.thermalScale, sc.atmo.turbulence, sc.atmo.cloudBase].map(fmt).join(' ')}`,
    `start ${[s.x, s.y, s.z, s.heading].map(fmt).join(' ')} ${s.onGround ? 1 : 0} ${fmt(sc.start.launch ?? 0)}`];
  let prevSeg = null;
  const input = { roll: 0, pitch: 0, yaw: 0 };
  const rows = [COLUMNS.join(',')];
  const sample = () => rows.push(COLUMNS.map(c => fmt(c === 't' ? s.time : s[c])).join(','));
  sample();
  for (let i = 0; i < steps; i++) {
    const tNow = i * dt, seg = segAt(sc.segs, tNow);
    if (seg !== prevSeg) {
      // 操作の切り替え（保持値は前の seg を引き継ぐ）
      for (const k of ['roll', 'pitch', 'yaw']) if (seg[k] !== undefined) input[k] = seg[k];
      if (seg.brake !== undefined) s.brake = seg.brake;
      if (seg.trim !== undefined) clampTrim(s, seg.trim);
      if (seg.engine !== undefined) s.engine.on = !!seg.engine;
      if (seg.throttle !== undefined) s.engine.throttle = seg.throttle;
      lines.push(`seg ${i} ${['roll', 'pitch', 'yaw', 'brake', 'trim', 'engine', 'throttle'].map(k => seg[k] === undefined ? 'nan' : fmt(seg[k])).join(' ')}`);
      prevSeg = seg;
    }
    if (tow && tow.attached) {
      if (sc.release >= 0 && tNow >= sc.release - 1e-9) releaseTow(tow, s, testHeight);
    }
    if (tow && tow.attached) stepTow(tow, s, dt, testHeight);
    else stepFlight(s, input, dt, { atmo, height: testHeight }, sc.assist);
    if ((i + 1) % spec.sampleEvery === 0) sample();
  }
  fs.writeFileSync(path.join(OUT, `${sc.name}.scn`), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, `${sc.name}.csv`), rows.join('\n') + '\n');
  console.log(`${sc.name}: ${rows.length - 1} 行、最終 ${s.onGround ? '接地' : '飛行中'} 高度 ${s.y.toFixed(1)} m 速度 ${s.airspeed.toFixed(1)} m/s`);
}
