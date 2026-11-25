// 機体の3Dモデル（近似形状。実機CADの複製ではありません）。
// 機首は -z、右翼は +x、上は +y。原点＝重心付近、地上では原点が地面から gearH の高さ。
import * as THREE from 'three';

// ---------- 形状ヘルパー ----------
function loftBody(sections, N = 48) {
  const pos = [], uv = [], ind = [];
  sections.forEach(([z, rx, ry, yc = 0], j) => {
    for (let i = 0; i <= N; i++) {
      const a = i / N * Math.PI * 2;
      // 下面をやや平らに（超楕円）
      const c = Math.cos(a), s = Math.sin(a);
      const e = 2.4, cx = Math.sign(c) * Math.abs(c) ** (2 / e), sy = Math.sign(s) * Math.abs(s) ** (2 / e);
      pos.push(cx * rx, yc + sy * ry, z);
      uv.push(j / (sections.length - 1), i / N);
      if (j < sections.length - 1 && i < N) { const k = j * (N + 1) + i; ind.push(k, k + 1, k + N + 1, k + 1, k + N + 2, k + N + 1); }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(ind); g.computeVertexNormals(); return g;
}

// 翼型断面（NACA 4桁風）を翼幅方向に並べた翼。stations: [{x, z (前縁), y, c (翼弦)}]
function airfoilRing(f0, f1, th, camber, M = 18) {
  const pts = [];
  const yt = f => 5 * th * (0.2969 * Math.sqrt(f) - 0.126 * f - 0.3516 * f * f + 0.2843 * f ** 3 - 0.1036 * f ** 4);
  const yc = f => camber * (f < 0.4 ? (2 * 0.4 * f - f * f) / 0.16 : ((1 - 0.8) + 2 * 0.4 * f - f * f) / 0.36);
  for (let i = 0; i <= M; i++) { const f = f0 + (f1 - f0) * (1 - Math.cos(i / M * Math.PI)) / 2; pts.push([f, yc(f) + yt(f)]); }
  for (let i = M - 1; i >= 1; i--) { const f = f0 + (f1 - f0) * (1 - Math.cos(i / M * Math.PI)) / 2; pts.push([f, yc(f) - yt(f)]); }
  return pts;
}
function loftWing(stations, { f0 = 0, f1 = 1, th = 0.13, camber = 0.03, side = 1, hinge = null } = {}) {
  const ring = airfoilRing(f0, f1, th, camber), R = ring.length, pos = [], ind = [];
  stations.forEach(st => {
    for (const [f, y] of ring) {
      let px = st.x * side, py = st.y + y * st.c, pz = st.z + f * st.c;
      if (hinge) { px -= hinge.x * side; py -= hinge.y; pz -= hinge.z; }
      pos.push(px, py, pz);
    }
  });
  for (let j = 0; j < stations.length - 1; j++) for (let i = 0; i < R; i++) {
    const a = j * R + i, b = j * R + (i + 1) % R, c = a + R, d = b + R;
    if (side > 0) ind.push(a, b, c, b, d, c); else ind.push(a, c, b, b, c, d);
  }
  // 両端のふた
  for (const j of [0, stations.length - 1]) {
    const flip = (j === 0) === (side > 0);
    for (let i = 1; i < R - 1; i++) flip ? ind.push(j * R, j * R + i + 1, j * R + i) : ind.push(j * R, j * R + i, j * R + i + 1);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(ind); g.computeVertexNormals();
  return g;
}

function mats() {
  return {
    white: new THREE.MeshPhysicalMaterial({ color: 0xf6f5ef, roughness: 0.22, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.12 }),
    red: new THREE.MeshPhysicalMaterial({ color: 0xb2261d, roughness: 0.3, clearcoat: 0.7 }),
    navy: new THREE.MeshPhysicalMaterial({ color: 0x1f3a8a, roughness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.12 }),
    black: new THREE.MeshStandardMaterial({ color: 0x1d2329, roughness: 0.55 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x15181a, roughness: 0.9 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xb9bec2, roughness: 0.3, metalness: 0.85 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x9fb6c0, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.22, envMapIntensity: 2.2, depthWrite: false, side: THREE.DoubleSide }),
    interior: new THREE.MeshStandardMaterial({ color: 0x2c3136, roughness: 0.85 }),
    cushion: new THREE.MeshStandardMaterial({ color: 0x23395a, roughness: 0.9 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xd9b59a, roughness: 0.7 }),
    helmet: new THREE.MeshStandardMaterial({ color: 0xe7e2d6, roughness: 0.5 })
  };
}

function pilot(m, x, y, z) {
  const g = new THREE.Group(); g.position.set(x, y, z);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.3, 4, 10), m.cushion); torso.position.set(0, 0.05, 0.12); torso.rotation.x = -0.45;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), m.skin); head.position.set(0, 0.38, -0.04);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.118, 16, 10, 0, 6.29, 0, 1.5), m.helmet); cap.position.copy(head.position); cap.position.y += 0.01;
  g.add(torso, head, cap); return g;
}

