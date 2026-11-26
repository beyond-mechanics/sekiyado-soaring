// OpenStreetMap（assets/data/osm.json、scripts/fetch-osm.mjs で作成）から景観を作る。
// 建物ツール：建物の輪郭を立ち上げ、形と面積から屋根（寄棟・切妻・陸屋根）を決める。屋根の色は航空写真から取る。
// 植生ツール用の判定：建物・道路・農地の上に樹木を置かないための判定と、樹林の範囲。
// 出典：© OpenStreetMap contributors（ODbL 1.0）
import * as THREE from 'three';

// ---------------------------------------------------------------- 小さな幾何ヘルパー

const hash = (n) => { let h = (n * 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13; return (h >>> 0) / 4294967296; };

function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

function ringOf(pts) {
  const r = pts.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  // 近すぎる点（10 cm 未満）を除く
  return r.filter((p, i) => { const q = r[(i + r.length - 1) % r.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.1; });
}

function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

// 最小面積の外接長方形（凸包の辺の向きを順に試す）
function minAreaRect(pts) {
  const h = convexHull(pts);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of h) {
      const u = q[0] * ux + q[1] * uz, v = -q[0] * uz + q[1] * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ux, uz, u0, u1, v0, v1 } = best;
  // u を長辺にそろえる
  if (v1 - v0 > u1 - u0) { [ux, uz] = [-uz, ux]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { area: best.area, ux, uz, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, hl: (u1 - u0) / 2, hw: (v1 - v0) / 2 };
}

// ---------------------------------------------------------------- メッシュを組み立てる入れ物

class Builder {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.uv = []; this.wh = []; this.base = null; }
  // 三角形を「外向き」の法線 n に合わせた向きで足す
  tri(a, b, c, n, color, uvs) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    let order = [0, 1, 2];
    if (fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2] < 0) order = [0, 2, 1];
    const v = [a, b, c], t = uvs || [[0, 0], [0, 0], [0, 0]];
    for (const k of order) {
      this.pos.push(v[k][0], v[k][1], v[k][2]); this.nor.push(n[0], n[1], n[2]);
      this.col.push(color.r, color.g, color.b); this.uv.push(t[k][0], t[k][1]);
      this.wh.push(this.base === null ? 10 : v[k][1] - this.base); // 壁の根元からの高さ（汚れ用）
    }
  }
  quad(a, b, c, d, n, color, uvs) {
    const t = uvs || [[0, 0], [0, 0], [0, 0], [0, 0]];
    this.tri(a, b, c, n, color, [t[0], t[1], t[2]]); this.tri(a, c, d, n, color, [t[0], t[2], t[3]]);
  }
  geometry() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aWallH', new THREE.Float32BufferAttribute(this.wh, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const norm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

