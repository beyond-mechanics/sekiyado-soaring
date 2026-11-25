// 樹木の手続き型モデル：葉の付いた小枝を描いた板（カード）を樹冠の形に重ね、幹と枝を付ける。
//   broad   … 広葉樹（ケヤキ・エノキ・コナラなど。屋敷林・河畔林・平地林）
//   conifer … 杉（細い円錐形の樹冠。屋敷林・植林）
//   bamboo  … 竹の株（屋敷まわりの竹林）
// 1 枚のテクスチャ（葉 3 種＋樹皮＋竹の稈）を全種で共有し、種類・距離ごとに 1 つの InstancedMesh で描く。
// 形は高さ 1 の単位で作り、インスタンスの拡大で樹高に合わせる。
import * as THREE from 'three';

const W = 1024, H = 256;           // アトラス：葉（広葉・杉・竹）各 256 幅、樹皮 128、竹の稈 128
const REG = { broad: [0, 0.25], conifer: [0.25, 0.5], bamboo: [0.5, 0.75], bark: [0.75, 0.875], culm: [0.875, 1] };

let seed = 7771;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

// ---- テクスチャ ----
function paintAtlas() {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  const hsl = (h, s, l) => `hsl(${h},${s}%,${l}%)`;

  // 広葉樹：小枝から放射状に付く卵形の葉の房。上ほど明るく
  g.save(); g.beginPath(); g.rect(0, 0, 256, 256); g.clip();
  g.strokeStyle = '#4a3b2c'; g.lineWidth = 2;
  for (let i = 0; i < 9; i++) { const a = rnd() * 6.28; g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.cos(a) * 95, 128 + Math.sin(a) * 95); g.stroke(); }
  for (let i = 0; i < 520; i++) {
    const a = rnd() * 6.28, r = 112 * Math.sqrt(rnd()), x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r * 0.92;
    g.save(); g.translate(x, y); g.rotate(a + (rnd() - 0.5) * 1.4);
    g.fillStyle = hsl(60 + rnd() * 30, 8 + rnd() * 10, 40 + (1 - y / 256) * 24 + rnd() * 12);  // 色はインスタンスで付けるので、ほぼ無彩色
    g.beginPath(); g.ellipse(0, 0, 7 + rnd() * 5, 3.2 + rnd() * 2.2, 0, 0, 6.28); g.fill();
    g.restore();
  }
  g.restore();

  // 杉：中軸から細かい針葉が出た房を、下向きに垂れる扇形に重ねる
  g.save(); g.translate(256, 0); g.beginPath(); g.rect(0, 0, 256, 256); g.clip();
  for (let k = 0; k < 34; k++) {
    const x0 = 128 + (rnd() - 0.5) * 60, y0 = 20 + rnd() * 70, a = Math.PI / 2 + (rnd() - 0.5) * 1.5, len = 90 + rnd() * 80;
    const l = 32 + rnd() * 22;
    g.strokeStyle = hsl(95 + rnd() * 15, 28 + rnd() * 14, l * 0.7); g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + Math.cos(a) * len, y0 + Math.sin(a) * len); g.stroke();
    for (let s = 0; s < len; s += 2.2) {
      const px = x0 + Math.cos(a) * s, py = y0 + Math.sin(a) * s, w = (1 - s / len) * 11 + 4;
      g.strokeStyle = hsl(92 + rnd() * 18, 28 + rnd() * 16, l + rnd() * 10); g.lineWidth = 1.6;
      for (const sgn of [-1, 1]) { const b = a + sgn * (0.9 + rnd() * 0.4); g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(b) * w, py + Math.sin(b) * w); g.stroke(); }
    }
  }
  g.restore();

  // 竹：細い小枝から垂れる笹形の葉
  g.save(); g.translate(512, 0); g.beginPath(); g.rect(0, 0, 256, 256); g.clip();
  for (let k = 0; k < 14; k++) {
    const x0 = 20 + rnd() * 216, y0 = 10 + rnd() * 80;
    g.strokeStyle = '#7d8a4a'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + (rnd() - 0.5) * 60, y0 + 50 + rnd() * 50); g.stroke();
    for (let i = 0; i < 11; i++) {
      const x = x0 + (rnd() - 0.5) * 70, y = y0 + rnd() * 120, a = Math.PI / 2 + (rnd() - 0.5) * 1.6, L = 30 + rnd() * 24;
      g.save(); g.translate(x, y); g.rotate(a);
      g.fillStyle = hsl(70 + rnd() * 18, 40 + rnd() * 18, 50 + rnd() * 20);
      g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(L * 0.4, -4.2, L, 0); g.quadraticCurveTo(L * 0.4, 4.2, 0, 0); g.fill();
      g.restore();
    }
  }
  g.restore();

  // 樹皮：縦の筋
  g.fillStyle = '#6b5a48'; g.fillRect(768, 0, 128, 256);
  for (let i = 0; i < 160; i++) { g.fillStyle = hsl(25 + rnd() * 10, 12 + rnd() * 12, 22 + rnd() * 26); g.fillRect(768 + rnd() * 128, rnd() * 256, 1 + rnd() * 3, 20 + rnd() * 80); }
  // 竹の稈：黄緑に節
  g.fillStyle = '#8f9d55'; g.fillRect(896, 0, 128, 256);
  for (let i = 0; i < 40; i++) { g.fillStyle = hsl(68 + rnd() * 10, 30 + rnd() * 15, 40 + rnd() * 18); g.fillRect(896 + rnd() * 128, rnd() * 256, 2 + rnd() * 4, 30 + rnd() * 60); }
  for (let y = 18; y < 256; y += 34) { g.fillStyle = '#6d7840'; g.fillRect(896, y, 128, 3); }

  // 透明画素の色を葉の平均色で埋める（ミップマップで縁が黒ずまないように）
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (const [u0, u1] of [REG.broad, REG.conifer, REG.bamboo]) {
    const x0 = u0 * W, x1 = u1 * W; let r = 0, gg = 0, b = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) { const k = (y * W + x) * 4; if (d[k + 3] > 200) { r += d[k]; gg += d[k + 1]; b += d[k + 2]; n++; } }
    r /= n; gg /= n; b /= n;
    for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) { const k = (y * W + x) * 4; if (d[k + 3] < 8) { d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = 0; } }
  }
  for (let y = 0; y < H; y++) for (let x = 768; x < W; x++) d[(y * W + x) * 4 + 3] = 255;
  const tex = new THREE.DataTexture(d, W, H, THREE.RGBAFormat);
  tex.flipY = true; tex.colorSpace = THREE.SRGBColorSpace; tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---- 形 ----
