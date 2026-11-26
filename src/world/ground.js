// 地面の近距離ディテール：写真ベースの PBR 素材（芝・土・舗装。Poly Haven, CC0）を、
// OpenStreetMap の道路・土地利用から作った「素材マスク」と航空写真の色で塗り分ける。
// 色の大部分は航空写真のまま（実際の場所の色）で、素材は近くの細かな凹凸・粒・ざらつきだけを足す。
import * as THREE from 'three';

const KINDS = ['grass', 'soil', 'asphalt'];
// 道路の幅 [m]（OSM に width が無いとき）
const ROAD_W = { motorway: 14, trunk: 11, primary: 10, secondary: 8, tertiary: 6.5, unclassified: 5, residential: 5, living_street: 4.5, service: 3.5, track: 2.8, cycleway: 2, footway: 1.6, path: 1.4 };
const UNPAVED = /^(unpaved|dirt|earth|ground|gravel|grass|sand|mud|compacted|fine_gravel)$/;
const GRASSY = /^(grass|meadow|recreation_ground|village_green|natural:grassland|leisure:park|leisure:pitch|leisure:golf_course|aeroway:.*|natural:heath)$/;
const SOIL = /^(farmland|farmyard|orchard|allotments|construction|brownfield)$/;

function loadImage(url) {
  return new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ng(Error(url)); im.src = url; });
}
function repeatTex(src, srgb, aniso) {
  const t = new THREE.Texture(src); t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}
// 素材の平均色（線形）：シェーダーで「色のゆらぎ」だけを取り出すのに使う
function meanLinear(im) {
  const S = 32, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data, lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const m = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) m[k] += lin(d[i + k]);
  return new THREE.Vector3(...m.map(v => v / (S * S)));
}
// 法線（RG）と粗さ（B）を 1 枚にまとめる：地面のシェーダーで使うテクスチャの数を抑える（上限 16 枚）
function packNormalRough(nIm, rIm) {
  const S = nIm.width, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(rIm, 0, 0, S, S); const r = g.getImageData(0, 0, S, S).data;
  g.drawImage(nIm, 0, 0, S, S); const img = g.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i + 2] = r[i + 1]; d[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  return c;
}

// 素材マスク：R = 舗装、G = 土（畑・未舗装路）、B = 芝・草地（滑走路・河川敷・公園）
function makeMaterialMask(osm, rect, size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), sx = size / rect.width, sz = size / rect.depth;
  const P = ([x, z]) => [(x - rect.xmin) * sx, (z - rect.zmin) * sz];
  g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'lighter';
  const poly = (pts, color) => { g.fillStyle = color; g.beginPath(); pts.forEach((p, i) => { const [u, v] = P(p); i ? g.lineTo(u, v) : g.moveTo(u, v); }); g.closePath(); g.fill(); };
  for (const a of osm.areas || []) {
    if (GRASSY.test(a.kind)) poly(a.pts, '#0000ff');
    else if (SOIL.test(a.kind)) poly(a.pts, '#00ff00');
  }
  g.globalCompositeOperation = 'source-over';
  g.lineCap = g.lineJoin = 'round';
  const roads = [...(osm.roads || [])].sort((a, b) => (ROAD_W[a.kind] || 4) - (ROAD_W[b.kind] || 4));
  for (const r of roads) {
    if (r.bridge) continue;
    const w = r.width || (r.lanes ? r.lanes * 3.2 : ROAD_W[r.kind]);
    if (!w) continue;
    const dirt = r.kind === 'track' ? !/^(asphalt|paved|concrete)$/.test(r.surface || '') : UNPAVED.test(r.surface || '');
    g.strokeStyle = dirt ? '#00ff00' : '#ff0000';
    g.lineWidth = Math.max(1, w * sx);
    g.beginPath(); r.pts.forEach((p, i) => { const [u, v] = P(p); i ? g.lineTo(u, v) : g.moveTo(u, v); }); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; // キャンバスの行 = z（南向き）。世界座標からそのまま引く
  t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  return t;
}

// quality 1 以上で使う（0＝ノートPC向けは従来の手続き的ノイズのまま）
export async function loadGroundDetail(data, renderer, quality) {
  if (quality < 1) return null;
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const tex = {}, mean = {};
  try {
    for (const k of KINDS) {
      const [a, n, r] = await Promise.all(['albedo', 'normal', 'rough'].map(x => loadImage(`data/pbr/${k}_${x}.jpg`)));
      tex[k + 'Albedo'] = repeatTex(a, true, aniso); mean[k] = meanLinear(a);
      tex[k + 'NR'] = repeatTex(packNormalRough(n, r), false, aniso);
    }
  } catch (e) { console.warn('PBR 素材を読めませんでした（従来の地面で続けます）', e); return null; }
  const m = data.meta, rect = { xmin: m.xmin, zmin: m.zmin, width: m.size, depth: m.size };
  const mask = data.osm ? makeMaterialMask(data.osm, rect, quality >= 2 ? 4096 : 2048) : null;
  return { tex, mean, mask, rect };
}

