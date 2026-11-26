// 積雲：上昇気流の上（雲底）にできる。
// v5.1：数千枚の Sprite を 1 回の描画（インスタンス化したビルボード）にまとめ、
// 太陽の向き・色に応じた陰影と逆光の縁の明るさを GPU で計算する。
// 雲の影は実際の雲の位置から太陽方向へ投影した影マップとして作り、地面の直射光だけを弱める。
import * as THREE from 'three';

// 雲の影マップ（地形のマテリアルが参照する共有ユニフォーム）
const SHADOW_HALF = 60000; // 影マップの範囲（原点から ±60 km）
const KM = 0.001;
const blankShadow = new THREE.DataTexture(new Uint8Array(4), 1, 1);
blankShadow.needsUpdate = true;
export const cloudShadowUniforms = {
  cloudShadowMap: { value: blankShadow },
  // km 単位（極端に大きい／小さい数を避け、GPU の精度に依存しないようにする）
  cloudShadowRect: { value: new THREE.Vector3(-SHADOW_HALF * KM, -SHADOW_HALF * KM, 1 / (2 * SHADOW_HALF * KM)) },
  cloudShadowOn: { value: 0 },
};

// 地形のフラグメントシェーダー用：直射光の通りやすさ cloudSunVis（1 = 日なた、0 = 雲の影）
export const CLOUD_SHADOW_PARS = /* glsl */`
uniform sampler2D cloudShadowMap;
uniform vec3 cloudShadowRect;
uniform float cloudShadowOn;
`;
export const cloudShadowLookup = (wpos) => /* glsl */`
  float cloudSunVis = 1.0 - cloudShadowOn * textureLod(cloudShadowMap, (${wpos}.xz * 0.001 - cloudShadowRect.xy) * cloudShadowRect.z, 0.0).r;
`;
// lights_fragment_begin の太陽（平行光源）に雲の影を掛ける。
// 空からの拡散光は大半が残るが、雲が空の一部を覆う分（最大 30%）だけ弱める（cloudSkyDim を lights_fragment_end の前に挿入）。
export const CLOUD_SKY_DIM = /* glsl */`
  irradiance *= 1.0 - 0.3 * (1.0 - cloudSunVis);
  iblIrradiance *= 1.0 - 0.3 * (1.0 - cloudSunVis);
`;
export const lightsWithCloudShadow = () => THREE.ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= cloudSunVis;'
);

function puffTexture() {
  // R：細かな濃淡ノイズ、G：中心からの厚み（縁ほど 0）、A：不透明度
  const S = 256, d = new Uint8Array(S * S * 4);
  let seed = 17; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const noise = new Float32Array(S * S);
  for (const [cells, amp] of [[4, 0.45], [8, 0.28], [16, 0.16], [32, 0.11]]) {
    const grid = new Float32Array(cells * cells).map(() => rnd());
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = x / S * cells, fy = y / S * cells, ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
      const sx = ax * ax * (3 - 2 * ax), sy = ay * ay * (3 - 2 * ay);
      const g00 = grid[(iy % cells) * cells + ix % cells], g10 = grid[(iy % cells) * cells + (ix + 1) % cells];
      const g01 = grid[((iy + 1) % cells) * cells + ix % cells], g11 = grid[((iy + 1) % cells) * cells + (ix + 1) % cells];
      noise[y * S + x] += amp * ((g00 * (1 - sx) + g10 * sx) * (1 - sy) + (g01 * (1 - sx) + g11 * sx) * sy);
    }
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const nx = (x + 0.5) / S * 2 - 1, ny = (y + 0.5) / S * 2 - 1, r = Math.hypot(nx, ny), n = noise[y * S + x];
    const radial = Math.max(0, 1 - r * (0.95 + (0.5 - n) * 0.55));
    // 回転させても四角の縁が見えないよう、内接円の外は必ず透明にする
    const rim = THREE.MathUtils.smoothstep(1 - r, 0, 0.2);
    const alpha = Math.pow(Math.min(1, radial * 1.45), 1.65) * rim;
    const k = (y * S + x) * 4;
    d[k] = Math.round(n * 255); d[k + 1] = Math.round(Math.min(1, radial) * 255); d[k + 2] = 0; d[k + 3] = Math.round(alpha * 255);
  }
  const t = new THREE.DataTexture(d, S, S);
  t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

