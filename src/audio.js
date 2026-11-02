// 効果音：風切り音（対気速度）、エンジン（回転数）、車輪の転がり、昇降計の電子音。WebAudio で合成。
export function makeAudio() {
  let ctx, master, windGain, windFilter, engGain, eng1, eng2, engFilter, rollGain, varioOsc, varioGain, enabled = true, lastBeep = 0;
  function noiseBuffer() {
    const len = ctx.sampleRate * 2, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    let last = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    return b;
  }
  function unlock() {
    try {
      if (!ctx) {
        ctx = new AudioContext(); master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
        const nb = noiseBuffer();
        const src = ctx.createBufferSource(); src.buffer = nb; src.loop = true;
        windFilter = ctx.createBiquadFilter(); windFilter.type = 'bandpass'; windFilter.Q.value = 0.7;
        windGain = ctx.createGain(); windGain.gain.value = 0; src.connect(windFilter); windFilter.connect(windGain); windGain.connect(master); src.start();
        const src2 = ctx.createBufferSource(); src2.buffer = nb; src2.loop = true; src2.playbackRate.value = 0.5;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160;
        rollGain = ctx.createGain(); rollGain.gain.value = 0; src2.connect(lp); lp.connect(rollGain); rollGain.connect(master); src2.start();
        eng1 = ctx.createOscillator(); eng1.type = 'sawtooth'; eng2 = ctx.createOscillator(); eng2.type = 'square';
        engFilter = ctx.createBiquadFilter(); engFilter.type = 'lowpass'; engFilter.frequency.value = 600;
        engGain = ctx.createGain(); engGain.gain.value = 0;
        const g2 = ctx.createGain(); g2.gain.value = 0.35;
        eng1.connect(engFilter); eng2.connect(g2); g2.connect(engFilter); engFilter.connect(engGain); engGain.connect(master); eng1.start(); eng2.start();
        varioOsc = ctx.createOscillator(); varioOsc.type = 'sine'; varioGain = ctx.createGain(); varioGain.gain.value = 0;
        varioOsc.connect(varioGain); varioGain.connect(master); varioOsc.start();
      }
      ctx.resume().catch(() => {});
    } catch { /* 音なしで継続 */ }
  }
  function hush() { if (ctx) master.gain.setTargetAtTime(0, ctx.currentTime, 0.02); }
  return {
    unlock, hush,
    toggle() { enabled = !enabled; if (enabled) unlock(); else hush(); return enabled; },
    get enabled() { return enabled; },
    update({ running, airspeed, rpm, rolling, te, cockpit, varioOn }) {
      if (!ctx) return;
      const now = ctx.currentTime;
      master.gain.setTargetAtTime(enabled && running ? 0.5 : 0, now, 0.05);
      const w = Math.min(1, airspeed / 45);
      windGain.gain.setTargetAtTime(w * w * (cockpit ? 0.18 : 0.32), now, 0.1);
      windFilter.frequency.setTargetAtTime(250 + airspeed * 28, now, 0.1);
      const on = rpm > 300;
      engGain.gain.setTargetAtTime(on ? 0.05 + 0.1 * Math.min(1, rpm / 5500) : 0, now, 0.15);
      // Rotax 912：4気筒 4ストローク、減速比 2.43 → 点火周波数 = rpm/60*2
      eng1.frequency.setTargetAtTime(Math.max(20, rpm / 60 * 2), now, 0.1);
      eng2.frequency.setTargetAtTime(Math.max(10, rpm / 60 / 2.43 * 2), now, 0.1);
      engFilter.frequency.setTargetAtTime(300 + rpm * 0.25, now, 0.1);
      rollGain.gain.setTargetAtTime(rolling ? Math.min(0.5, airspeed / 20) : 0, now, 0.05);
      // 昇降計：上昇でピッ音（強いほど高く速く）、強い下降で低い連続音
      if (!varioOn) { varioGain.gain.setTargetAtTime(0, now, 0.02); return; }
      if (te > 0.25) {
        const interval = Math.max(0.12, 0.6 - te * 0.09);
        varioOsc.frequency.setTargetAtTime(600 + Math.min(5, te) * 140, now, 0.02);
        if (now - lastBeep > interval) {
          lastBeep = now;
          varioGain.gain.cancelScheduledValues(now); varioGain.gain.setValueAtTime(0.0, now);
          varioGain.gain.linearRampToValueAtTime(0.16, now + 0.01); varioGain.gain.setValueAtTime(0.16, now + interval * 0.45); varioGain.gain.linearRampToValueAtTime(0, now + interval * 0.5);
        }
      } else if (te < -2.5) {
        varioOsc.frequency.setTargetAtTime(330 + te * 12, now, 0.05); varioGain.gain.setTargetAtTime(0.05, now, 0.05);
      } else if (now - lastBeep > 0.7) varioGain.gain.setTargetAtTime(0, now, 0.03);
    }
  };
}