// 窓のテクスチャ（1 枚 = 幅 3.6 m × 1 階分 2.9 m）。下の 2 割は窓のない壁（窓なしの建物はここだけを使う）
function windowTexture() {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#e9e9e9'; g.fillRect(0, S * 0.04, S, 2);  // 階の境目のかすかな線
  g.fillStyle = '#d8d8d8'; g.fillRect(S * 0.26, S * 0.18, S * 0.48, S * 0.5);  // 窓枠
  g.fillStyle = '#4a5560'; g.fillRect(S * 0.29, S * 0.21, S * 0.42, S * 0.44);  // ガラス
  g.fillStyle = '#6a7884'; g.fillRect(S * 0.29, S * 0.21, S * 0.42, S * 0.1);   // 上の映り込み
  g.fillStyle = '#d8d8d8'; g.fillRect(S * 0.495, S * 0.21, S * 0.01, S * 0.44); // 縦の桟
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const NO_WINDOW_V = 0.9; // テクスチャの v（下が 0 と逆なので上端寄り = 画像の下 1 割の白い壁）

// 壁の色：日本の郊外の窯業系サイディング・モルタル（ベージュ・灰・茶）。真っ白は少なめ
const WALL_HOUSE = [0xd6cfc0, 0xc9c1b0, 0xbdb4a2, 0xb0a691, 0xcfcbc2, 0x93877a, 0xa7a29a, 0x8a7d6c, 0xc2b7a0, 0xdcd7cc].map(c => new THREE.Color(c).multiplyScalar(0.45));
const WALL_WORK = [0xb7bab6, 0xa6adae, 0xc3c2ba, 0x98a2a5, 0x8f9a92, 0xaeb0a8].map(c => new THREE.Color(c).multiplyScalar(0.55));

// 壁の汚れ：根元の泥はね、雨だれの縦すじ、ムラ（ワールド座標の手続きノイズ。テクスチャは増やさない）
function addWallWeathering(m) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aWallH;\nvarying float vWallH;\nvarying vec3 vWallPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWallH = aWallH;\nvWallPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vWallH; varying vec3 vWallPos;
        float wHash(float n) { return fract(sin(n) * 43758.5453); }
        float wNoise(float x) { float i = floor(x), f = fract(x); return mix(wHash(i), wHash(i + 1.0), f * f * (3.0 - 2.0 * f)); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float s = vWallPos.x * 0.83 + vWallPos.z * 0.56;          // 壁に沿った座標（どの向きの壁でもおおむね変化する）
          float splash = 1.0 - smoothstep(0.0, 1.0, vWallH);          // 根元 0.8 m の泥はね
          float streak = smoothstep(0.55, 0.95, wNoise(s * 2.3)) * (0.5 + 0.5 * wNoise(vWallH * 0.7 + s));
          float mottle = wNoise(s * 0.45 + 17.0) * 0.6 + wNoise(vWallH * 0.9 + s * 0.2) * 0.4;
          diffuseColor.rgb *= (1.0 - 0.3 * splash) * (1.0 - 0.3 * streak) * (0.88 + 0.16 * mottle);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.92, 0.9, 0.82), splash * 0.5); // 土色に寄せる
        }`);
  };
  m.customProgramCacheKey = () => 'wallWeather1';
  return m;
}

// ---------------------------------------------------------------- 建物ツール

export function buildOsmBuildings(group, osm, height, samplePhoto, quality, skip) {
  const cells = new Map();
  const cellOf = (x, z) => { const k = Math.floor(x / 1000) + ',' + Math.floor(z / 1000); if (!cells.has(k)) cells.set(k, { walls: new Builder(), roofs: new Builder() }); return cells.get(k); };
  const maxDist = [2500, 6000, 9000, 9000][quality];
  const footprints = [];
  let count = 0;
  const col = new THREE.Color();

  for (const b of osm.buildings || []) {
    let r = ringOf(b.pts);
    if (r.length < 3) continue;
    const area0 = signedArea(r), area = Math.abs(area0);
    if (area < 8 || area > 60000) continue;
    if (area0 < 0) r = r.slice().reverse(); // x 東・z 南で正の向きにそろえる
    let cx = 0, cz = 0; for (const p of r) { cx += p[0]; cz += p[1]; } cx /= r.length; cz /= r.length;
    if (Math.hypot(cx, cz) > maxDist || skip(cx, cz)) continue;
    footprints.push(r);

    const t = (b.type || 'yes').toLowerCase(), h = hash(b.id);
    const work = /industrial|warehouse|commercial|retail|factory|barn|farm_auxiliary|hangar|storage|shed|garage|greenhouse|service|roof/.test(t) || area > 600;
    const greenhouse = t === 'greenhouse';
    // 軒の高さ：タグがあればそれ、なければ種類と面積から推定（日本の住宅は 2 階建てが多い）
    let eave = b.height ? b.height * 0.8 : b.levels ? b.levels * 2.9 + 0.3 : 0;
    if (!eave) {
      if (greenhouse) eave = 2.6;
      else if (area < 40 || t === 'garage' || t === 'shed') eave = 2.6;
      else if (!work) eave = h < 0.25 ? 3.3 : 6.0;
      else eave = area < 1500 ? 6.5 : 8.5;
    }
    let gmin = Infinity, gmax = -Infinity;
    for (const p of r) { const y = height(p[0], p[1]); gmin = Math.min(gmin, y); gmax = Math.max(gmax, y); }
    const y0 = gmin - 0.3, yTop = gmax + eave;

    const { walls, roofs } = cellOf(cx, cz);
    const wallCol = greenhouse ? col.set(0xdfe6e4) : col.copy((work ? WALL_WORK : WALL_HOUSE)[Math.floor(h * 97) % (work ? WALL_WORK.length : WALL_HOUSE.length)]);
    const wc = wallCol.clone();
    walls.base = y0;
    const windows = !work && !greenhouse && quality > 0;
    // 壁（輪郭どおり）
    let along = 0;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], c = r[(i + 1) % r.length], L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const n = norm(c[1] - a[1], 0, -(c[0] - a[0])); // 正の向きの輪郭では右手側が外
      const u0 = along / 3.6, u1 = (along + L) / 3.6, vTop = (yTop - y0 - 0.3) / 2.9;
      const uvs = windows ? [[u0, 0.04], [u1, 0.04], [u1, vTop], [u0, vTop]] : [[0.1, NO_WINDOW_V], [0.2, NO_WINDOW_V], [0.2, NO_WINDOW_V], [0.1, NO_WINDOW_V]];
      walls.quad([a[0], y0, a[1]], [c[0], y0, c[1]], [c[0], yTop, c[1]], [a[0], yTop, a[1]], n, wc, uvs);
      along += L;
    }

    // 屋根の色：航空写真の屋根の部分（輪郭の中の数点）の平均。影や霞で暗いので少し持ち上げる
    let rr = 0, rg = 0, rb = 0, ns = 0;
    for (const [fx, fz] of [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) {
      const px = cx + (r[0][0] - cx) * fx, pz = cz + (r[0][1] - cz) * fz;
      if (!pointInRing(px, pz, r)) continue;
      const s = samplePhoto(px, pz); if (!s) continue;
      rr += s[0]; rg += s[1]; rb += s[2]; ns++;
    }
    const roofCol = new THREE.Color();
    if (ns) roofCol.setRGB(rr / ns, rg / ns, rb / ns, THREE.SRGBColorSpace); else roofCol.set(0x666a6e);
    const hsl = {}; roofCol.getHSL(hsl);
    roofCol.setHSL(hsl.h, Math.min(hsl.s, 0.45), THREE.MathUtils.clamp(hsl.l * 1.1, 0.12, 0.62));
    if (greenhouse) roofCol.set(0xe8eeee);

    // 屋根：長方形に近い建物は外接長方形に勾配屋根、そうでなければ陸屋根
    const rect = minAreaRect(r);
    const rectness = rect ? area / rect.area : 0;
    const pitched = rect && rectness > 0.78 && area < 3000 && rect.hw > 1.5;
    if (pitched) {
      const o = greenhouse ? 0.05 : 0.45; // 軒の出
      const hl = rect.hl + o, hw = rect.hw + o, { ux, uz } = rect, vx = -uz, vz = ux;
      const P = (u, v, y) => [rect.cx + ux * u + vx * v, y, rect.cz + uz * u + vz * v];
      const pitch = greenhouse ? 0.45 : work ? 0.2 : 0.5;  // 勾配（tan）：住宅 約 5 寸、倉庫 2 寸
      const rise = rect.hw * pitch, yE = yTop - o * pitch, yR = yTop + rise;
      const hip = !work && !greenhouse && h > 0.45 && rect.hl > rect.hw * 1.05;
      const ridge = hip ? Math.max(0, hl - hw) : hl;
      roofs.quad(P(-hl, hw, yE), P(hl, hw, yE), P(ridge, 0, yR), P(-ridge, 0, yR), norm(vx * pitch, 1, vz * pitch), roofCol);
      roofs.quad(P(hl, -hw, yE), P(-hl, -hw, yE), P(-ridge, 0, yR), P(ridge, 0, yR), norm(-vx * pitch, 1, -vz * pitch), roofCol);
      if (hip) {
        const sp = hw / Math.max(0.01, hl - ridge) * pitch;
        roofs.tri(P(hl, -hw, yE), P(hl, hw, yE), P(ridge, 0, yR), norm(ux * sp, 1, uz * sp), roofCol);
        roofs.tri(P(-hl, hw, yE), P(-hl, -hw, yE), P(-ridge, 0, yR), norm(-ux * sp, 1, -uz * sp), roofCol);
      } else {
        // 切妻の妻壁（三角形）
        const gw = [[0.1, NO_WINDOW_V], [0.2, NO_WINDOW_V], [0.15, NO_WINDOW_V]];
        walls.tri(P(rect.hl, -rect.hw, yTop), P(rect.hl, rect.hw, yTop), P(rect.hl, 0, yTop + rect.hw * pitch), [ux, 0, uz], wc, gw);
        walls.tri(P(-rect.hl, rect.hw, yTop), P(-rect.hl, -rect.hw, yTop), P(-rect.hl, 0, yTop + rect.hw * pitch), [-ux, 0, -uz], wc, gw);
        // 軒裏（下から見えたときに屋根が薄い板に見えないように）
        roofs.quad(P(-hl, hw, yE), P(hl, hw, yE), P(hl, -hw, yE), P(-hl, -hw, yE), [0, -1, 0], roofCol.clone().multiplyScalar(0.5));
      }
    } else {
      const contour = r.map(p => new THREE.Vector2(p[0], p[1]));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const top = yTop + 0.4;
      for (const [i, j, k] of tris) roofs.tri([r[i][0], top, r[i][1]], [r[j][0], top, r[j][1]], [r[k][0], top, r[k][1]], [0, 1, 0], roofCol);
      // パラペット（陸屋根の縁の立ち上がり）
      for (let i = 0; i < r.length; i++) {
        const a = r[i], c = r[(i + 1) % r.length];
        walls.quad([a[0], yTop, a[1]], [c[0], yTop, c[1]], [c[0], top, c[1]], [a[0], top, a[1]], norm(c[1] - a[1], 0, -(c[0] - a[0])), wc,
          [[0.1, NO_WINDOW_V], [0.2, NO_WINDOW_V], [0.2, NO_WINDOW_V], [0.1, NO_WINDOW_V]]);
      }
    }
    walls.base = null;
    count++;
  }

  const wallMat = addWallWeathering(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, map: quality > 0 ? windowTexture() : null }));
  const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.05 });
  const meshes = [];
  for (const { walls, roofs } of cells.values()) {
    for (const [b, m] of [[walls, wallMat], [roofs, roofMat]]) {
      const g = b.geometry(); if (!g) continue;
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = quality > 0; mesh.receiveShadow = quality > 0;
      mesh.userData.center = g.boundingSphere.center.clone();
      group.add(mesh); meshes.push(mesh);
    }
  }
  return { meshes, count, footprints };
}

// ---------------------------------------------------------------- 植生ツール用の判定

const ROAD_WIDTH = { motorway: 14, trunk: 11, primary: 10, secondary: 8, tertiary: 7, unclassified: 5, residential: 5, service: 4, track: 3, living_street: 4 };
const NO_TREE_AREAS = /^(farmland|meadow|grass|farmyard|aeroway:|leisure:pitch|construction|railway|cemetery|natural:water|reservoir|basin|natural:sand|natural:grassland)/;
const WOOD_AREAS = /^(forest|natural:wood|natural:scrub|orchard)/;

// 50 m 四方の格子に図形を登録して、点の判定を速くする
class GridIndex {
  constructor(cell = 50) { this.cell = cell; this.map = new Map(); }
  add(item, x0, z0, x1, z1) {
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) {
      const k = i + ',' + j; if (!this.map.has(k)) this.map.set(k, []); this.map.get(k).push(item);
    }
  }
  at(x, z) { return this.map.get(Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell)) || []; }
}

export function makeLandUse(osm, footprints) {
  const blocked = new GridIndex(), woods = new GridIndex(100), woodList = [];
  const bboxOf = r => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const [x, z] of r) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); } return [x0, z0, x1, z1]; };
  for (const r of footprints) { const bb = bboxOf(r); blocked.add({ ring: r, margin: 1.5 }, bb[0] - 2, bb[1] - 2, bb[2] + 2, bb[3] + 2); }
  for (const a of osm.areas || []) {
    const r = ringOf(a.pts); if (r.length < 3) continue;
    const bb = bboxOf(r);
    if (NO_TREE_AREAS.test(a.kind)) blocked.add({ ring: r, margin: 0 }, ...bb);
    else if (WOOD_AREAS.test(a.kind)) { const w = { ring: r, conifer: a.leaf === 'needleleaved', bb }; woods.add(w, ...bb); woodList.push(w); }
  }
  for (const rd of osm.roads || []) {
    const w = (rd.width || ROAD_WIDTH[rd.kind] || 0) / 2 + 1; if (w <= 1 || rd.bridge) continue;
    for (let i = 0; i < rd.pts.length - 1; i++) {
      const a = rd.pts[i], b = rd.pts[i + 1];
      blocked.add({ seg: [a, b], w }, Math.min(a[0], b[0]) - w, Math.min(a[1], b[1]) - w, Math.max(a[0], b[0]) + w, Math.max(a[1], b[1]) + w);
    }
  }
  const segDist = (x, z, [a, b]) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L));
    return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
  };
  const noTree = (x, z) => blocked.at(x, z).some(it => it.seg ? segDist(x, z, it.seg) < it.w : pointInRing(x, z, it.ring));
  const inWood = (x, z) => woods.at(x, z).find(w => pointInRing(x, z, w.ring)) || null;
  return { noTree, inWood, woods: woodList };
}

// 樹林の中に木を並べる（写真からの検出は樹林の中では使わず、こちらで均一に埋める）
export function fillWoods(land, spacing, rand, isFree) {
  const out = [];
  for (const w of land.woods) {
    const [x0, z0, x1, z1] = w.bb;
    for (let x = x0; x < x1; x += spacing) for (let z = z0; z < z1; z += spacing) {
      const px = x + (rand() - 0.5) * spacing * 0.9, pz = z + (rand() - 0.5) * spacing * 0.9;
      if (!pointInRing(px, pz, w.ring) || !isFree(px, pz)) continue;
      out.push({ x: px, z: pz, h: 9 + rand() * 9, conifer: w.conifer || rand() < 0.25 });
    }
  }
  return out;
}
