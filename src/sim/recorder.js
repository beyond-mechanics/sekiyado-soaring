// フライト録画：手動録画（V）と直近 30 秒のリングバッファ（Shift+V）。
// カメラ・機体・曳航機の位置と姿勢、太陽方向などを JSON に保存する（scripts/blender_import_flight.py で読み込める）。
// 座標系は three.js と同じ（x=東, y=上, z=南、原点は滑走路中心）。
const r3 = v => Math.round(v * 1000) / 1000;
const r5 = v => Math.round(v * 100000) / 100000;
const vec = v => [r3(v.x), r3(v.y), r3(v.z)];
const quat = q => [r5(q.x), r5(q.y), r5(q.z), r5(q.w)];

export class FlightRecorder {
  constructor({ fps = 60, clipSeconds = 30, maxMinutes = 30 } = {}) {
    this.fps = fps; this.step = 1 / fps; this.clipSeconds = clipSeconds;
    this.maxFrames = Math.round(maxMinutes * 60 * fps); // 長時間の録画でメモリを使い切らないよう上限を設ける
    this.reset();
  }

  reset() {
    this.recording = false; this.ring = []; this.manual = [];
    this.simTime = 0; this.acc = 0; this.recStart = 0; this.meta = null;
  }

  setMeta({ settings, atmo, env, version }) {
    this.meta = {
      appVersion: version,
      environment: {
        timeOfDay: Number(settings.timeOfDay), visibility: Number(settings.visibility),
        windDir: Number(settings.windDir), windSpeed: Number(settings.windSpeed),
        sunDir: [r5(env.sunDir.x), r5(env.sunDir.y), r5(env.sunDir.z)], cloudBase: atmo.cloudBase,
        thermals: atmo.thermals.map(t => ({ x: r3(t.x), z: r3(t.z), r: r3(t.r), w: r3(t.w) }))
      },
      aircraft: { type: settings.aircraft, mode: settings.mode }
    };
  }

  start() { this.manual = []; this.recording = true; this.recStart = this.simTime; }
  stop() { this.recording = false; const p = this.payload(this.manual); this.manual = []; return p; }
  duration() { return this.recording ? Math.max(0, this.simTime - this.recStart) : 0; }

  // 毎フレーム（飛行中・一時停止していないとき）呼ぶ。描画の fps に関係なく約 1/fps 秒ごとに 1 コマ記録する。
  capture(dt, { camera, camMode, plane, state, agl, towGroup, towAttached }) {
    this.simTime += dt; this.acc += dt;
    if (this.acc < this.step) return;
    this.acc = Math.min(this.acc - this.step, this.step);
    const f = {
      t: r3(this.simTime),
      cam: { pos: vec(camera.position), quat: quat(camera.quaternion), fov: r3(camera.fov), mode: camMode },
      plane: {
        pos: vec(plane.position), quat: quat(plane.quaternion),
        airspeed: r3(state.airspeed), agl: r3(agl), te: r3(state.te), rpm: Math.round(state.engine?.rpm || 0),
        aileron: r3(state.aileron), elevator: r3(state.elevator), rudder: r3(state.rudder), brake: r3(state.brake), onGround: !!state.onGround
      },
      tow: towGroup?.visible ? { pos: vec(towGroup.position), quat: quat(towGroup.quaternion), attached: !!towAttached } : null
    };
    this.ring.push(f);
    let drop = 0; while (drop < this.ring.length - 2 && this.ring[drop].t < this.simTime - this.clipSeconds) drop++;
    if (drop) this.ring.splice(0, drop);
    if (this.recording) {
      this.manual.push(f);
      if (this.manual.length >= this.maxFrames) this.recording = false; // 呼び出し側が stop() で保存する
    }
  }

  clip(seconds = this.clipSeconds) {
    if (!this.ring.length) return null;
    const cutoff = this.ring[this.ring.length - 1].t - seconds;
    return this.payload(this.ring.filter(f => f.t >= cutoff));
  }

  payload(frames) {
    if (frames.length < 2) return null;
    const t0 = frames[0].t;
    return {
      schemaVersion: 1,
      appVersion: this.meta?.appVersion,
      recordedAt: new Date().toISOString(),
      origin: { lat: 36.0157, lon: 139.8166, axes: 'three.js: x=east, y=up, z=south (north = -z); meters' },
      fps: this.fps,
      duration: r3(frames[frames.length - 1].t - t0),
      environment: this.meta?.environment ?? {},
      aircraft: this.meta?.aircraft ?? {},
      frames: frames.map(f => ({ ...f, t: r3(f.t - t0) }))
    };
  }

  // ダウンロードとして保存（デスクトップ版はダウンロードフォルダーへ自動保存）
  static save(payload, kind) {
    if (!payload) return null;
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const name = `sekiyado_${kind}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return name;
  }
}
