// 入力：キーボード（滑らかに舵を当てる）、ゲームパッド／ジョイスティック、マウス視点。
export class Input {
  constructor() {
    this.keys = {}; this.roll = 0; this.pitch = 0; this.yaw = 0; this.throttleAxis = null;
    this.pressed = new Set(); this.padPrev = []; this.padName = '';
    this.look = { yaw: 0, pitch: 0, zoom: 1, dragging: false };
    addEventListener('keydown', e => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys[e.code] = true;
    });
    addEventListener('keyup', e => { this.keys[e.code] = false; });
    addEventListener('blur', () => { this.keys = {}; });
    const canvas = document.getElementById('scene');
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => { if (e.button === 2 || e.button === 0) { this.look.dragging = true; canvas.setPointerCapture(e.pointerId); } });
    canvas.addEventListener('pointerup', e => { this.look.dragging = false; canvas.releasePointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => {
      if (!this.look.dragging) return;
      this.look.yaw -= e.movementX * 0.005; this.look.pitch = Math.max(-1.2, Math.min(1.2, this.look.pitch - e.movementY * 0.004));
    });
    canvas.addEventListener('dblclick', () => { this.look.yaw = 0; this.look.pitch = 0; this.look.zoom = 1; });
    canvas.addEventListener('wheel', e => { this.look.zoom = Math.max(0.35, Math.min(4, this.look.zoom * (1 + Math.sign(e.deltaY) * 0.1))); }, { passive: true });
  }

  // 1 フレームに 1 回呼ぶ。押された瞬間のキー集合を返す。
  poll(dt) {
    const k = this.keys;
    const tr = (k.ArrowRight ? 1 : 0) - (k.ArrowLeft ? 1 : 0);
    const tp = (k.ArrowDown ? 1 : 0) - (k.ArrowUp ? 1 : 0);
    const ty = (k.KeyX ? 1 : 0) - (k.KeyZ ? 1 : 0);
    // キーボードは舵を徐々に当て、離すと速めに戻す
    const ramp = (v, t, up, down) => { const r = (t === 0 || Math.sign(t) !== Math.sign(v)) ? down : up; return v + Math.max(-r * dt, Math.min(r * dt, t - v)); };
    this.roll = ramp(this.roll, tr, 2.5, 5); this.pitch = ramp(this.pitch, tp, 1.8, 4); this.yaw = ramp(this.yaw, ty, 3, 5);
    // ゲームパッド
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const pad = pads[0];
    const events = new Set(this.pressed); this.pressed.clear();
    if (pad) {
      this.padName = pad.id;
      const dz = v => Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92;
      const ax = pad.axes;
      if (Math.abs(dz(ax[0])) > 0 || Math.abs(dz(ax[1])) > 0) { this.roll = dz(ax[0]); this.pitch = dz(ax[1]); }
      if (ax.length > 2 && pad.mapping !== 'standard' && Math.abs(dz(ax[2])) > 0) this.yaw = dz(ax[2]);
      if (pad.mapping === 'standard') {
        const rt = pad.buttons[7]?.value ?? 0; if (rt > 0.02 || this.throttleAxis !== null) this.throttleAxis = rt;
        if (Math.abs(dz(ax[2] ?? 0)) > 0) this.yaw = dz(ax[2]);
      } else if (ax.length > 3) this.throttleAxis = (1 - ax[3]) / 2;   // ジョイスティックのスロットル軸
      const map = { 0: 'KeyB', 1: 'KeyR', 3: 'KeyC', 2: 'KeyE', 9: 'KeyP', 4: 'BracketLeft', 5: 'BracketRight' };
      pad.buttons.forEach((b, i) => { if (b.pressed && !this.padPrev[i] && map[i]) events.add(map[i]); this.padPrev[i] = b.pressed; });
    }
    return events;
  }
  clear() { this.keys = {}; this.roll = this.pitch = this.yaw = 0; }
}
