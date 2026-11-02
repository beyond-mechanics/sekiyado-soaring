// コックピットの計器パネル（キャンバスに描いた丸型計器）とヨーストリング。
import * as THREE from 'three';

export function makeCockpit(handle, type) {
  const W = 1024, H = 360, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const width = type === 'dimona' ? 0.9 : 0.5, height = width * H / W;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25, depthTest: false }));
  panel.renderOrder = 20;
  panel.rotation.x = -0.35;
  handle.parts.panel.add(panel);
  // 計器板の縁（グレアシールド）
  const shield = new THREE.Mesh(new THREE.BoxGeometry(width + 0.04, 0.02, 0.07), new THREE.MeshStandardMaterial({ color: 0x15191c, roughness: 0.9, depthTest: false }));
  shield.renderOrder = 21; shield.position.set(0, height / 2 * Math.cos(0.35) + 0.01, -height / 2 * Math.sin(0.35) - 0.02); handle.parts.panel.add(shield);
  // ヨーストリング：キャノピー前方の赤い毛糸
  const yaw = new THREE.Group(); yaw.position.set(type === 'dimona' ? -0.3 : 0, type === 'dimona' ? 0.62 : 0.5, type === 'dimona' ? -0.25 : -0.45); handle.parts.panel.add(yaw);
  const yarn = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.002, 0.12), new THREE.MeshBasicMaterial({ color: 0xd8342a })); yarn.position.z = 0.06; yaw.add(yarn);
  panel.visible = shield.visible = yaw.visible = false;

  function dial(cx, cy, r, label, ticks, fmt, value, min, max, start = -225, sweep = 270, color = '#f2f2ea') {
    g.save(); g.translate(cx, cy);
    g.fillStyle = '#0d0f11'; g.beginPath(); g.arc(0, 0, r + 8, 0, 6.29); g.fill();
    g.fillStyle = '#1b1f22'; g.beginPath(); g.arc(0, 0, r, 0, 6.29); g.fill();
    g.strokeStyle = '#d9d9d0'; g.fillStyle = '#e8e8de'; g.font = 'bold 19px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const t of ticks) {
      const a = (start + (t.v - min) / (max - min) * sweep) * Math.PI / 180;
      g.lineWidth = t.major ? 3 : 1.5; g.beginPath(); g.moveTo(Math.cos(a) * r * (t.major ? 0.8 : 0.87), Math.sin(a) * r * (t.major ? 0.8 : 0.87)); g.lineTo(Math.cos(a) * r * 0.96, Math.sin(a) * r * 0.96); g.stroke();
      if (t.label !== undefined) g.fillText(t.label, Math.cos(a) * r * 0.64, Math.sin(a) * r * 0.64);
    }
    for (const arc of fmt.arcs || []) {
      g.strokeStyle = arc.color; g.lineWidth = 6; g.beginPath();
      g.arc(0, 0, r * 0.93, (start + (arc.from - min) / (max - min) * sweep) * Math.PI / 180, (start + (arc.to - min) / (max - min) * sweep) * Math.PI / 180); g.stroke();
    }
    g.fillStyle = '#9aa0a0'; g.font = '13px sans-serif'; g.fillText(label, 0, r * 0.38);
    if (fmt.text) { g.fillStyle = '#e8e8de'; g.font = 'bold 15px sans-serif'; g.fillText(fmt.text, 0, r * 0.62); }
    const v = Math.max(min, Math.min(max, value)), a = (start + (v - min) / (max - min) * sweep) * Math.PI / 180;
    g.strokeStyle = color; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(-Math.cos(a) * r * 0.15, -Math.sin(a) * r * 0.15); g.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85); g.stroke();
    g.fillStyle = '#333'; g.beginPath(); g.arc(0, 0, 8, 0, 6.29); g.fill();
    g.restore();
  }
  const range = (a, b, step, majorEvery, label) => { const t = []; for (let v = a; v <= b + 1e-6; v += step) { const major = Math.abs(v / majorEvery - Math.round(v / majorEvery)) < 1e-6; t.push({ v, major, label: major && label ? label(v) : undefined }); } return t; };
  const asiT = range(40, 280, 10, 40, v => v), altT = range(0, 1000, 20, 100, v => v / 100), varT = range(-5, 5, 0.5, 1, v => Math.abs(v)), rpmT = range(0, 6000, 250, 1000, v => v / 1000);

  return {
    setVisible(v) { panel.visible = shield.visible = yaw.visible = v; },
    update(s, agl, alt, units) {
      g.fillStyle = '#25292c'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#2d3236'; g.fillRect(10, 10, W - 20, H - 20);
      const r = 120, y = 180;
      const kmh = s.airspeed * 3.6;
      dial(150, y, r, 'km/h', asiT, { arcs: [{ from: 65, to: 90, color: '#e6e6e6' }, { from: 90, to: 200, color: '#4caf50' }, { from: 200, to: 280, color: '#e3c54a' }] }, kmh, 40, 280, -225, 315);
      dial(410, y, r, 'TE VARIO m/s', varT, { text: (s.te >= 0 ? '+' : '') + s.te.toFixed(1) }, s.te, -5, 5, 180, 180, '#f5f0c0');
      const alt100 = (alt % 1000);
      dial(670, y, r, 'ALT ×100 m', altT, { text: Math.round(alt) + ' m' }, alt100, 0, 1000, -90, 360);
      if (type === 'dimona') dial(910, y, 100, 'RPM ×1000', rpmT, { arcs: [{ from: 1400, to: 5500, color: '#4caf50' }, { from: 5500, to: 5800, color: '#e3c54a' }] }, s.engine.rpm, 0, 6000, -225, 270);
      else {
        // コンパス
        g.save(); g.translate(910, y); g.fillStyle = '#0d0f11'; g.beginPath(); g.arc(0, 0, 92, 0, 6.29); g.fill();
        g.rotate(-s.heading); g.fillStyle = '#e8e8de'; g.font = 'bold 22px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        ['N', 'E', 'S', 'W'].forEach((d, i) => { g.save(); g.rotate(i * Math.PI / 2); g.fillText(d, 0, -64); g.restore(); });
        for (let i = 0; i < 36; i++) { g.save(); g.rotate(i * Math.PI / 18); g.fillRect(-1, -88, 2, i % 3 ? 8 : 14); g.restore(); }
        g.restore(); g.fillStyle = '#f5a623'; g.fillRect(908, y - 92, 4, 22);
      }
      tex.needsUpdate = true;
      yaw.rotation.y = -s.beta * 6 + (s.onGround ? 0 : Math.sin(s.time * 13) * 0.05);
      yaw.rotation.x = s.airspeed < 10 ? 0.9 : 0;
    }
  };
}
