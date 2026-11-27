// 地形：滑空場周辺の詳細地形（航空写真＋DEM5）、約8km四方の広域地形、約300km四方の遠景地形（地球の丸み付き）。
import * as THREE from 'three';
import { groundDetailUniforms, GROUND_PBR_PARS, GROUND_PBR_ALBEDO, GROUND_PBR_ROUGHNESS, GROUND_PBR_NORMAL } from './ground.js';
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
  // OpenStreetMap の建物・道路・土地利用（scripts/fetch-osm.mjs で作成。なければ従来どおり写真だけで景観を作る）
  let osm = null;
  try { const r = await fetch('data/osm.json'); if (r.ok) osm = await r.json(); } catch { /* なし */ }
  // 遠景の土地被覆（ESA WorldCover。scripts/build-far-landcover.mjs で作成。なければ従来の推定色）
  let landcover = null;
  try {
    const r = await fetch('data/landcover.json');
    if (r.ok) {
      landcover = await r.json();
      for (const [name, g] of Object.entries(landcover.grids)) g.classes = await readClassPng('data/landcover_' + name + '.png', g.N);
    }
  } catch (e) { console.warn('土地被覆マップを読み込めませんでした（遠景は推定色）', e); landcover = null; }
  return { meta, dem, detail, scenery, far, hires, osm, landcover };
}

