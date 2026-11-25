// 地形：滑空場周辺の詳細地形（航空写真＋DEM5）、約8km四方の広域地形、約300km四方の遠景地形（地球の丸み付き）。
import * as THREE from 'three';
import { CLOUD_SHADOW_PARS, CLOUD_SKY_DIM, cloudShadowLookup, lightsWithCloudShadow, cloudShadowUniforms } from './clouds.js';

const R_EARTH = 6371000;

export async function loadTerrainData(progress) {
  const json = async (n) => { const r = await fetch('data/' + n); if (!r.ok) throw Error(n); return r.json(); };
  progress(0.05, '標高データ');
  const [meta, dem, detail, scenery] = await Promise.all(['terrain.json', 'elevation.json', 'detail.json', 'scenery.json'].map(json));
  // 高解像度データ（scripts/fetch-gsi.mjs で作成）があれば優先
  let hires = null;
  try { const r = await fetch('data/hires.json'); if (r.ok) hires = await r.json(); } catch { /* 同梱データのみ */ }
  progress(0.15, '遠景の標高');
  const farBuf = await (await fetch('data/far_dem.bin')).arrayBuffer();
  const farN = new DataView(farBuf).getUint32(0, true), farHalf = new DataView(farBuf).getFloat32(4, true);
  const far = { N: farN, half: farHalf, h: new Int16Array(farBuf, 16) };
  return { meta, dem, detail, scenery, far, hires };
}

function sampleGrid(d, x, z) {
  const nx = d.segx, nz = d.segz;
  const u = Math.max(0, Math.min(nx - 1e-7, (x - d.xmin) / d.width * nx)), v = Math.max(0, Math.min(nz - 1e-7, (z - d.zmin) / d.depth * nz));
  const i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j, n = nx + 1, h = d.heights;
  return (h[j * n + i] * (1 - a) + h[j * n + i + 1] * a) * (1 - b) + (h[(j + 1) * n + i] * (1 - a) + h[(j + 1) * n + i + 1] * a) * b;
}

function farSample(far, x, z) {
  const N = far.N, u = (x + far.half) / (2 * far.half) * N, v = (z + far.half) / (2 * far.half) * N;
  const i = Math.max(0, Math.min(N - 1, Math.floor(u))), j = Math.max(0, Math.min(N - 1, Math.floor(v))), a = u - i, b = v - j, n = N + 1, h = far.h;
  return (h[j * n + i] * (1 - a) + h[j * n + i + 1] * a) * (1 - b) + (h[(j + 1) * n + i] * (1 - a) + h[(j + 1) * n + i + 1] * a) * b;
}

export function makeHeight(data) {
  const { meta, dem, detail, far } = data;
  const base = { ...meta, width: meta.size, depth: meta.size, segx: 128, segz: 128, heights: dem.heights };
  const xmax = meta.xmin + meta.size, zmax = meta.zmin + meta.size;
  return (x, z) => {
    if (x < meta.xmin || x > xmax || z < meta.zmin || z > zmax) {
      return farSample(far, x, z) - (x * x + z * z) / (2 * R_EARTH);
    }
    const low = sampleGrid(base, x, z);
    const edge = Math.min(x - detail.xmin, detail.xmin + detail.width - x, z - detail.zmin, detail.zmin + detail.depth - z);
    if (edge <= 0) return low;
    const mix = Math.min(1, edge / (meta.size / 128));
    return low + (sampleGrid(detail, x, z) - low) * mix;
  };
}

