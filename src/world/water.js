// 水辺ツール：OpenStreetMap の水域（川・池）の輪郭から、航空写真の川筋どおりの水面と、岸のヨシ・ススキの帯を作る。
import * as THREE from 'three';

const WATER = /^(natural:water|reservoir|basin)$/;

// 水域マスク（広域 約 8 km 四方）。sharp：輪郭どおり、soft：岸を数 m ぼかしたもの（水面の透明度に使う）
export function makeWaterMask(osm, meta) {
  const S = 2048, mpp = meta.size / S;
  const areas = (osm?.areas || []).filter(a => WATER.test(a.kind) && a.pts.length >= 3);
  if (!areas.length) return null;
  const draw = (blurPx) => {
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
    if (blurPx) g.filter = `blur(${blurPx}px)`;
    g.fillStyle = '#fff';
    for (const a of areas) {
      g.beginPath();
      a.pts.forEach(([x, z], i) => { const u = (x - meta.xmin) / mpp, v = (z - meta.zmin) / mpp; i ? g.lineTo(u, v) : g.moveTo(u, v); });
      g.closePath(); g.fill();
    }
    return c;
  };
  const sharpC = draw(0), softC = draw(1.5), wideC = draw(5);
  const px = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, S, S).data;
  const sharp = px(sharpC), wide = px(wideC);
  const at = (d, x, z) => {
    const i = Math.floor((x - meta.xmin) / mpp), j = Math.floor((z - meta.zmin) / mpp);
    if (i < 0 || j < 0 || i >= S || j >= S) return 0;
    return d[(j * S + i) * 4] / 255;
  };
  const tex = new THREE.CanvasTexture(softC);
  tex.flipY = false; // キャンバスの行 = z（南向き）
  tex.colorSpace = THREE.NoColorSpace; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  return {
    tex, meta, mpp,
    inWater: (x, z) => at(sharp, x, z) > 0.5,
    nearWater: (x, z) => at(wide, x, z),     // 0〜1（岸から 20 m ほどで 0 に）
  };
}