// 雲の塊を太陽と反対側の地面へ投影して影マップを作る（球の影は太陽高度が低いほど方位方向へ伸びる楕円）
function buildShadowMap(puffs, sunDir, height, quality) {
  const S = quality >= 2 ? 2048 : 1024, mpp = 2 * SHADOW_HALF / S;
  const acc = new Float32Array(S * S);
  const up = Math.max(0.15, sunDir.y);
  const hx = sunDir.x, hz = sunDir.z, hl = Math.hypot(hx, hz) || 1, ax = hx / hl, az = hz / hl;
  const stretch = 1 / up;
  for (const p of puffs) {
    // 影の位置：puff から太陽と逆向きに地面まで（1 回だけ地面の高さで補正）
    let H = p.y - height(p.x, p.z);
    let sx = p.x - sunDir.x / up * H, sz = p.z - sunDir.z / up * H;
    H = p.y - height(sx, sz); sx = p.x - sunDir.x / up * H; sz = p.z - sunDir.z / up * H;
    const R = p.sx * 0.42, Ra = R * stretch;
    const cx = (sx + SHADOW_HALF) / mpp, cz = (sz + SHADOW_HALF) / mpp, rp = Ra / mpp + 1;
    const i0 = Math.max(1, Math.floor(cx - rp)), i1 = Math.min(S - 2, Math.ceil(cx + rp));
    const j0 = Math.max(1, Math.floor(cz - rp)), j1 = Math.min(S - 2, Math.ceil(cz + rp));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * mpp - SHADOW_HALF - sx, dz = (j + 0.5) * mpp - SHADOW_HALF - sz;
      const along = dx * ax + dz * az, perp = -dx * az + dz * ax;
      const q = (along / Ra) ** 2 + (perp / R) ** 2;
      if (q < 1) acc[j * S + i] += (1 - q) * (1 - q) * p.w;
    }
  }
  // RGBA8（どの GPU でも確実にフィルタリングできる形式）。値は R に入れる
  const data = new Uint8Array(S * S * 4);
  // 積雲の芯はほぼ直射光を通さない（影の中心で直射光 5% 程度）。縁は柔らかく減衰
  for (let i = 0; i < S * S; i++) data[i * 4] = Math.round(255 * 0.95 * (1 - Math.exp(-2.5 * acc[i])));
  const t = new THREE.DataTexture(data, S, S);
  t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aCenter;
  attribute vec4 aMeta;   // 幅, 高さ, 雲の中の高さ比, 回転
  attribute float aThermal;
  varying vec2 vUv;
  varying float vY;
  varying float vHRatio;
  varying float vThermal;
  varying float vCamFade;
  varying vec3 vCenter;
  void main() {
    // 画面に正対するビルボード（Sprite と同じ向き）。模様だけ回転させ、上下の陰影は回転させない
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 worldPos = aCenter + camRight * (position.x * aMeta.x) + camUp * (position.y * aMeta.y);
    float c = cos(aMeta.w), s = sin(aMeta.w);
    vec2 q = uv - 0.5;
    vUv = vec2(q.x * c - q.y * s, q.x * s + q.y * c) + 0.5;
    vY = position.y + 0.5;
    vHRatio = aMeta.z;
    vThermal = aThermal;
    vCenter = aCenter;
    // カメラが雲の中に入ったときに描画が破綻しないよう、近い雲は薄くする
    vCamFade = clamp((length(aCenter - cameraPosition) / max(aMeta.x, 1.0) - 0.25) / 0.6, 0.0, 1.0);
    vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uMap;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uHazeColor;
  varying vec2 vUv;
  varying float vY;
  varying float vHRatio;
  varying float vThermal;
  varying float vCamFade;
  varying vec3 vCenter;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 texel = texture2D(uMap, vUv);
    float alpha = texel.a * 0.9 * vCamFade;
    if (alpha < 0.004) discard;
    float sunUp = clamp(uSunDir.y * 1.8, 0.08, 1.0);
    // 上ほど日が当たって明るく、雲底は灰色（上昇気流の雲は底が少し暗い）
    float heightLit = clamp(vHRatio * 0.6 + vY * 0.35 + (texel.r - 0.5) * 0.35, 0.0, 1.0);
    float thermalDark = mix(0.04, 0.18, vThermal);
    vec3 baseShadow = mix(vec3(0.46, 0.53, 0.62), uHazeColor * 0.85, 0.5) * (1.0 - thermalDark * (1.0 - vHRatio));
    vec3 litCol = mix(vec3(0.96, 0.97, 0.99), uSunColor * 1.15, 0.65);
    vec3 col = mix(baseShadow, litCol, heightLit) * (0.95 + 1.45 * sunUp);
    // 逆光：厚い中心は暗く、薄い縁は前方散乱で明るく光る（シルバーライニング）
    vec3 viewDir = normalize(vCenter - cameraPosition);
    float fwd = pow(max(0.0, dot(viewDir, normalize(uSunDir)) * 0.5 + 0.5), 6.0);
    float edge = 1.0 - smoothstep(0.15, 0.85, texel.g);
    col *= 1.0 - 0.3 * fwd * (1.0 - edge);
    col += uSunColor * fwd * edge * 1.2 * sunUp;
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export function buildClouds(scene, atmo, height, env, quality, enabled) {
  const group = new THREE.Group(); scene.add(group);
  const sunDir = env.sunDir;
  if (!enabled) { cloudShadowUniforms.cloudShadowOn.value = 0; return { group, update() {}, dispose() { scene.remove(group); } }; }
  let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const base = atmo.cloudBase;
  const centers = [];
  // 上昇気流の上に雲（風で流された位置）
  for (const t of atmo.thermals) {
    const [cx, cz] = atmo.thermalCenter(t, base);
    centers.push({ x: cx, z: cz, size: t.r * 1.6 + 150, tall: 250 + t.w * 120, thermal: 1 });
  }
  // 遠くの雲（景観用）
  const extra = [8, 25, 45, 70][quality];
  for (let i = 0; i < extra; i++) {
    const a = rnd() * 6.28, d = 5000 + rnd() * 45000;
    centers.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, size: 400 + rnd() * 900, tall: 200 + rnd() * 600, thermal: 0 });
  }
  const per = [14, 24, 34, 46][quality];
  const puffs = [];
  for (const c of centers) {
    const g0 = height(c.x, c.z) + base;
    c.base = g0 + c.size * 0.18 - c.size * 0.2; // 立体雲（atmospherePass.js）の雲底
    for (let i = 0; i < per; i++) {
      const a = rnd() * 6.28, r = Math.sqrt(rnd()) * c.size * 0.55;
      const hRatio = Math.pow(rnd(), 1.4), h = hRatio * c.tall;
      const shrink = 1 - hRatio * 0.55;
      const s = (c.size * 0.45 + rnd() * c.size * 0.3) * (0.7 + shrink * 0.4);
      puffs.push({
        x: c.x + Math.cos(a) * r * shrink, y: g0 + h + c.size * 0.18, z: c.z + Math.sin(a) * r * shrink,
        sx: s, sy: s * 0.8, hRatio, thermal: c.thermal, rot: rnd() * 6.2832, w: 9 / per
      });
    }
  }

  const count = puffs.length;
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index; geo.setAttribute('position', quad.attributes.position); geo.setAttribute('uv', quad.attributes.uv);
  const aCenter = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const aMeta = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aThermal = new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aCenter', aCenter); geo.setAttribute('aMeta', aMeta); geo.setAttribute('aThermal', aThermal);
  geo.instanceCount = count;

  const tex = puffTexture();
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uMap: { value: null }, uSunDir: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Color() }, uHazeColor: { value: new THREE.Color() }
    }]),
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, fog: true
  });
  mat.uniforms.uMap.value = tex;
  mat.uniforms.uSunDir.value.copy(sunDir);
  mat.uniforms.uSunColor.value.copy(env.sun.color);
  mat.uniforms.uHazeColor.value.copy(env.fogColor);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // 位置はシェーダーで決まるので、カリングはしない
  group.add(mesh);

  // 半透明を正しく重ねるため、カメラから遠い順に並べ替える（カメラが一定距離動いたときだけ）
  const order = new Uint32Array(count).map((_, i) => i), dist = new Float32Array(count);
  const lastCam = new THREE.Vector3(Infinity, 0, 0);
  function sort(camPos) {
    for (let i = 0; i < count; i++) { const p = puffs[i]; dist[i] = (p.x - camPos.x) ** 2 + (p.y - camPos.y) ** 2 + (p.z - camPos.z) ** 2; }
    order.sort((a, b) => dist[b] - dist[a]);
    const C = aCenter.array, M = aMeta.array, T = aThermal.array;
    for (let k = 0; k < count; k++) {
      const p = puffs[order[k]];
      C[k * 3] = p.x; C[k * 3 + 1] = p.y; C[k * 3 + 2] = p.z;
      M[k * 4] = p.sx; M[k * 4 + 1] = p.sy; M[k * 4 + 2] = p.hRatio; M[k * 4 + 3] = p.rot;
      T[k] = p.thermal;
    }
    aCenter.needsUpdate = aMeta.needsUpdate = aThermal.needsUpdate = true;
    lastCam.copy(camPos);
  }

  // 雲の影
  const shadowTex = buildShadowMap(puffs, sunDir, height, quality);
  const old = cloudShadowUniforms.cloudShadowMap.value;
  cloudShadowUniforms.cloudShadowMap.value = shadowTex;
  if (old !== blankShadow) old.dispose();
  cloudShadowUniforms.cloudShadowOn.value = THREE.MathUtils.smoothstep(sunDir.y, 0.03, 0.2);

  return {
    group, puffCount: count, centers,
    update(camPos) { if (camPos.distanceToSquared(lastCam) > 15 * 15) sort(camPos); },
    dispose() { scene.remove(group); geo.dispose(); quad.dispose(); mat.dispose(); tex.dispose(); }
  };
}