// 近距離で見える草・土の細かな模様（タイル状のノイズ）を手続き的に作る
export function makeDetailTexture(renderer) {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), img = g.createImageData(S, S), d = img.data;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const val = new Float32Array(S * S);
  // 複数オクターブの値ノイズ（タイル可能）
  for (const [cells, amp] of [[8, 0.35], [32, 0.3], [128, 0.22], [512, 0.13]]) {
    const grid = new Float32Array(cells * cells).map(() => rnd());
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = x / S * cells, fy = y / S * cells, ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
      const sx = ax * ax * (3 - 2 * ax), sy = ay * ay * (3 - 2 * ay);
      const g00 = grid[(iy % cells) * cells + ix % cells], g10 = grid[(iy % cells) * cells + (ix + 1) % cells];
      const g01 = grid[((iy + 1) % cells) * cells + ix % cells], g11 = grid[((iy + 1) % cells) * cells + (ix + 1) % cells];
      val[y * S + x] += amp * ((g00 * (1 - sx) + g10 * sx) * (1 - sy) + (g01 * (1 - sx) + g11 * sx) * sy);
    }
  }
  for (let i = 0; i < S * S; i++) {
    const v = val[i], k = i * 4, blade = rnd() < 0.18 ? 0.12 : 0;
    d[k] = 255 * Math.min(1, 0.42 + v * 0.3 - blade);
    d[k + 1] = 255 * Math.min(1, 0.45 + v * 0.3 + blade * 0.3);
    d[k + 2] = 255 * Math.min(1, 0.40 + v * 0.25 - blade);
    d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.generateMipmaps = true;
  // 同じノイズの傾きからマイクロ法線マップを作る（低空で草地・土の凹凸が光の向きで陰影を持つ）
  const nd = new Uint8Array(S * S * 4), strength = 5.5;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const xm = (x - 1 + S) % S, xp = (x + 1) % S, ym = (y - 1 + S) % S, yp = (y + 1) % S;
    const dx = (val[y * S + xp] - val[y * S + xm]) * strength, dy = (val[yp * S + x] - val[ym * S + x]) * strength;
    const inv = 1 / Math.hypot(dx, dy, 1), k = (y * S + x) * 4;
    nd[k] = Math.round((-dx * inv * 0.5 + 0.5) * 255); nd[k + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
    nd[k + 2] = Math.round((inv * 0.5 + 0.5) * 255); nd[k + 3] = 255;
  }
  const nt = new THREE.DataTexture(nd, S, S);
  nt.wrapS = nt.wrapT = THREE.RepeatWrapping; nt.colorSpace = THREE.NoColorSpace;
  nt.generateMipmaps = true; nt.minFilter = THREE.LinearMipmapLinearFilter; nt.magFilter = THREE.LinearFilter;
  nt.anisotropy = t.anisotropy; nt.needsUpdate = true;
  t.userData.normalMap = nt;
  return t;
}