class Builder {
  constructor() { this.p = []; this.n = []; this.uv = []; this.i = []; }
  get count() { return this.p.length / 3; }
  // 中心 c、半幅ベクトル u・v の四角形。法線は nf(角の位置) で与える（樹冠の丸みを出すため）
  quad(c, u, v, reg, nf) {
    const b = this.count, [u0, u1] = REG[reg], m = 0.004;
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const q = c.clone().addScaledVector(u, s).addScaledVector(v, t);
      this.p.push(q.x, q.y, q.z); const n = nf(q); this.n.push(n.x, n.y, n.z);
      this.uv.push(u0 + m + (u1 - u0 - 2 * m) * (s + 1) / 2, (t + 1) / 2 * 0.98 + 0.01);
    }
    this.i.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  // 管（幹・枝・竹の稈）。pts に沿って半径 r0→r1
  tube(pts, r0, r1, seg, reg) {
    const [u0, u1] = REG[reg], up = new THREE.Vector3(0, 1, 0), base = this.count;
    pts.forEach((p, k) => {
      const t = k / (pts.length - 1), r = r0 + (r1 - r0) * t;
      const dir = (k < pts.length - 1 ? pts[k + 1].clone().sub(p) : p.clone().sub(pts[k - 1])).normalize();
      const a = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : up; const s1 = new THREE.Vector3().crossVectors(dir, a).normalize(), s2 = new THREE.Vector3().crossVectors(dir, s1);
      for (let j = 0; j <= seg; j++) {
        const ang = j / seg * Math.PI * 2, n = s1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(s2, Math.sin(ang));
        const q = p.clone().addScaledVector(n, r);
        this.p.push(q.x, q.y, q.z); this.n.push(n.x, n.y, n.z); this.uv.push(u0 + (u1 - u0) * j / seg, t);
      }
    });
    for (let k = 0; k < pts.length - 1; k++) for (let j = 0; j < seg; j++) {
      const a = base + k * (seg + 1) + j, b = a + seg + 1;
      this.i.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.i); g.computeBoundingSphere(); return g;
  }
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
function randomPerp(n) {
  const a = Math.abs(n.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(n, a).normalize(), v = new THREE.Vector3().crossVectors(n, u);
  const t = rnd() * Math.PI * 2; return [u.clone().multiplyScalar(Math.cos(t)).addScaledVector(v, Math.sin(t)), u.clone().multiplyScalar(-Math.sin(t)).addScaledVector(v, Math.cos(t))];
}
// 楕円体の外向き法線（少し上向きに寄せて、上面を明るく）
const ellN = (c, r) => q => V((q.x - c.x) / r.x / r.x, (q.y - c.y) / r.y / r.y + 0.8, (q.z - c.z) / r.z / r.z).normalize();

function broadTree(cards, branches, seg, size) {
  const b = new Builder(), c = V(0, 0.63, 0), r = V(0.34, 0.27, 0.34), nf = ellN(c, r);
  b.tube([V(0, 0, 0), V(0.01, 0.3, 0), V(0, 0.6, 0.01)], 0.03, 0.016, seg, 'bark');
  for (let k = 0; k < branches; k++) {
    const a = k / branches * 6.28 + rnd(), y0 = 0.32 + rnd() * 0.18, e = V(Math.cos(a) * 0.22, 0.62 + rnd() * 0.12, Math.sin(a) * 0.22);
    b.tube([V(0, y0, 0), V(e.x * 0.5, (y0 + e.y) / 2 + 0.03, e.z * 0.5), e], 0.012, 0.004, Math.max(3, seg - 2), 'bark');
  }
  for (let k = 0; k < cards; k++) {
    let d; do { d = V(rnd() * 2 - 1, rnd() * 2 - 0.7, rnd() * 2 - 1); } while (d.lengthSq() > 1 || d.lengthSq() < 0.05);
    const s = 0.5 + 0.5 * Math.sqrt(rnd()); d.normalize();
    const p = V(c.x + d.x * r.x * s, c.y + d.y * r.y * s, c.z + d.z * r.z * s);
    const facing = d.clone().add(V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(1.4)).normalize();
    const [u, v] = randomPerp(facing), w = size * (0.85 + rnd() * 0.3);
    b.quad(p, u.multiplyScalar(w), v.multiplyScalar(w), 'broad', nf);
  }
  return b.build();
}

function sugiTree(cards, seg, size) {
  const b = new Builder(), yb = 0.2;
  b.tube([V(0, 0, 0), V(0, 0.5, 0), V(0, 0.98, 0)], 0.022, 0.004, seg, 'bark');
  const R = t => 0.15 * Math.pow(1 - t, 0.85) + 0.012;
  for (let k = 0; k < cards; k++) {
    const t = Math.pow(rnd(), 0.8), y = yb + (1 - yb) * t, rr = R(t), a = rnd() * 6.28;
    const o = V(Math.cos(a), 0, Math.sin(a)), p = V(o.x * rr * 0.55, y, o.z * rr * 0.55);
    const tang = V(-o.z, 0, o.x), w = (rr * 1.05 + 0.03) * size;
    const droop = o.clone().multiplyScalar(0.75).add(V(0, -0.65, 0)).normalize();
    // 中心から外へ垂れ下がる房（板の上端が幹側）
    const pc = p.clone().addScaledVector(droop, w * 0.7);
    const nf = q => V(q.x, 0, q.z).normalize().add(V(0, 0.55, 0)).normalize();
    b.quad(pc, tang.multiplyScalar(w * 0.8), droop.multiplyScalar(-w * 0.75), 'conifer', nf);
  }
  // 梢：細い縦の板 2 枚
  const nfTop = q => V(q.x * 4, 1, q.z * 4).normalize();
  b.quad(V(0, 0.95, 0), V(0.03, 0, 0), V(0, 0.06, 0), 'conifer', nfTop);
  b.quad(V(0, 0.95, 0), V(0, 0, 0.03), V(0, 0.06, 0), 'conifer', nfTop);
  return b.build();
}

function bambooClump(culms, leavesPer, seg, size) {
  const b = new Builder(), c = V(0, 0.7, 0), r = V(0.22, 0.32, 0.22), nf = ellN(c, r);
  for (let k = 0; k < culms; k++) {
    const a = rnd() * 6.28, bx = Math.cos(a) * 0.05 * rnd(), bz = Math.sin(a) * 0.05 * rnd();
    const la = a + (rnd() - 0.5), lean = 0.12 + rnd() * 0.16, top = 0.92 + rnd() * 0.08;
    const P = t => V(bx + Math.cos(la) * lean * t * t, t * top, bz + Math.sin(la) * lean * t * t);
    b.tube([0, 0.33, 0.66, 1].map(P), 0.0055, 0.002, seg, 'culm');
    for (let j = 0; j < leavesPer; j++) {
      const t = 0.45 + 0.55 * rnd(), p = P(t), oa = rnd() * 6.28, w = (0.06 + rnd() * 0.04) * size;
      const o = V(Math.cos(oa), 0, Math.sin(oa)), droop = o.clone().multiplyScalar(0.6).add(V(0, -0.8, 0)).normalize();
      b.quad(p.clone().addScaledVector(o, w * 0.5).addScaledVector(droop, w * 0.6), V(-o.z, 0, o.x).multiplyScalar(w), droop.multiplyScalar(-w), 'bamboo', nf);
    }
  }
  return b.build();
}

// 落葉した広葉樹：幹から枝を 3 段に分けて伸ばす。残った枯れ葉を少しだけ板で付ける
function bareTree(levels, mains, seg, leftovers) {
  const b = new Builder(), c = V(0, 0.62, 0), r = V(0.34, 0.27, 0.34), nf = ellN(c, r);
  b.tube([V(0, 0, 0), V(0.01, 0.25, 0), V(0, 0.45, 0.01)], 0.03, 0.02, seg, 'bark');
  const grow = (p, dir, len, rad, depth) => {
    const e = p.clone().addScaledVector(dir, len), m = p.clone().addScaledVector(dir, len * 0.5).add(V((rnd() - 0.5) * len * 0.15, 0, (rnd() - 0.5) * len * 0.15));
    b.tube([p, m, e], rad, rad * 0.6, Math.max(3, seg - (levels - depth)), 'bark');
    if (depth <= 1) return;
    const kids = depth === levels ? 3 : 2 + (rnd() < 0.5 ? 1 : 0);
    for (let k = 0; k < kids; k++) {
      const t = 0.55 + 0.45 * rnd(), q = p.clone().lerp(e, t);
      const nd = dir.clone().add(V(rnd() - 0.5, rnd() * 0.5, rnd() - 0.5).multiplyScalar(1.1)).normalize();
      grow(q, nd, len * (0.5 + rnd() * 0.15), rad * 0.55, depth - 1);
    }
  };
  for (let k = 0; k < mains; k++) {
    const a = k / mains * 6.28 + rnd() * 0.8, y0 = 0.3 + rnd() * 0.18;
    grow(V(0, y0, 0), V(Math.cos(a) * 0.7, 0.75 + rnd() * 0.3, Math.sin(a) * 0.7).normalize(), 0.3 + rnd() * 0.08, 0.014, levels);
  }
  for (let k = 0; k < leftovers; k++) {
    let d; do { d = V(rnd() * 2 - 1, rnd() * 2 - 0.7, rnd() * 2 - 1); } while (d.lengthSq() > 1 || d.lengthSq() < 0.1);
    const p = V(c.x + d.x * r.x * 0.8, c.y + d.y * r.y * 0.8, c.z + d.z * r.z * 0.8), [u, v] = randomPerp(d.normalize());
    b.quad(p, u.multiplyScalar(0.07), v.multiplyScalar(0.07), 'broad', nf);
  }
  return b.build();
}

// 季節：落葉樹の色づき（0〜1）と、葉を落とした木の割合。シミュレーターの日付（今日）で決める
export function seasonOf(date = new Date()) {
  const d = (date.getMonth() + date.getDate() / 31);   // 0 = 1 月初め
  const autumn = Math.max(0, 1 - Math.abs(d - 10.6) / 1.4);              // 10 月中旬〜12 月上旬に色づく（11 月下旬が盛り）
  const bare = d < 3.2 ? 0.8 : d < 3.8 ? 0.8 * (3.8 - d) / 0.6 : d > 10.4 ? Math.min(0.8, (d - 10.4) / 1.6 * 0.8) : 0;
  return { autumn, bare };
}

// quality 0（ノートPC）〜 3（最高）。near は近く、far は遠く用の簡略形
export function makeTreeKit(quality, env) {
  seed = 7771;
  const q = quality;
  const geos = {
    broad: { near: broadTree([20, 28, 40, 54][q], [2, 3, 4, 5][q], [4, 5, 6, 7][q], [0.16, 0.14, 0.13, 0.13][q]), far: broadTree(14, 0, 4, 0.18) },
    conifer: { near: sugiTree([18, 24, 32, 42][q], [4, 5, 6, 6][q], 1), far: sugiTree(12, 4, 1.3) },
    bamboo: { near: bambooClump([4, 6, 7, 9][q], [4, 6, 7, 8][q], [3, 4, 4, 5][q], 1), far: bambooClump(3, 3, 3, 1.6) },
    // 遠くの裸木は、枝先の細かさを薄い板（茶色に染めた葉の板）で代わりに見せる
    bare: { near: bareTree([2, 3, 3, 3][q], [3, 4, 5, 5][q], [3, 4, 4, 5][q], [3, 4, 6, 8][q]), far: broadTree(8, 3, 3, 0.15) }
  };
  const map = paintAtlas();
  const mat = new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 });
  mat.shadowSide = THREE.DoubleSide;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSunDir = { value: env.sunDir };
    sh.uniforms.uSunRadiance = { value: env.sunRadiance };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLeafWPos;\nvarying float vLeaf;')
      // 葉にはインスタンスの色（個体差）を掛け、幹・竹の稈はテクスチャの色のまま
      .replace('#include <color_vertex>', `#include <color_vertex>
        vLeaf = step(uv.x, 0.75);
        #ifdef USE_INSTANCING_COLOR
          vColor = mix(vec3(1.0), instanceColor.xyz, vLeaf);
        #endif`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec4 lw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            lw = instanceMatrix * lw;
          #endif
          vLeafWPos = (modelMatrix * lw).xyz;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLeafWPos;\nvarying float vLeaf;\nuniform vec3 uSunDir;\nuniform vec3 uSunRadiance;')
      // 遠くでミップマップが透明に寄り葉が痩せるのを、縮小率に応じて不透明度を上げて補う
      .replace('#include <alphatest_fragment>', `{
          vec2 px = vec2(${W}.0, ${H}.0);
          vec2 dd = max(abs(dFdx(vMapUv * px)), abs(dFdy(vMapUv * px)));
          diffuseColor.a *= 1.0 + 0.3 * max(0.0, log2(max(dd.x, dd.y)));
        }
        #include <alphatest_fragment>`)
      // 葉の板は裏から見ても法線を反転しない（樹冠全体の丸みで陰影を付ける）
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        #ifdef DOUBLE_SIDED
          if (vLeaf > 0.5) normal *= faceDirection;
        #endif`)
      // 逆光で葉を透けた光
      .replace('#include <opaque_fragment>', `{
          float back = pow(max(dot(normalize(vLeafWPos - cameraPosition), uSunDir), 0.0), 4.0);
          outgoingLight += diffuseColor.rgb * uSunRadiance * (vLeaf * back * 0.5 * RECIPROCAL_PI * smoothstep(0.05, 0.4, uSunDir.y));
        }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'treeCards1';
  return { geos, mat, nearRange: [500, 800, 1200, 1600][q] };
}

// 樹種ごとの葉色（sRGB の HSL）と樹高
const AUTUMN = [[0.11, 0.55, 0.42], [0.08, 0.5, 0.36], [0.06, 0.45, 0.32], [0.13, 0.4, 0.4], [0.2, 0.25, 0.3]];  // 黄・橙・茶・黄土・くすんだ緑
export function treeLook(kind, rand, col, season = { autumn: 0 }) {
  if (kind === 'bare') return col.setHSL(0.07 + rand() * 0.04, 0.3 + rand() * 0.15, 0.28 + rand() * 0.08);  // 残った枯れ葉
  if (kind === 'broad' && season.autumn > 0 && rand() < season.autumn * 0.85) {
    const [h, sat, l] = AUTUMN[Math.floor(rand() * AUTUMN.length)];
    return col.setHSL(h + (rand() - 0.5) * 0.02, sat * (0.85 + rand() * 0.3), l * (0.85 + rand() * 0.25));
  }
  if (kind === 'conifer') col.setHSL(0.27 + rand() * 0.05, 0.22 + rand() * 0.12, 0.26 + rand() * 0.07);
  else if (kind === 'bamboo') col.setHSL(0.2 + rand() * 0.04, 0.3 + rand() * 0.12, 0.33 + rand() * 0.07);
  else col.setHSL(0.22 + rand() * 0.06, 0.38 + rand() * 0.2, 0.25 + rand() * 0.08);
  return col;
}