// 水面メッシュ：16 m 格子のうち水域に掛かるマスだけを作る（高さは地形＋少し）。透明度はマスクで決めるので岸は滑らか
export function buildWaterGeometry(mask, height) {
  const { meta } = mask, cell = 16, n = Math.ceil(meta.size / cell);
  const keep = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x0 = meta.xmin + i * cell, z0 = meta.zmin + j * cell;
    let hit = false;
    for (let a = 0; a <= 4 && !hit; a++) for (let b = 0; b <= 4 && !hit; b++) hit = mask.nearWater(x0 + a * cell / 4, z0 + b * cell / 4) > 0.25;
    keep[j * n + i] = hit ? 1 : 0;
  }
  const index = new Map(), pos = [], uv = [], idx = [];
  const vert = (i, j) => {
    const k = j * (n + 1) + i;
    if (!index.has(k)) {
      const x = meta.xmin + i * cell, z = meta.zmin + j * cell;
      index.set(k, pos.length / 3); pos.push(x, height(x, z) + 0.25, z); uv.push(x / 30, z / 30);
    }
    return index.get(k);
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (!keep[j * n + i]) continue;
    const a = vert(i, j), b = vert(i + 1, j), c = vert(i + 1, j + 1), d = vert(i, j + 1);
    idx.push(a, d, b, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  // 水面は平らに（地形の凹凸で法線が乱れて映り込みが割れないように）
  const nr = g.attributes.normal; for (let i = 0; i < nr.count; i++) nr.setXYZ(i, 0, 1, 0);
  return g;
}

// ヨシ・ススキの株の板（縦長の葉の束と、上に穂）
function reedTexture() {
  const W = 256, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  let s = 91; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  g.lineCap = 'round';
  for (let k = 0; k < 70; k++) {
    const x0 = W * (0.15 + r() * 0.7), lean = (r() - 0.5) * 70, top = H * (0.05 + r() * 0.3);
    const l = 0.55 + r() * 0.3;
    g.strokeStyle = `rgb(${Math.round(255 * l)},${Math.round(240 * l)},${Math.round(200 * l)})`;
    g.lineWidth = 1.2 + r() * 1.6;
    g.beginPath(); g.moveTo(x0, H); g.quadraticCurveTo(x0 + lean * 0.3, (H + top) / 2, x0 + lean, top); g.stroke();
    // 穂（ススキ・ヨシの花穂：上の方に柔らかい房）
    if (r() < 0.45) {
      g.fillStyle = `rgba(${Math.round(250 * l + 20)},${Math.round(240 * l + 15)},${Math.round(225 * l + 10)},0.9)`;
      for (let q = 0; q < 10; q++) { g.beginPath(); g.ellipse(x0 + lean + (r() - 0.5) * 8, top + q * 3 + r() * 4, 2.5, 5, lean / 200, 0, 6.28); g.fill(); }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function reedGeometry() {
  // 十字＋斜めの 3 枚の板（幅 1、高さ 1、根元が原点）
  const pos = [], uv = [], nor = [], idx = [];
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI / 3, cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5, b = pos.length / 3;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let q = 0; q < 4; q++) nor.push(0, 1, 0); // 上向き法線：板の向きで明るさが変わらないように
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// 岸辺の帯（水際から 15 m ほど）にヨシ・ススキの株を並べる。1 km 四方ごとの InstancedMesh（遠くは描かない）
export function buildReeds(group, mask, height, quality, wind, rand, exclude) {
  if (quality < 1) return []; // 「軽量」は作らない
  const spacing = [0, 3.2, 2.6, 2.2][quality], range = [0, 2500, 3200, 4000][quality];
  const cells = new Map(), m = mask.meta;
  const B = 24; // 24 m の区画ごとに、水辺に掛からない区画は飛ばす
  for (let bx = Math.max(m.xmin, -range); bx < Math.min(m.xmin + m.size, range); bx += B)
  for (let bz = Math.max(m.zmin, -range); bz < Math.min(m.zmin + m.size, range); bz += B) {
    let any = false;
    for (const [fx, fz] of [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]]) if (mask.nearWater(bx + fx * B, bz + fz * B) > 0.08) any = true;
    if (!any) continue;
    for (let x = bx; x < bx + B; x += spacing) for (let z = bz; z < bz + B; z += spacing) {
      const px = x + (rand() - 0.5) * spacing, pz = z + (rand() - 0.5) * spacing;
      const nw = mask.nearWater(px, pz);
      if (nw < 0.12 || nw > 0.95 || mask.inWater(px, pz)) continue;
      // 水際に近いほど密に
      if (rand() > Math.min(1, (nw - 0.12) * 2.2)) continue;
      if (exclude(px, pz)) continue;
      const k = Math.floor(px / 1000) + ',' + Math.floor(pz / 1000);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push([px, pz]);
    }
  }
  const geo = reedGeometry();
  const mat = new THREE.MeshStandardMaterial({ map: reedTexture(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.95 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, wind);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec2 uWind;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          float hN = uv.y;
          vec3 ip = instanceMatrix[3].xyz;
          float ph = dot(ip.xz, vec2(0.21, 0.17));
          float bend = hN * hN * (0.04 + 0.025 * length(uWind)) * (0.6 + 0.4 * sin(uTime * 1.9 + ph));
          vec2 d = length(uWind) > 0.01 ? normalize(uWind) : vec2(1.0, 0.0);
          mvPosition.xyz += (viewMatrix * vec4(d.x * bend, -bend * 0.3, d.y * bend, 0.0)).xyz;
          gl_Position = projectionMatrix * mvPosition;
        }`);
  };
  mat.customProgramCacheKey = () => 'reeds1';
  const obj = new THREE.Object3D(), col = new THREE.Color(), meshes = [];
  for (const list of cells.values()) {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(([x, z], i) => {
      const h = 1.4 + rand() * 1.3;
      obj.position.set(x, height(x, z) - 0.1, z); obj.rotation.set(0, rand() * 6.28, 0);
      obj.scale.set(h * (0.8 + rand() * 0.6), h, h * (0.8 + rand() * 0.6)); obj.updateMatrix();
      im.setMatrixAt(i, obj.matrix);
      // 晩秋の枯れ色（黄土〜灰褐色）に、ところどころ緑が残る
      if (rand() < 0.2) col.setHSL(0.2 + rand() * 0.05, 0.3, 0.55); else col.setHSL(0.1 + rand() * 0.03, 0.35 + rand() * 0.15, 0.72 + rand() * 0.12);
      im.setColorAt(i, col);
    });
    im.computeBoundingSphere(); im.castShadow = false; im.receiveShadow = true;
    im.userData.center = im.boundingSphere.center.clone();
    group.add(im); meshes.push(im);
  }
  return meshes;
}