function wheel(m, r, w) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(r * 0.72, r * 0.28, 10, 24), m.tire); tire.rotation.y = Math.PI / 2;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, w, 16), m.metal); hub.rotation.z = Math.PI / 2;
  g.add(tire, hub); return g;
}

function hinged(group, geo, mat, hinge, axis) {
  const pivot = new THREE.Group(); pivot.position.set(hinge.x, hinge.y, hinge.z);
  const mesh = new THREE.Mesh(geo, mat); pivot.add(mesh); group.add(pivot);
  pivot.userData.axis = axis; return pivot;
}

function decalTexture(lines, w = 1024, h = 128, bg = null) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  for (const l of lines) { g.fillStyle = l.color; g.font = l.font; g.fillText(l.text, l.x, l.y); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

// ---------- 複座練習グライダー ----------
export function makeGlider() {
  const m = mats(), group = new THREE.Group(), parts = {};
  const body = new THREE.Mesh(loftBody([
    [-3.95, 0.02, 0.02, -0.05], [-3.82, 0.2, 0.24, -0.07], [-3.45, 0.32, 0.38, -0.05], [-2.7, 0.37, 0.46, 0], [-1.7, 0.37, 0.47, 0.02],
    [-0.7, 0.33, 0.42, 0.03], [0.3, 0.25, 0.32, 0.06], [1.5, 0.16, 0.22, 0.1], [2.7, 0.11, 0.16, 0.15], [3.8, 0.08, 0.12, 0.2], [4.35, 0.05, 0.08, 0.22]
  ]), m.white);
  group.add(body, interiorShell(body, m));
  // 機首の紺（写真の Duo Discus T）。キャノピーの前まで斜めに切れ上がる
  const noseCap = new THREE.Mesh(loftBody([[-3.96, 0.01, 0.01, -0.05], [-3.83, 0.205, 0.245, -0.07], [-3.62, 0.275, 0.33, -0.06], [-3.4, 0.3, 0.37, -0.05]]), m.navy); group.add(noseCap);
  // 胴体側面の紺の細い線と機種名（左右）
  const gl = decalTexture([{ text: 'Duo Discus T', x: 300, y: 86, color: '#1f3a8a', font: 'italic 64px serif' }]);
  for (const side of [-1, 1]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.018), new THREE.MeshBasicMaterial({ color: 0x1f3a8a, polygonOffset: true, polygonOffsetFactor: -2 }));
    line.position.set(side * 0.372, -0.08, -2.2); line.rotation.y = side * Math.PI / 2; group.add(line);
    const name = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.19), new THREE.MeshBasicMaterial({ map: gl, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    name.position.set(side * 0.372, -0.17, -1.75); name.rotation.y = side * Math.PI / 2; group.add(name);
  }
  // キャノピー（タンデム複座）と内装
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), m.glass);
  canopy.scale.set(0.33, 0.36, 1.45); canopy.position.set(0, 0.28, -2.05); group.add(canopy);
  const tub = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.08, 2.7), m.interior); tub.position.set(0, -0.25, -2.0); group.add(tub);
  group.add(pilot(m, 0, 0.0, -2.55), pilot(m, 0, 0.08, -1.45));
  parts.panel = new THREE.Group(); parts.panel.position.set(0, 0.36, -3.0); group.add(parts.panel);
  parts.eye = new THREE.Vector3(0, 0.52, -2.5);
  // 主翼
  const st = [{ x: 0.3, z: -0.55, y: 0.05, c: 1.38 }, { x: 3.2, z: -0.47, y: 0.27, c: 1.15 }, { x: 6.6, z: -0.32, y: 0.5, c: 0.85 }, { x: 8.25, z: -0.2, y: 0.62, c: 0.52 }, { x: 8.5, z: -0.12, y: 0.66, c: 0.38 }];
  parts.ailerons = [];
  for (const side of [-1, 1]) {
    group.add(new THREE.Mesh(loftWing(st.slice(0, 2), { side }), m.white));
    group.add(new THREE.Mesh(loftWing(st.slice(1), { side, f1: 0.78 }), m.white));
    const hinge = { x: 3.2, y: 0.27, z: -0.47 + 0.78 * 1.15 };
    const ail = hinged(group, loftWing(st.slice(1, 4), { side, f0: 0.78, hinge }), m.white, { x: 3.2 * side, y: 0.27, z: hinge.z }, new THREE.Vector3(1, 0, 0));
    ail.userData.side = side; parts.ailerons.push(ail);
    const tip = new THREE.Mesh(loftWing(st.slice(3), { side }), m.white); group.add(tip);
    // ウイングレット（翼端で上へ折れ曲がる小翼）
    const wl = new THREE.Mesh(loftWing([{ x: 0, z: -0.08, y: 0, c: 0.36 }, { x: 0.42, z: 0.02, y: 0, c: 0.16 }], { th: 0.1, camber: 0 }), m.white);
    wl.rotation.z = Math.PI / 2 - side * 0.25; wl.position.set(side * 8.5, 0.66, 0); group.add(wl);
    // エアブレーキ（上面から立ち上がる板。上端は赤く塗ってある）
    const ab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.02, 0.06), m.red); ab.position.set(side * 2.5, 0.25, -0.05); ab.rotation.z = side * 0.06;
    ab.scale.y = 0.01; group.add(ab); (parts.brakes ||= []).push(ab);
  }
  // 尾翼：T字尾翼
  const fin = new THREE.Mesh(loftWing([{ x: 0.05, z: 3.2, y: 0.25, c: 1.15 }, { x: 1.62, z: 3.78, y: 0.25, c: 0.62 }], { th: 0.11, camber: 0 }), m.white);
  fin.rotation.z = Math.PI / 2; fin.position.set(0.25, 0, 0); group.add(fin);
  const rudderHinge = { x: 0, y: 0.25, z: 4.27 };
  const rud = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.3, 0.38), m.white); rud.position.set(0, 0.7, 0.17);
  parts.rudder = new THREE.Group(); parts.rudder.position.set(rudderHinge.x, rudderHinge.y, rudderHinge.z); parts.rudder.add(rud); group.add(parts.rudder);
  const ts = [{ x: 0.05, z: 3.82, y: 1.6, c: 0.62 }, { x: 1.6, z: 3.95, y: 1.6, c: 0.42 }];
  for (const side of [-1, 1]) group.add(new THREE.Mesh(loftWing(ts, { side, th: 0.1, camber: 0, f1: 0.62 }), m.white));
  parts.elevator = new THREE.Group(); parts.elevator.position.set(0, 1.6, 4.27);
  const elev = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.035, 0.24), m.white); elev.position.z = 0.12; parts.elevator.add(elev); group.add(parts.elevator);
  // 車輪
  const mw = wheel(m, 0.19, 0.12); mw.position.set(0, -0.76, -0.3); group.add(mw); parts.wheels = [mw];
  const nw = wheel(m, 0.1, 0.06); nw.position.set(0, -0.6, -3.1); group.add(nw); parts.wheels.push(nw);
  const tw = wheel(m, 0.07, 0.04); tw.position.set(0, -0.08, 4.25); group.add(tw);
  finish(group);
  return makeHandle(group, parts, m);
}

