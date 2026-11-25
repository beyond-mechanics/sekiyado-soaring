// 景観：航空写真から自動検出した樹木、格納庫、滑走路標識、吹き流し、川面、草。
import * as THREE from 'three';
import { RUNWAY_HEADING, RUNWAY_LENGTH, inRunway } from '../sim/flight.js';
import { buildOsmBuildings, makeLandUse, fillWoods } from './osm.js';
import { makeTreeKit, treeLook, seasonOf } from './trees.js';

let seed = 151;
function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

function imageData(img) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, img.width, img.height);
}

// 航空写真の色（sRGB 0〜1）を世界座標で引く。詳細域は高解像度の分割画像、外側は広域の画像
function makePhotoSampler(textures, meta) {
  const srcs = [...(textures.detailChunks || []).map(ch => ({ ...ch, d: imageData(ch.texture.image) })),
    { xmin: meta.xmin, zmin: meta.zmin, width: meta.size, depth: meta.size, d: imageData(textures.wide.image) }];
  return (x, z) => {
    for (const s of srcs) {
      const u = (x - s.xmin) / s.width, v = (z - s.zmin) / s.depth;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const W = s.d.width, H = s.d.height, k = (Math.floor(v * H) * W + Math.floor(u * W)) * 4, p = s.d.data;
      return [p[k] / 255, p[k + 1] / 255, p[k + 2] / 255];
    }
    return null;
  };
}

function distToRiver(river, x, z) {
  let best = Infinity, w = 60;
  for (let i = 0; i < river.length - 1; i++) {
    const a = river[i], b = river[i + 1], dx = b.x - a.x, dz = b.z - a.z, L = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L));
    const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
    if (d < best) { best = d; w = a.w + (b.w - a.w) * t; }
  }
  return best - w / 2;
}

// 航空写真の「周囲より暗い緑」の画素から樹木を推定（1 本ずつの位置は近似）
function detectTrees(img, rect, cell, density, river, exclude) {
  const d = imageData(img), W = d.width, H = d.height, px = d.data, out = [];
  // 周囲 40 画素程度の平均明るさ（縮小画像で近似）
  const sw = Math.max(1, Math.round(W / 24)), sh = Math.max(1, Math.round(H / 24));
  const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
  const sg = sc.getContext('2d', { willReadFrequently: true }); sg.imageSmoothingQuality = 'high'; sg.drawImage(img, 0, 0, sw, sh);
  const small = sg.getImageData(0, 0, sw, sh).data;
  const localLum = (x, y) => { const i = (Math.min(sh - 1, Math.floor(y / H * sh)) * sw + Math.min(sw - 1, Math.floor(x / W * sw))) * 4; return (0.3 * small[i] + 0.59 * small[i + 1] + 0.11 * small[i + 2]) / 255; };
  const mpp = rect.width / W, stepPx = Math.max(1, Math.round(cell / mpp));
  for (let y = 1; y < H - 1; y += stepPx) for (let x = 1; x < W - 1; x += stepPx) {
    let r = 0, g = 0, b = 0, l2 = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = ((y + dy) * W + x + dx) * 4, l = 0.3 * px[k] + 0.59 * px[k + 1] + 0.11 * px[k + 2];
      r += px[k]; g += px[k + 1]; b += px[k + 2]; l2 += l * l;
    }
    r /= 9 * 255; g /= 9 * 255; b /= 9 * 255;
    const lum = 0.3 * r + 0.59 * g + 0.11 * b, around = localLum(x, y);
    const sd = Math.sqrt(Math.max(0, l2 / 9 / 65025 - lum * lum));   // 樹冠のざらつき
    if (!(g - r > 0.01 && g - b > 0.02 && lum < 0.3 && lum > 0.04 && lum < around * 0.85 && sd > 0.02)) continue;
    const strength = Math.min(1, (around - lum) * 5 + sd * 6);
    if (rand() > strength * density) continue;
    const wx = rect.xmin + (x + (rand() - 0.5) * stepPx) * mpp, wz = rect.zmin + (y + (rand() - 0.5) * stepPx) * mpp;
    if (exclude(wx, wz) || distToRiver(river, wx, wz) < 4) continue;
    out.push({ x: wx, z: wz, h: 4 + strength * 9 + rand() * 5, conifer: rand() < 0.3 });
  }
  return out;
}