// 8 ビットのグレースケール PNG（分類コード）を読む。色空間の変換で値が変わらないよう、変換なしで展開する。
async function readClassPng(url, N) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(N, N), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, N, N); bmp.close();
  const rgba = g.getImageData(0, 0, N, N).data, out = new Uint8Array(N * N);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
  return out;
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
  const gd = opts.groundDetail || null; // 写真ベースの PBR 素材（quality 1 以上。ground.js）
  m.onBeforeCompile = (sh) => {
    if (gd) Object.assign(sh.uniforms, groundDetailUniforms(gd));
    sh.uniforms.detailTex = { value: detailTex };
    sh.uniforms.detailNormalTex = { value: detailTex.userData.normalMap || detailTex };
    sh.uniforms.photoGrade = { value: new THREE.Vector3(opts.saturation ?? 1.08, opts.contrast ?? 1.0, opts.gain ?? 1.0) };
    Object.assign(sh.uniforms, cloudShadowUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D detailTex;\nuniform sampler2D detailNormalTex;\nuniform vec3 photoGrade;' + (gd ? GROUND_PBR_PARS : '') + CLOUD_SHADOW_PARS)
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
${gd ? '' : `
          float dist = length(vWPos - cameraPosition);
          float fade = 1.0 - smoothstep(40.0, 600.0, dist);
          vec3 d1 = texture2D(detailTex, vWPos.xz / 2.7).rgb;
          vec3 d2 = texture2D(detailTex, vWPos.xz / 19.0).rgb;
          vec3 d3 = texture2D(detailTex, vWPos.xz / 157.0).rgb;
          vec3 det = d1 * d2 * 4.6;
          diffuseColor.rgb *= mix(vec3(1.0), det, fade * 0.75);
          diffuseColor.rgb *= mix(1.0, d3.g * 2.2, 0.25);
`}
        }
        ${gd ? GROUND_PBR_ALBEDO : ''}`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + (gd ? GROUND_PBR_NORMAL : `
        {
          // マイクロ法線：近距離だけ（遠くはミップマップで平らになり、さらに距離で消す）
          float nfade = 1.0 - smoothstep(30.0, 420.0, length(vWPos - cameraPosition));
          if (nfade > 0.001) {
            vec2 n1 = texture2D(detailNormalTex, vWPos.xz / 2.7).xy * 2.0 - 1.0;
            vec2 n2 = texture2D(detailNormalTex, vWPos.xz / 17.0).xy * 2.0 - 1.0;
            vec3 wPerturb = vec3(n1.x + n2.x * 0.6, 0.0, n1.y + n2.y * 0.6) * (0.3 * nfade);
            normal = normalize(normal + (viewMatrix * vec4(wPerturb, 0.0)).xyz);
          }
        }`))
      .replace('#include <roughnessmap_fragment>', gd ? GROUND_PBR_ROUGHNESS : '#include <roughnessmap_fragment>')
      .replace('#include <lights_fragment_begin>', cloudShadowLookup('vWPos') + lightsWithCloudShadow())
      .replace('#include <lights_fragment_end>', CLOUD_SKY_DIM + '#include <lights_fragment_end>');
  };
  m.customProgramCacheKey = () => 'ground52' + (opts.vertexColors ? 'vc' : '') + (gd ? 'pbr' : '');
  return m;
}

export function buildLocalTerrain(scene, data, textures, height, detailTex, groundDetail = null) {
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
  const wide = new THREE.Mesh(geo, makeGroundMaterial(textures.wide, detailTex, { groundDetail }));
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
    const mesh = new THREE.Mesh(g, makeGroundMaterial(ch.texture, detailTex, { groundDetail }));
    mesh.position.set(ccx, 0, ccz); mesh.receiveShadow = true; scene.add(mesh); meshes.push(mesh);
  }
  return meshes;
}

// ---- 遠景の土地被覆テクスチャ ----
// 分類ごとの色は、ビルドスクリプトが同梱の航空写真と重なる所で測った平均色（landcover.json の palette）。
// 写真に無い分類（雪氷・低木など）だけ下の既定色を使う。
const LC_DEFAULT = {
  10: [62, 72, 52], 20: [112, 106, 82], 30: [136, 127, 104], 40: [124, 114, 92], 50: [136, 130, 128],
  60: [160, 150, 140], 70: [238, 240, 244], 80: [62, 70, 82], 90: [104, 104, 88], 95: [60, 75, 55], 100: [130, 128, 110]
};
// 粒のばらつき（1 画素ごと）と、畑・市街地の区画ごとのまだら（約 100 m 角）の強さ
const LC_GRAIN = { 10: [0.10, 0.12], 40: [0.07, 0.20], 50: [0.06, 0.10], 30: [0.06, 0.10] };

function lcHash(i, j, s) { let h = (i * 374761393 + j * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const srgbToLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const linToSrgb = v => { v = Math.max(0, Math.min(1, v)); return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)); };

function makeLandcoverTexture(lc, grid, renderer) {
  const { N, half, classes } = grid, px = 2 * half / N;
  const pal = {};
  for (const c of Object.keys(LC_DEFAULT)) pal[c] = (lc.palette?.[c]?.color || LC_DEFAULT[c]).map(srgbToLin);
  const cell = Math.max(1, Math.round(100 / px));   // 区画のまだらの大きさ（画素）
  const out = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, c = classes[k], base = pal[c] || pal[30];
    const [ga, pa] = LC_GRAIN[c] || [0.05, 0.06];
    const pi = Math.floor(i / cell), pj = Math.floor(j / cell);
    const parcel = lcHash(pi, pj, c) * 2 - 1, grain = lcHash(i, j, 7) * 2 - 1;
    const m = 1 + parcel * pa + grain * ga;
    // 畑の区画は緑み（麦・野菜）と茶色（刈り跡・裸地）に少し振る
    const hue = c === 40 ? (lcHash(pi, pj, 3) - 0.5) * 0.16 : 0;
    out[k * 4] = linToSrgb(base[0] * m * (1 - hue));
    out[k * 4 + 1] = linToSrgb(base[1] * m * (1 + hue * 0.6));
    out[k * 4 + 2] = linToSrgb(base[2] * m * (1 - hue * 0.8));
    out[k * 4 + 3] = c === 80 ? 255 : c === 90 ? 90 : 0;   // A：水面（反射を強くする）
  }
  const t = new THREE.DataTexture(out, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.needsUpdate = true;
  return t;
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
  const p = geo.attributes.position, colors = new Float32Array(p.count * 3), alpine = new Float32Array(p.count * 3), col = new THREE.Color();
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
    // 広域地形の下へ十分に沈める（江戸川の河道は周りより 10 m 近く低く、遠景地形が突き出して見えていた）
    p.setY(k, (inside ? h - 40 : h) - (x * x + z * z) / (2 * R_EARTH));
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
    // 土地被覆マップを使うとき：雪・岩・海だけは標高と傾斜から決める
    alpine[k * 3] = h > 2700 ? THREE.MathUtils.clamp((h - 2700) / 300, 0, 1) : 0;
    alpine[k * 3 + 1] = THREE.MathUtils.clamp(slope - 0.6, 0, 0.6) * (h > 150 ? 1 : 0);
    alpine[k * 3 + 2] = h <= 0.5 && slope < 0.01 ? 1 : 0;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('alpine', new THREE.BufferAttribute(alpine, 3));
  const uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, p.getX(k) / 900, p.getZ(k) / 900);
  geo.computeVertexNormals();
  const farm = makeFarmTexture(renderer);
  const lc = data.landcover;
  const lcTex = lc ? { mid: makeLandcoverTexture(lc, lc.grids.mid, renderer), far: makeLandcoverTexture(lc, lc.grids.far, renderer) } : null;
  const mat = new THREE.MeshStandardMaterial({ map: farm, vertexColors: !lcTex, roughness: 0.95 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cloudShadowUniforms);
    if (lcTex) Object.assign(sh.uniforms, {
      lcMid: { value: lcTex.mid }, lcFar: { value: lcTex.far },
      lcHalf: { value: new THREE.Vector2(lc.grids.mid.half, lc.grids.far.half) }
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;' + (lcTex ? '\nattribute vec3 alpine;\nvarying vec3 vAlpine;' : ''))
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;' + (lcTex ? '\nvAlpine = alpine;' : ''));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;' + CLOUD_SHADOW_PARS + (lcTex ? `
      varying vec3 vAlpine;
      uniform sampler2D lcMid, lcFar;
      uniform vec2 lcHalf;
      float lcWater = 0.0;` : ''))
      .replace('#include <map_fragment>', lcTex ? `
      {
        // 実際の土地被覆（近い ±25 km は約 24 m/画素、その先 ±150 km は約 146 m/画素）。境目は 3 km かけて混ぜる
        vec4 cF = texture2D(lcFar, (vWPos.xz + lcHalf.y) / (2.0 * lcHalf.y));
        vec4 cM = texture2D(lcMid, (vWPos.xz + lcHalf.x) / (2.0 * lcHalf.x));
        vec2 e = smoothstep(lcHalf.x, lcHalf.x - 3000.0, abs(vWPos.xz));
        vec4 lc = mix(cF, cM, e.x * e.y);
        lcWater = lc.a;
        vec3 c = lc.rgb;
        // 外洋は川・湖より深い色
        c = mix(c, vec3(0.022, 0.05, 0.075), vAlpine.z * lcWater);
        // 急斜面の岩、高山の雪
        c = mix(c, vec3(0.16, 0.13, 0.1), vAlpine.y);
        c = mix(c, vec3(0.88, 0.9, 0.94), vAlpine.x);
        // 畑の区画模様（遠くはミップマップで平らになる）。水面と雪には載せない
        vec4 farmT = texture2D(map, vMapUv);
        c *= mix(vec3(1.0), farmT.rgb * 1.7, 0.32 * (1.0 - lcWater) * (1.0 - vAlpine.x));
        // 航空写真と同じ色の補正（彩度 1.08）
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        diffuseColor.rgb = mix(vec3(l), c, 1.08);
      }` : `
      vec4 farmT = texture2D(map, vMapUv);
      diffuseColor.rgb *= mix(vec3(1.0), farmT.rgb * 1.7, 0.55);`)
      .replace('#include <roughnessmap_fragment>', lcTex
        ? '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.32, lcWater * (1.0 - vAlpine.x));'
        : '#include <roughnessmap_fragment>')
      .replace('#include <lights_fragment_begin>', cloudShadowLookup('vWPos') + lightsWithCloudShadow())
      .replace('#include <lights_fragment_end>', CLOUD_SKY_DIM + '#include <lights_fragment_end>');
  };
  mat.customProgramCacheKey = () => 'farTerrain53' + (lcTex ? 'lc' : '');
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = false; mesh.renderOrder = -1;
  scene.add(mesh);
  return mesh;
}