// ---------- SUPER DIMONA TC100（写真をもとにした近似） ----------
export function makeDimona() {
  const m = mats(), group = new THREE.Group(), parts = {};
  const skin = document.createElement('canvas'); skin.width = 1024; skin.height = 512;
  const c = skin.getContext('2d'); c.fillStyle = '#f6f5ef'; c.fillRect(0, 0, 1024, 512);
  for (const y of [128, 384]) { c.fillStyle = '#8a2821'; c.fillRect(90, y - 7, 860, 13); c.fillRect(90, y + 12, 860, 8); c.fillStyle = '#b4a07c'; c.fillRect(90, y - 15, 860, 4); }
  const tex = new THREE.CanvasTexture(skin); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const bodyMat = new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.22, clearcoat: 0.8, clearcoatRoughness: 0.12 });
  const body = new THREE.Mesh(loftBody([
    [-3.05, 0.24, 0.29, 0], [-2.8, 0.49, 0.43, 0], [-2.1, 0.62, 0.52, 0], [-1.3, 0.68, 0.54, 0], [-0.25, 0.62, 0.47, 0],
    [0.6, 0.45, 0.37, 0.02], [1.7, 0.26, 0.26, 0.06], [2.8, 0.13, 0.16, 0.12], [3.5, 0.07, 0.12, 0.15]
  ]), bodyMat);
  group.add(body, interiorShell(body, m));
  // 並列複座のキャノピーと内装
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), m.glass);
  canopy.scale.set(0.62, 0.55, 1.35); canopy.position.set(0, 0.36, -1.05); group.add(canopy);
  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.1, 1.9), m.interior); tub.position.set(0, -0.25, -1.1); group.add(tub);
  group.add(pilot(m, -0.3, 0.12, -0.85), pilot(m, 0.3, 0.12, -0.85));
  parts.panel = new THREE.Group(); parts.panel.position.set(0, 0.47, -1.5); group.add(parts.panel);
  parts.eye = new THREE.Vector3(-0.3, 0.66, -0.9);
  // 主翼（低翼・テーパー・ウイングレット）
  const st = [{ x: 0.55, z: -0.65, y: -0.18, c: 1.55 }, { x: 4.2, z: -0.5, y: 0.0, c: 1.2 }, { x: 7.7, z: -0.2, y: 0.17, c: 0.78 }, { x: 8.05, z: -0.12, y: 0.19, c: 0.62 }];
  parts.ailerons = []; parts.brakes = [];
  for (const side of [-1, 1]) {
    group.add(new THREE.Mesh(loftWing(st.slice(0, 2), { side, th: 0.15 }), m.white));
    group.add(new THREE.Mesh(loftWing(st.slice(1), { side, th: 0.14, f1: 0.76 }), m.white));
    const hinge = { x: 4.2, y: 0.0, z: -0.5 + 0.76 * 1.2 };
    const ail = hinged(group, loftWing(st.slice(1), { side, th: 0.14, f0: 0.76, hinge }), m.white, { x: 4.2 * side, y: 0, z: hinge.z }, new THREE.Vector3(1, 0, 0));
    ail.userData.side = side; parts.ailerons.push(ail);
    const wl = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.45), m.white); wl.position.set(side * 8.1, 0.42, 0.25); wl.rotation.z = -side * 0.25; group.add(wl);
    const ab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.02, 0.06), m.metal); ab.position.set(side * 2.7, 0.0, 0.05); ab.scale.y = 0.01; group.add(ab); parts.brakes.push(ab);
    // 主脚
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.7, 0.12), m.white); strut.position.set(side * 0.95, -0.6, 0.15); strut.rotation.z = -side * 0.38; group.add(strut);
    const w = wheel(m, 0.27, 0.14); w.position.set(side * 1.08, -0.97, 0.15); group.add(w); (parts.wheels ||= []).push(w);
  }
  // 尾翼：T字尾翼
  const fin = new THREE.Mesh(loftWing([{ x: 0.05, z: 2.55, y: 0.1, c: 0.95 }, { x: 1.57, z: 3.0, y: 0.1, c: 0.45 }], { th: 0.1, camber: 0 }), m.white);
  fin.rotation.z = Math.PI / 2; fin.position.set(0.1, 0, 0); group.add(fin);
  parts.rudder = new THREE.Group(); parts.rudder.position.set(0, 0.15, 3.48);
  const rud = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.35, 0.32), m.white); rud.position.set(0, 0.68, 0.14); parts.rudder.add(rud); group.add(parts.rudder);
  for (const side of [-1, 1]) group.add(new THREE.Mesh(loftWing([{ x: 0.05, z: 2.95, y: 1.55, c: 0.58 }, { x: 1.65, z: 3.08, y: 1.55, c: 0.42 }], { side, th: 0.1, camber: 0, f1: 0.62 }), m.white));
  parts.elevator = new THREE.Group(); parts.elevator.position.set(0, 1.55, 3.35);
  const elev = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.035, 0.24), m.white); elev.position.z = 0.12; parts.elevator.add(elev); group.add(parts.elevator);
  // 前輪
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.6, 0.08), m.metal); leg.position.set(0, -0.68, -2.35); group.add(leg);
  const nw = wheel(m, 0.21, 0.12); nw.position.set(0, -1.04, -2.35); group.add(nw); parts.wheels.push(nw);
  // スピナーとプロペラ
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 28), m.white); spinner.rotation.x = -Math.PI / 2; spinner.position.z = -3.28; group.add(spinner);
  parts.prop = new THREE.Group(); parts.prop.position.z = -3.1; group.add(parts.prop);
  for (const sign of [-1, 1]) {
    // 白いプロペラで、先端だけ赤（写真の機体）
    const blade = new THREE.Group();
    blade.add(new THREE.Mesh(loftWing([{ x: 0.08, z: -0.07, y: 0, c: 0.15 }, { x: 0.74, z: -0.045, y: 0, c: 0.1 }], { th: 0.12, camber: 0.02 }), m.white));
    blade.add(new THREE.Mesh(loftWing([{ x: 0.74, z: -0.045, y: 0, c: 0.1 }, { x: 0.86, z: -0.04, y: 0, c: 0.09 }], { th: 0.12, camber: 0.02 }), m.red));
    blade.rotation.z = sign > 0 ? Math.PI / 2 : -Math.PI / 2; blade.rotation.y = 0.25 * sign; parts.prop.add(blade);
  }
  parts.disc = new THREE.Mesh(new THREE.CircleGeometry(0.9, 40), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  parts.disc.position.z = -3.12; group.add(parts.disc);
  // 機体の文字（写真の配置を参考に左右へ）
  const lt = decalTexture([{ text: 'TC100 DIMONA', x: 15, y: 83, color: '#81251f', font: 'italic bold 68px sans-serif' }, { text: 'SUPER', x: 760, y: 76, color: '#81251f', font: 'bold 34px sans-serif' }]);
  for (const side of [-1, 1]) {
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(1.85, 0.23), new THREE.MeshBasicMaterial({ map: lt, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    decal.position.set(side * 0.69, -0.04, -1.27); decal.rotation.y = side * Math.PI / 2; group.add(decal);
  }
  finish(group);
  return makeHandle(group, parts, m);
}

// ---------- 曳航機（汎用の低翼単発機） ----------
export function makeTowPlane() {
  const m = mats(), group = new THREE.Group(), parts = {};
  const cream = new THREE.MeshPhysicalMaterial({ color: 0xf3e7c8, roughness: 0.3, clearcoat: 0.6 });
  group.add(new THREE.Mesh(loftBody([[-3.2, 0.32, 0.36, 0], [-2.6, 0.55, 0.58, 0], [-1.4, 0.6, 0.68, 0.05], [0, 0.52, 0.6, 0.05], [1.6, 0.3, 0.36, 0.12], [3.3, 0.12, 0.16, 0.22], [3.7, 0.06, 0.1, 0.24]]), m.red));
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), m.glass); canopy.scale.set(0.5, 0.45, 1.1); canopy.position.set(0, 0.45, -0.7); group.add(canopy);
  group.add(pilot(m, 0, 0.15, -0.6));
  const st = [{ x: 0.5, z: -1.0, y: -0.3, c: 1.6 }, { x: 5.3, z: -0.8, y: 0.05, c: 1.2 }];
  for (const side of [-1, 1]) group.add(new THREE.Mesh(loftWing(st, { side, th: 0.15 }), cream));
  group.add(new THREE.Mesh(loftWing([{ x: 0.05, z: 2.7, y: 0.3, c: 0.9 }, { x: 1.7, z: 2.9, y: 0.3, c: 0.6 }], { side: 1, th: 0.1, camber: 0 }), cream));
  group.add(new THREE.Mesh(loftWing([{ x: 0.05, z: 2.7, y: 0.3, c: 0.9 }, { x: 1.7, z: 2.9, y: 0.3, c: 0.6 }], { side: -1, th: 0.1, camber: 0 }), cream));
  const fin = new THREE.Mesh(loftWing([{ x: 0, z: 2.6, y: 0.2, c: 1.1 }, { x: 1.4, z: 3.1, y: 0.2, c: 0.6 }], { th: 0.1, camber: 0 }), m.red); fin.rotation.z = Math.PI / 2; fin.position.x = 0.2; group.add(fin);
  for (const side of [-1, 1]) { const w = wheel(m, 0.3, 0.16); w.position.set(side * 1.3, -1.15, -0.6); group.add(w); }
  const tw = wheel(m, 0.12, 0.06); tw.position.set(0, -0.2, 3.4); group.add(tw);
  parts.prop = new THREE.Group(); parts.prop.position.z = -3.3; group.add(parts.prop);
  for (const sign of [-1, 1]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.0, 0.04), m.black); b.position.y = sign * 0.55; parts.prop.add(b); }
  parts.disc = new THREE.Mesh(new THREE.CircleGeometry(1.1, 40), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
  parts.disc.position.z = -3.32; group.add(parts.disc);
  finish(group);
  return makeHandle(group, parts, m);
}