// makeGroundMaterial の onBeforeCompile から使う：ユニフォームとシェーダー断片
export function groundDetailUniforms(gd) {
  const u = {};
  for (const [k, v] of Object.entries(gd.tex)) u['pbr' + k[0].toUpperCase() + k.slice(1)] = { value: v };
  u.pbrMean = { value: [gd.mean.grass, gd.mean.soil, gd.mean.asphalt] };
  u.pbrMask = { value: gd.mask || new THREE.DataTexture(new Uint8Array(4), 1, 1) };
  u.pbrMaskRect = { value: new THREE.Vector4(gd.rect.xmin, gd.rect.zmin, 1 / gd.rect.width, 1 / gd.rect.depth) };
  u.pbrMaskOn = { value: gd.mask ? 1 : 0 };
  return u;
}

export const GROUND_PBR_PARS = /* glsl */`
uniform sampler2D pbrGrassAlbedo, pbrSoilAlbedo, pbrAsphaltAlbedo;
uniform sampler2D pbrGrassNR, pbrSoilNR, pbrAsphaltNR;
uniform vec3 pbrMean[3];
uniform sampler2D pbrMask; uniform vec4 pbrMaskRect; uniform float pbrMaskOn;
vec3 pbrW; float pbrFade;
// 素材の色を平均色で割って「明るさ・色のゆらぎ」だけにする（色そのものは航空写真に任せる）
vec3 pbrDetail(sampler2D t, vec2 uv, vec3 avg) {
  vec3 r = texture2D(t, uv).rgb / (avg + 1e-3);
  return mix(vec3(dot(r, vec3(0.299, 0.587, 0.114))), r, 0.1);
}
`;

// 航空写真の色 c（diffuseColor.rgb）と素材マスクから重みを決め、近距離ほど素材の細部を掛ける
export const GROUND_PBR_ALBEDO = /* glsl */`
{
  float dist = length(vWPos - cameraPosition);
  pbrFade = 1.0 - smoothstep(25.0, 700.0, dist);
  vec4 mk = pbrMaskOn > 0.5 ? texture2D(pbrMask, (vWPos.xz - pbrMaskRect.xy) * pbrMaskRect.zw) : vec4(0.0);
  vec3 c = diffuseColor.rgb;
  float green = smoothstep(0.0, 0.05, c.g - max(c.r, c.b) * 0.92);
  float wA = clamp(mk.r * 1.2, 0.0, 1.0);
  float wG = (1.0 - wA) * clamp(max(mk.b, green) - mk.g * 0.6, 0.0, 1.0);
  float wS = max(0.0, 1.0 - wA - wG);
  pbrW = vec3(wG, wS, wA);
  if (pbrFade > 0.001) {
    vec3 det = pbrDetail(pbrGrassAlbedo, vWPos.xz / 3.0, pbrMean[0]) * wG
             + pbrDetail(pbrSoilAlbedo, vWPos.xz / 2.6, pbrMean[1]) * wS
             + pbrDetail(pbrAsphaltAlbedo, vWPos.xz / 5.5, pbrMean[2]) * wA;
    // 遠目では 2 段目の大きなスケールも重ねて、繰り返し模様を目立たなくする
    vec3 det2 = pbrDetail(pbrGrassAlbedo, vWPos.xz / 23.0, pbrMean[0]) * wG + pbrDetail(pbrSoilAlbedo, vWPos.xz / 19.0, pbrMean[1]) * wS + vec3(wA);
    diffuseColor.rgb *= mix(vec3(1.0), det * mix(vec3(1.0), det2, 0.5), pbrFade * 0.6);
    // 素材の明暗を重ねると色が少しくすむので、芝だけ彩度を戻す
    float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = max(mix(vec3(lum), diffuseColor.rgb, 1.0 + 0.3 * wG * pbrFade), 0.0);
  }
}
`;

export const GROUND_PBR_ROUGHNESS = /* glsl */`
#include <roughnessmap_fragment>
if (pbrFade > 0.001) {
  float rr = texture2D(pbrGrassNR, vWPos.xz / 3.0).b * pbrW.x + texture2D(pbrSoilNR, vWPos.xz / 2.6).b * pbrW.y + texture2D(pbrAsphaltNR, vWPos.xz / 5.5).b * pbrW.z;
  roughnessFactor = mix(roughnessFactor, clamp(rr, 0.75, 1.0), pbrFade);
}
`;

// 法線（OpenGL 形式）：地面はほぼ水平なので、接線空間の xy を世界の x・z の傾きとして足す
export const GROUND_PBR_NORMAL = /* glsl */`
if (pbrFade > 0.001) {
  vec2 nG = texture2D(pbrGrassNR, vWPos.xz / 3.0).xy * 2.0 - 1.0;
  vec2 nS = texture2D(pbrSoilNR, vWPos.xz / 2.6).xy * 2.0 - 1.0;
  vec2 nA = texture2D(pbrAsphaltNR, vWPos.xz / 5.5).xy * 2.0 - 1.0;
  vec2 n2 = nG * pbrW.x + nS * pbrW.y + nA * pbrW.z;
  vec3 wPerturb = vec3(n2.x, 0.0, -n2.y) * (0.45 * pbrFade);
  normal = normalize(normal + (viewMatrix * vec4(wPerturb, 0.0)).xyz);
}
`;