// 航空写真の地面マテリアル：写真の色を補正し、近距離では細部ノイズを重ねる。
export function makeGroundMaterial(map, detailTex, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.96, metalness: 0, vertexColors: !!opts.vertexColors });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.detailTex = { value: detailTex };
    sh.uniforms.detailNormalTex = { value: detailTex.userData.normalMap || detailTex };
    sh.uniforms.photoGrade = { value: new THREE.Vector3(opts.saturation ?? 1.08, opts.contrast ?? 1.0, opts.gain ?? 1.0) };
    Object.assign(sh.uniforms, cloudShadowUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D detailTex;\nuniform sampler2D detailNormalTex;\nuniform vec3 photoGrade;' + CLOUD_SHADOW_PARS)
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
          diffuseColor *= texture2D(map, vMapUv, -0.6);
        #endif
        {
          vec3 c = diffuseColor.rgb;
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(l), c, photoGrade.x);
          c = (c - 0.18) * photoGrade.y + 0.18;
          diffuseColor.rgb = max(c * photoGrade.z, 0.0);
          float dist = length(vWPos - cameraPosition);
          float fade = 1.0 - smoothstep(40.0, 600.0, dist);
          vec3 d1 = texture2D(detailTex, vWPos.xz / 2.7).rgb;
          vec3 d2 = texture2D(detailTex, vWPos.xz / 19.0).rgb;
          vec3 d3 = texture2D(detailTex, vWPos.xz / 157.0).rgb;
          vec3 det = d1 * d2 * 4.6;
          diffuseColor.rgb *= mix(vec3(1.0), det, fade * 0.75);
          diffuseColor.rgb *= mix(1.0, d3.g * 2.2, 0.25);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // マイクロ法線：近距離だけ（遠くはミップマップで平らになり、さらに距離で消す）
          float nfade = 1.0 - smoothstep(30.0, 420.0, length(vWPos - cameraPosition));
          if (nfade > 0.001) {
            vec2 n1 = texture2D(detailNormalTex, vWPos.xz / 2.7).xy * 2.0 - 1.0;
            vec2 n2 = texture2D(detailNormalTex, vWPos.xz / 17.0).xy * 2.0 - 1.0;
            vec3 wPerturb = vec3(n1.x + n2.x * 0.6, 0.0, n1.y + n2.y * 0.6) * (0.3 * nfade);
            normal = normalize(normal + (viewMatrix * vec4(wPerturb, 0.0)).xyz);
          }
        }`)
      .replace('#include <lights_fragment_begin>', cloudShadowLookup('vWPos') + lightsWithCloudShadow())
      .replace('#include <lights_fragment_end>', CLOUD_SKY_DIM + '#include <lights_fragment_end>');
  };
  m.customProgramCacheKey = () => 'ground51' + (opts.vertexColors ? 'vc' : '');
  return m;
}

export function buildLocalTerrain(scene, data, textures, height, detailTex) {
  const { meta, detail } = data;
  // 広域（約 8 km 四方）：詳細域の部分をくり抜く
  const geo = new THREE.PlaneGeometry(meta.size, meta.size, 128, 128); geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position, cx = meta.xmin + meta.size / 2, cz = meta.zmin + meta.size / 2;
  for (let i = 0; i < p.count; i++) p.setY(i, data.dem.heights[i]);
  const old = geo.index.array, ids = [];
  for (let k = 0; k < old.length; k += 3) {
    const x = (p.getX(old[k]) + p.getX(old[k + 1]) + p.getX(old[k + 2])) / 3 + cx, z = (p.getZ(old[k]) + p.getZ(old[k + 1]) + p.getZ(old[k + 2])) / 3 + cz;
    if (x < detail.xmin || x > detail.xmin + detail.width || z < detail.zmin || z > detail.zmin + detail.depth) ids.push(old[k], old[k + 1], old[k + 2]);
  }
  geo.setIndex(ids); geo.computeVertexNormals();
  const wide = new THREE.Mesh(geo, makeGroundMaterial(textures.wide, detailTex));
  wide.position.set(cx, 0, cz); wide.receiveShadow = true; scene.add(wide);

  // 詳細域：高解像度データがあればチャンクごとに、なければ同梱の 1 枚写真
  const chunks = textures.detailChunks;
  const meshes = [wide];
  for (const ch of chunks) {
    const segx = Math.max(8, Math.round(ch.width / (detail.width / detail.segx) * (ch.meshScale || 1)));
    const segz = Math.max(8, Math.round(ch.depth / (detail.depth / detail.segz) * (ch.meshScale || 1)));
    const g = new THREE.PlaneGeometry(ch.width, ch.depth, segx, segz); g.rotateX(-Math.PI / 2);
    const a = g.attributes.position, ccx = ch.xmin + ch.width / 2, ccz = ch.zmin + ch.depth / 2;
    for (let i = 0; i < a.count; i++) a.setY(i, height(a.getX(i) + ccx, a.getZ(i) + ccz));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, makeGroundMaterial(ch.texture, detailTex));
    mesh.position.set(ccx, 0, ccz); mesh.receiveShadow = true; scene.add(mesh); meshes.push(mesh);
  }
  return meshes;
}

// 遠景の畑・市街地のパッチワーク模様
function makeFarmTexture(renderer) {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.fillStyle = '#7f7f7f'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 1400; i++) {
    const w = 20 + rnd() * 70, h = 15 + rnd() * 50, x = rnd() * S, y = rnd() * S, v = 95 + rnd() * 80;
    g.fillStyle = `rgb(${v * (0.95 + rnd() * 0.12)},${v * (0.95 + rnd() * 0.15)},${v * (0.85 + rnd() * 0.1)})`;
    g.save(); g.translate(x, y); g.rotate((rnd() < 0.7 ? 0 : 0.3) + (rnd() - 0.5) * 0.08);
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) g.fillRect(dx, dy, w, h);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t;
}

function n2(x, z) { const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  return (n2(ix, iz) * (1 - sx) + n2(ix + 1, iz) * sx) * (1 - sz) + (n2(ix, iz + 1) * (1 - sx) + n2(ix + 1, iz + 1) * sx) * sz;
}

export function buildFarTerrain(scene, data, renderer, quality) {
  const { far, meta } = data;
  const step = quality === 0 ? 2 : 1, N = far.N / step;
  const geo = new THREE.PlaneGeometry(2 * far.half, 2 * far.half, N, N); geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position, colors = new Float32Array(p.count * 3), col = new THREE.Color();
  const inset = 120;
  const urbanTokyo = { x: (139.767 - 139.81657) * 90060, z: -(35.681 - 36.01565) * 110574 };
  const C = {
    sea: new THREE.Color(0x2e4a5c), paddy: new THREE.Color(0x9a8d6a), field: new THREE.Color(0x7d8656),
    town: new THREE.Color(0x8e8c86), forest: new THREE.Color(0x3d5134), forestHi: new THREE.Color(0x4a4f3b),
    rock: new THREE.Color(0x6e6458), snow: new THREE.Color(0xf2f4f7)
  };
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const k = j * (N + 1) + i, h = far.h[(j * step) * (far.N + 1) + i * step];
    const x = p.getX(k), z = p.getZ(k);
    // 傾斜
    const hx = far.h[(j * step) * (far.N + 1) + Math.min(far.N, i * step + 1)] - h;
    const hz = far.h[Math.min(far.N, j * step + 1) * (far.N + 1) + i * step] - h;
    const slope = Math.hypot(hx, hz) / (2 * far.half / far.N);
    const inside = x > meta.xmin + inset && x < meta.xmin + meta.size - inset && z > meta.zmin + inset && z < meta.zmin + meta.size - inset;
    p.setY(k, (inside ? h - 6 : h) - (x * x + z * z) / (2 * R_EARTH));
    // 土地被覆（簡易推定）
    const dT = Math.hypot(x - urbanTokyo.x, z - urbanTokyo.z) / 1000;
    const urban = THREE.MathUtils.clamp(1.15 - dT / 32, 0, 1) * 0.9 + vnoise(x / 4000, z / 4000) * 0.35 - 0.12;
    if (h <= 0.5 && slope < 0.01) col.copy(C.sea);
    else if (h > 2700) col.copy(C.snow).lerp(C.rock, THREE.MathUtils.clamp((3000 - h) / 300, 0, 1) * 0.5);
    else if (h > 150 || slope > 0.08) col.copy(C.forest).lerp(C.forestHi, THREE.MathUtils.clamp((h - 800) / 1200, 0, 1)).lerp(C.rock, THREE.MathUtils.clamp((slope - 0.6), 0, 0.6));
    else {
      col.copy(C.paddy).lerp(C.field, vnoise(x / 1500 + 7, z / 1500));
      col.lerp(C.town, THREE.MathUtils.clamp(urban, 0, 1));
      col.lerp(C.forest, THREE.MathUtils.clamp(vnoise(x / 900 - 3, z / 900) - 0.62, 0, 1) * 1.6);
    }
    colors[k * 3] = col.r; colors[k * 3 + 1] = col.g; colors[k * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, p.getX(k) / 900, p.getZ(k) / 900);
  geo.computeVertexNormals();
  const farm = makeFarmTexture(renderer);
  const mat = new THREE.MeshStandardMaterial({ map: farm, vertexColors: true, roughness: 0.95 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cloudShadowUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;' + CLOUD_SHADOW_PARS)
      .replace('#include <map_fragment>', `
      vec4 farmT = texture2D(map, vMapUv);
      diffuseColor.rgb *= mix(vec3(1.0), farmT.rgb * 1.7, 0.55);`)
      .replace('#include <lights_fragment_begin>', cloudShadowLookup('vWPos') + lightsWithCloudShadow())
      .replace('#include <lights_fragment_end>', CLOUD_SKY_DIM + '#include <lights_fragment_end>');
  };
  mat.customProgramCacheKey = () => 'farTerrain51';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = false; mesh.renderOrder = -1;
  scene.add(mesh);
  return mesh;
}