// 胴体の内壁（外からは見えず、コックピット視点で内装として見える）
function interiorShell(body, m) {
  const g = body.geometry.clone(); g.scale(0.97, 0.97, 0.995);
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x3a4045, roughness: 0.9, side: THREE.BackSide }));
  mesh.castShadow = false; return mesh;
}

function finish(group) {
  group.rotation.order = 'YXZ';
  group.traverse(o => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });
}

function makeHandle(group, parts, m) {
  return {
    group, parts,
    // s: 飛行状態（舵面・エアブレーキ・車輪・プロペラ）
    animate(s, dt, rpm = 0) {
      for (const a of parts.ailerons || []) a.rotation.x = -s.aileron * 0.35 * a.userData.side;
      if (parts.elevator) parts.elevator.rotation.x = s.elevator * 0.35;
      if (parts.rudder) parts.rudder.rotation.y = -s.rudder * 0.45;
      for (const b of parts.brakes || []) { const k = b.userData.k = (b.userData.k || 0) + ((s.brake ? 1 : 0) - (b.userData.k || 0)) * Math.min(1, dt * 3); b.scale.y = 0.01 + k * 9; b.position.y = (b.userData.y0 ??= b.position.y) + k * 0.09; }
      for (const w of parts.wheels || []) w.rotation.x -= (s.wheelSpinDelta || 0);
      if (parts.prop) {
        parts.prop.rotation.z += dt * rpm * 0.10472 * 0.35;
        const blur = THREE.MathUtils.clamp((rpm - 900) / 1500, 0, 1);
        parts.disc.material.opacity = blur * 0.16;
        parts.prop.visible = blur < 0.98;
      }
    }
  };
}