export function buildScenery(scene, data, textures, height, quality, env) {
  const group = new THREE.Group(); scene.add(group);
  const sc = data.scenery, detail = data.detail, meta = data.meta;
  const obj = new THREE.Object3D(), col = new THREE.Color();
  const density = [0.2, 0.45, 0.7, 1.0][quality];
  const nearRunway = (x, z) => {
    const s = Math.sin(RUNWAY_HEADING), c = Math.cos(RUNWAY_HEADING), along = x * s - z * c, cross = x * c + z * s;
    return Math.abs(along) < RUNWAY_LENGTH / 2 + 60 && Math.abs(cross) < 70;
  };
  const inBuildings = (x, z) => sc.buildings.some(b => Math.abs(x - b.x) < b.w / 2 + 4 && Math.abs(z - b.z) < b.d / 2 + 4);
  const baseExclude = (x, z) => nearRunway(x, z) || inBuildings(x, z);

  // OpenStreetMap があれば：建物を輪郭から生成し、建物・道路・農地・草地の上には木を置かない。樹林は範囲の中を均一に埋める
  let osmBuildings = null, land = null;
  if (data.osm) {
    osmBuildings = buildOsmBuildings(group, data.osm, height, makePhotoSampler(textures, meta), quality, baseExclude);
    land = makeLandUse(data.osm, osmBuildings.footprints);
  }
  const exclude = land ? (x, z) => baseExclude(x, z) || land.noTree(x, z) || !!land.inWood(x, z) : baseExclude;

  // 樹木：写真から検出（詳細域は細かく、広域は粗く）＋旧版の手動配置
  const trees = sc.trees.map(t => ({ ...t, conifer: rand() < 0.3 }));
  const detailRect = { xmin: detail.xmin, zmin: detail.zmin, width: detail.width, depth: detail.depth };
  for (const ch of textures.detailChunks) {
    trees.push(...detectTrees(ch.texture.image, { xmin: ch.xmin, zmin: ch.zmin, width: ch.width, depth: ch.depth }, 7, density, sc.river, exclude));
  }
  const wideTrees = detectTrees(textures.wide.image, { xmin: meta.xmin, zmin: meta.zmin, width: meta.size, depth: meta.size }, 14, density * 0.9, sc.river,
    (x, z) => (x > detailRect.xmin && x < detailRect.xmin + detailRect.width && z > detailRect.zmin && z < detailRect.zmin + detailRect.depth) || exclude(x, z));
  trees.push(...wideTrees);
  if (land) trees.push(...fillWoods(land, [16, 11, 8.5, 7][quality], rand, (x, z) => !baseExclude(x, z) && !land.noTree(x, z)).map(t => ({ ...t, wood: true })));

  // 樹種：河畔は広葉樹（エノキ・ヤナギなど）、樹林は杉と広葉樹、集落まわりは屋敷林（杉・竹・広葉樹）
  const season = seasonOf();
  for (const t of trees) {
    const r = rand();
    if (t.wood) t.kind = t.conifer || r < 0.4 ? 'conifer' : r < 0.95 ? 'broad' : 'bamboo';
    else if (distToRiver(sc.river, t.x, t.z) < 150) t.kind = r < 0.85 ? 'broad' : r < 0.92 ? 'bamboo' : 'conifer';
    else t.kind = t.conifer ? 'conifer' : r < 0.16 ? 'bamboo' : 'broad';
    if (t.kind === 'broad' && rand() < season.bare) t.kind = 'bare';  // 冬は落葉樹の多くが葉を落とす
    if (t.kind === 'bamboo') t.h = 9 + rand() * 6;
    if (t.kind === 'conifer') t.h = Math.max(t.h, 12) * (1.1 + rand() * 0.3);
  }

  // 1 km 四方ごと・樹種ごとに、近く用（詳しい形）と遠く用（簡略形）の InstancedMesh を作る（行列は共有）
  const kit = makeTreeKit(quality, env);
  const cells = new Map();
  for (const t of trees) {
    const key = Math.floor(t.x / 1000) + ',' + Math.floor(t.z / 1000);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(t);
  }
  const chunkMeshes = [], treeRange = [2200, 3500, 5000, 7000][quality];
  for (const list of cells.values()) {
    for (const kind of ['broad', 'bare', 'conifer', 'bamboo']) {
      const sub = list.filter(t => t.kind === kind);
      if (!sub.length) continue;
      const near = new THREE.InstancedMesh(kit.geos[kind].near, kit.mat, sub.length);
      sub.forEach((t, i) => {
        const y = height(t.x, t.z), h = t.h, sx = 0.85 + rand() * 0.3;
        obj.position.set(t.x, y - 0.2, t.z); obj.rotation.set((rand() - 0.5) * 0.06, rand() * 6.28, (rand() - 0.5) * 0.06);
        obj.scale.set(h * sx, h, h * (0.85 + rand() * 0.3)); obj.updateMatrix();
        near.setMatrixAt(i, obj.matrix); near.setColorAt(i, treeLook(kind, rand, col, season));
      });
      const far = new THREE.InstancedMesh(kit.geos[kind].far, kit.mat, sub.length);
      far.instanceMatrix = near.instanceMatrix; far.instanceColor = near.instanceColor;
      near.computeBoundingSphere(); far.boundingSphere = near.boundingSphere;
      for (const m of [near, far]) {
        m.castShadow = quality > 0; m.receiveShadow = true;
        m.userData.center = near.boundingSphere.center.clone(); m.userData.lod = m === near ? 'near' : 'far';
        group.add(m); chunkMeshes.push(m);
      }
    }
  }

  // 格納庫・建物（写真から読み取った屋根の輪郭。高さは推定）
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xc9c6ba, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x7b8a8d, metalness: 0.45, roughness: 0.45 });
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x6f7a77, metalness: 0.3, roughness: 0.6 });
  for (const b of sc.buildings) {
    const y = height(b.x, b.z), g = new THREE.Group(); g.position.set(b.x, y, b.z); g.rotation.y = b.rotation || 0;
    const walls = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), wallMat); walls.position.y = b.h / 2;
    // かまぼこ型に近い緩い切妻屋根
    const roofShape = new THREE.Shape(); roofShape.moveTo(-b.w / 2 - 0.6, 0); roofShape.lineTo(0, Math.min(3, b.w * 0.08)); roofShape.lineTo(b.w / 2 + 0.6, 0); roofShape.lineTo(b.w / 2 + 0.6, -0.25); roofShape.lineTo(0, Math.min(3, b.w * 0.08) - 0.25); roofShape.lineTo(-b.w / 2 - 0.6, -0.25);
    const rg = new THREE.ExtrudeGeometry(roofShape, { depth: b.d + 1.2, bevelEnabled: false }); rg.translate(0, b.h, -b.d / 2 - 0.6);
    const roof = new THREE.Mesh(rg, roofMat);
    g.add(walls, roof);
    const doors = Math.max(1, Math.floor(b.w / 6));
    for (let i = 0; i < doors; i++) {
      const door = new THREE.Mesh(new THREE.PlaneGeometry(b.w / doors - 0.4, b.h * 0.8), doorMat);
      door.position.set(-b.w / 2 + (i + 0.5) * b.w / doors, b.h * 0.4, b.d / 2 + 0.03); g.add(door);
    }
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(g);
  }

  // 滑走路の目印（四隅の白い標識と中間の小さなマーカー）
  const markMat = new THREE.MeshStandardMaterial({ color: 0xf4f4ee, roughness: 0.7 });
  const markGeo = new THREE.BoxGeometry(3, 0.35, 8);
  const marks = new THREE.InstancedMesh(markGeo, markMat, 64); let mi = 0;
  for (let along = -RUNWAY_LENGTH / 2 + 10; along <= RUNWAY_LENGTH / 2 - 10; along += 150) for (const cross of [-44, 44]) {
    const x = Math.sin(RUNWAY_HEADING) * along + Math.cos(RUNWAY_HEADING) * cross, z = -Math.cos(RUNWAY_HEADING) * along + Math.sin(RUNWAY_HEADING) * cross;
    obj.position.set(x, height(x, z) + 0.2, z); obj.rotation.set(0, -RUNWAY_HEADING, 0); obj.scale.set(1, 1, 1); obj.updateMatrix();
    marks.setMatrixAt(mi++, obj.matrix);
  }
  marks.count = mi; marks.receiveShadow = true; marks.castShadow = true; group.add(marks);

  // 吹き流し（位置は目安）
  const sx = 95, sz = 120, base = height(sx, sz), sock = new THREE.Group(); sock.position.set(sx, base, sz);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 6.5, 8), new THREE.MeshStandardMaterial({ color: 0xb3b6b4, metalness: 0.6, roughness: 0.4 }));
  pole.position.y = 3.25; sock.add(pole);
  const pivot = new THREE.Group(); pivot.position.y = 6.3; sock.add(pivot);
  const segs = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.34 - i * 0.04, 0.3 - i * 0.04, 0.6, 14, 1, true), new THREE.MeshStandardMaterial({ color: i % 2 ? 0xf3eee1 : 0xe8692c, side: THREE.DoubleSide, roughness: 0.8 }));
    m.rotation.x = Math.PI / 2; m.position.z = i * 0.6 + 0.3; pivot.add(m); segs.push(m);
  }
  sock.traverse(o => { if (o.isMesh) o.castShadow = true; });
  group.add(sock);

  // 川面：空を映す水面（法線マップを動かして波を表現）
  // v5.1：左岸・中央・右岸の 3 列にして、岸辺の数 m を透明へぼかす（岸の直線的な縁を目立たなくする）
  const verts = [], uv = [], banks = [], idx = [];
  sc.river.forEach((p, i) => {
    const prev = sc.river[Math.max(0, i - 1)], next = sc.river[Math.min(sc.river.length - 1, i + 1)], dx = next.x - prev.x, dz = next.z - prev.z, n = Math.hypot(dx, dz) || 1;
    for (const side of [-1, 0, 1]) {
      const x = p.x + dz / n * p.w / 2 * side, z = p.z - dx / n * p.w / 2 * side;
      verts.push(x, height(x, z) + 0.15, z); uv.push(x / 30, z / 30); banks.push(side === 0 ? 1 : 0);
    }
    if (i > 0) { const k = i * 3; idx.push(k - 3, k, k - 2, k - 2, k, k + 1, k - 2, k + 1, k - 1, k - 1, k + 1, k + 2); }
  });
  const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); wg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  wg.setAttribute('aBank', new THREE.Float32BufferAttribute(banks, 1)); wg.setIndex(idx); wg.computeVertexNormals();
  const N = 128, nd = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = (j * N + i) * 4, a = i / N * Math.PI * 2, b = j / N * Math.PI * 2;
    const dx = 0.5 * Math.cos(a * 3 + b) + 0.3 * Math.cos(a * 7 - b * 3) + 0.2 * Math.sin(b * 11 + a * 2);
    const dz = 0.5 * Math.sin(b * 4 - a) + 0.3 * Math.cos(b * 9 + a * 5) + 0.2 * Math.sin(a * 13);
    nd[k] = 128 + dx * 60; nd[k + 1] = 128 + dz * 60; nd[k + 2] = 255; nd[k + 3] = 255;
  }
  const nt = new THREE.DataTexture(nd, N, N); nt.wrapS = nt.wrapT = THREE.RepeatWrapping; nt.repeat.set(1, 1); nt.needsUpdate = true; nt.generateMipmaps = true; nt.minFilter = THREE.LinearMipmapLinearFilter;
  const wm = new THREE.MeshPhysicalMaterial({ color: 0x26393a, roughness: 0.12, metalness: 0, normalMap: nt, normalScale: new THREE.Vector2(0.18, 0.18), transparent: true, opacity: 0.9, envMapIntensity: 0.9 });
  // 波：向きと速さの違う 2 層の法線を重ねて、模様の繰り返しを目立たなくする
  const waterTime = { value: 0 };
  wm.onBeforeCompile = (sh) => {
    sh.uniforms.uWaterTime = waterTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBank;\nvarying float vBank;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBank = aBank;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBank;\nuniform float uWaterTime;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= smoothstep(0.0, 0.26, vBank);')
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        `vec3 wA = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
        vec3 wB = texture2D( normalMap, vNormalMapUv * 1.73 + vec2( -uWaterTime * 0.007, uWaterTime * 0.009 ) ).xyz * 2.0 - 1.0;
        vec3 mapN = normalize( vec3( wA.xy + wB.xy * 0.75, wA.z * wB.z ) );`));
  };
  wm.customProgramCacheKey = () => 'river51';
  const water = new THREE.Mesh(wg, wm); water.receiveShadow = true; group.add(water);

  return {
    group, treeCount: trees.length, buildingCount: osmBuildings?.count || 0,
    update(camPos, time, windTo, windSpeed) {
      const agl = camPos.y - height(camPos.x, camPos.z);
      const far2 = treeRange * treeRange;
      const bRange2 = [2500, 5000, 8000, 9000][quality] ** 2 + agl * agl * 2;
      for (const m of osmBuildings?.meshes || []) { const c = m.userData.center; m.visible = (camPos.x - c.x) ** 2 + (camPos.z - c.z) ** 2 < bRange2; }
      const near2 = kit.nearRange ** 2 + agl * agl;
      for (const m of chunkMeshes) {
        const c = m.userData.center, d2 = (camPos.x - c.x) ** 2 + (camPos.z - c.z) ** 2;
        m.visible = d2 < far2 + agl * agl * 2 && (m.userData.lod === 'near') === (d2 < near2);
      }
      nt.offset.set(time * 0.004, time * 0.011); waterTime.value = time;
      // 吹き流し：風下へ向き、風速 15 kt（約 7.7 m/s）で水平
      pivot.rotation.y = -windTo + Math.PI;
      const lift = Math.min(1, windSpeed / 7.7);
      segs.forEach((m, i) => { m.position.y = -(1 - lift) * (i * 0.6 + 0.3) * 0.9; m.rotation.z = Math.sin(time * 6 + i) * 0.05 * lift; });
      pivot.rotation.x = 0;
    }
  };
}
