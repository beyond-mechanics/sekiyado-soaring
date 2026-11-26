// 後処理：画面空間の環境遮蔽（SSAO。画質「高」「最高」）と、レイマーチングの立体雲（「最高」だけ）。
// 本体は対数深度バッファ（logarithmicDepthBuffer）で描くので、深度 d から視点距離 w を戻して使う：
//   d = log2(1 + w) / log2(far + 1)  →  w = 2^(d·log2(far + 1)) − 1
// 「軽量」「標準」では EffectComposer を使わないので、このパスは作られず負荷も増えない。
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const WEATHER_HALF = 60000; // 雲の分布図の範囲（原点から ±60 km。雲の影マップと同じ）

const COMMON = /* glsl */`
uniform sampler2D tDepth;
uniform mat4 invProj;
uniform float logFar;
varying vec2 vUv;
float viewW(float d) { return exp2(d * logFar) - 1.0; }
// 画面座標 → 視点空間の向き（z = −1 にそろえる。位置 = 向き × w）
vec3 viewRay(vec2 uv) {
  vec4 r = invProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  r.xyz /= r.w;
  return r.xyz / -r.z;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ---- SSAO（Scalable Ambient Obscurance 風。半分の解像度で計算） ----
const AO_FRAG = /* glsl */`
${COMMON}
uniform vec2 depthTexel;
uniform float projScale; // 視点距離 1 m で 1 m が何ピクセルか（深度テクスチャの解像度で）
uniform int samples;
vec3 posAt(vec2 uv) { return viewRay(uv) * viewW(texture2D(tDepth, uv).r); }
void main() {
  float d = texture2D(tDepth, vUv).r;
  if (d > 0.9999) { gl_FragColor = vec4(1.0, d, 0.0, 1.0); return; }
  vec3 P = viewRay(vUv) * viewW(d);
  float w = -P.z;
  // 法線：上下左右の近い方の差分から（物の縁で法線が崩れないように）
  vec3 pl = posAt(vUv - vec2(depthTexel.x, 0.0)), pr = posAt(vUv + vec2(depthTexel.x, 0.0));
  vec3 pd = posAt(vUv - vec2(0.0, depthTexel.y)), pu = posAt(vUv + vec2(0.0, depthTexel.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  // 半径：近くは 1.2 m（車輪・建物の根元）、遠くほど大きく（林や家並みの陰）
  float R = clamp(w * 0.012, 1.2, 14.0);
  float rPix = R * projScale / w;
  if (rPix < 1.5 || w > 3000.0) { gl_FragColor = vec4(1.0, d, 0.0, 1.0); return; }
  rPix = min(rPix, 90.0);
  float ang = ign(gl_FragCoord.xy) * 6.2832, sum = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= samples) break;
    float a = (float(i) + 0.5) / float(samples);
    float th = a * 6.2832 * 3.0 + ang; // らせん状に配置
    vec2 suv = vUv + vec2(cos(th), sin(th)) * (a * rPix) * depthTexel;
    vec3 v = posAt(suv) - P;
    float vv = dot(v, v), vn = dot(v, N);
    float f = max(R * R - vv, 0.0) / (R * R);
    sum += f * max((vn - 0.003 * w) / (sqrt(vv) + 0.01 * R), 0.0);
  }
  float ao = clamp(1.0 - 1.6 * sum / float(samples), 0.0, 1.0);
  ao = mix(ao, 1.0, smoothstep(1800.0, 3000.0, w));
  gl_FragColor = vec4(ao, d, 0.0, 1.0);
}
`;

// ---- 立体雲（レイマーチング。半分の解像度で計算し、合成時に拡大） ----
const CLOUD_FRAG = /* glsl */`
${COMMON}
uniform mat4 camWorld;
uniform vec3 camPos;
uniform sampler2D weather;   // R：雲量、G：雲の厚さ /3000 m、B：雲底の高さ /4000 m
uniform vec3 weatherRect;    // xmin, zmin, 1/幅
uniform sampler3D noise3;
uniform vec2 slab;           // 雲の層の下端・上端 [m]
uniform vec3 sunDir, sunCol, ambTop, ambBot, fogCol;
uniform float fogDensity, time;
uniform vec2 wind;
uniform int steps;
vec4 wx(vec2 xz) { return texture2D(weather, (xz - weatherRect.xy) * weatherRect.z); }
float density(vec3 p, vec4 w, bool detail) {
  float top = w.g * 3000.0 + 1.0, base = w.b * 4000.0;
  float hf = (p.y - base) / top;
  if (hf < 0.0 || hf > 1.0 || w.r < 0.02) return 0.0;
  vec3 q = p + vec3(wind.x, 0.0, wind.y) * time;
  float n = texture(noise3, q / 1700.0).r * 0.65 + texture(noise3, q / 900.0 + 0.37).r * 0.35;
  // 積雲：底は平ら、上ほど細く、もくもくした輪郭（ノイズで削る）
  float shape = w.r * smoothstep(0.0, 0.05, hf) - hf * 0.5 - smoothstep(0.8, 1.0, hf) * 0.5;
  float dens = shape - (1.0 - n) * 0.62;
  if (detail && dens > -0.1) dens -= (1.0 - texture(noise3, q / 300.0).r) * 0.14 * (1.0 - hf * 0.4);
  return clamp(dens * 4.0, 0.0, 1.0);
}
vec3 aerial(vec3 c, float t) { float f = 1.0 - exp(-fogDensity * fogDensity * t * t); return mix(c, fogCol, f); }
void main() {
  vec3 vr = viewRay(vUv);
  vec3 dir = normalize((camWorld * vec4(vr, 0.0)).xyz);
  float d = texture2D(tDepth, vUv).r;
  float tScene = d > 0.9999 ? 1e9 : viewW(d) * length(vr);
  // 雲の層（slab.x〜slab.y）との交差
  float t0, t1;
  if (abs(dir.y) < 1e-4) { if (camPos.y < slab.x || camPos.y > slab.y) { gl_FragColor = vec4(0, 0, 0, 1); return; } t0 = 0.0; t1 = 1e9; }
  else {
    float a = (slab.x - camPos.y) / dir.y, b = (slab.y - camPos.y) / dir.y;
    t0 = max(0.0, min(a, b)); t1 = max(a, b);
  }
  t1 = min(min(t1, tScene), 70000.0);
  if (t1 <= t0) { gl_FragColor = vec4(0, 0, 0, 1); return; }
  // 近くは細かく、遠くは粗く（遠くは霞で見えにくい）
  float jit = ign(gl_FragCoord.xy);
  float t = t0 + clamp(t0 * 0.015, 20.0, 260.0) * jit;
  float cosT = dot(dir, sunDir);
  float phase = 0.75 + 0.9 * pow(max(cosT, 0.0), 6.0) + 0.25 * cosT;
  float sunUp = clamp(sunDir.y * 1.8, 0.08, 1.0);
  vec3 col = vec3(0.0); float T = 1.0;
  for (int i = 0; i < 160; i++) {
    if (i >= steps || t > t1 || T < 0.02) break;
    float dt = clamp(t * 0.015, 20.0, 260.0);
    vec3 p = camPos + dir * t;
    vec4 w = wx(p.xz);
    if (w.r > 0.02) {
      float rho = density(p, w, true);
      if (rho > 0.001) {
        // 太陽の方向に 4 回だけ調べて、雲の中の影を近似
        float od = 0.0, ls = 45.0;
        for (int k = 0; k < 4; k++) { vec3 lp = p + sunDir * ls; od += density(lp, wx(lp.xz), false) * ls; ls *= 2.1; }
        float hf = clamp((p.y - w.b * 4000.0) / (w.g * 3000.0 + 1.0), 0.0, 1.0);
        float sig = rho * 0.02;
        float lightT = exp(-od * 0.02 * 0.35);
        float powder = 1.0 - exp(-rho * 6.0);
        vec3 S = sunCol * 0.85 * phase * lightT * mix(0.6, 1.0, powder) + mix(ambBot, ambTop, 0.3 + 0.7 * hf);
        S = aerial(S, t);
        float a = 1.0 - exp(-sig * dt);
        col += T * S * a;
        T *= 1.0 - a;
      }
    } else {
      t += dt; // 雲の無い所は大股で
    }
    t += dt;
  }
  // 遠くの雲は霞に溶かす（透過率も霞の分だけ戻す）
  gl_FragColor = vec4(col, T);
}
`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D tColor, tDepth, tAO, tCloud;
uniform vec2 aoTexel;
uniform float aoOn, cloudOn, aoStrength;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tColor, vUv);
  if (aoOn > 0.5) {
    // 3×3 の深度を考慮したぼかしで、半分の解像度の AO をきれいに拡大
    float dc = texture2D(tDepth, vUv).r, s = 0.0, wsum = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 a = texture2D(tAO, vUv + vec2(i, j) * aoTexel).rg;
      float wgt = max(0.0, 1.0 - abs(a.g - dc) * 600.0) * (i == 0 && j == 0 ? 2.0 : 1.0);
      s += a.r * wgt; wsum += wgt;
    }
    float ao = wsum > 0.0 ? s / wsum : 1.0;
    c.rgb *= mix(1.0, ao, aoStrength);
  }
  if (cloudOn > 0.5) {
    vec4 cl = texture2D(tCloud, vUv);
    c.rgb = c.rgb * cl.a + cl.rgb;
  }
  gl_FragColor = c;
}
`;

// 3D ノイズ（Worley の反転＋値ノイズ、64³、繰り返し可能）
function makeNoise3D() {
  const N = 64, data = new Uint8Array(N * N * N);
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const octs = [[4, 0.55], [8, 0.3], [16, 0.15]].map(([c, amp]) => {
    const pts = new Float32Array(c * c * c * 3).map(() => rnd());
    return { c, amp, pts };
  });
  const val = new Float32Array(N * N * N);
  for (const { c, amp, pts } of octs) {
    const cell = N / c;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = (x + 0.5) / cell, fy = (y + 0.5) / cell, fz = (z + 0.5) / cell;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      let best = 9;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const k = ((((cz % c) + c) % c) * c * c + (((cy % c) + c) % c) * c + (((cx % c) + c) % c)) * 3;
        const ddx = cx + pts[k] - fx, ddy = cy + pts[k + 1] - fy, ddz = cz + pts[k + 2] - fz;
        const dd = ddx * ddx + ddy * ddy + ddz * ddz; if (dd < best) best = dd;
      }
      val[(z * N + y) * N + x] += amp * (1 - Math.min(1, Math.sqrt(best)));
    }
  }
  let lo = Infinity, hi = -Infinity; for (const v of val) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < val.length; i++) data[i] = Math.round(255 * (val[i] - lo) / (hi - lo));
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RedFormat; t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

// 雲の中心（clouds.js の centers）から分布図を作る
function makeWeather(centers) {
  const S = 1024, mpp = 2 * WEATHER_HALF / S, d = new Uint8Array(S * S * 4);
  const cov = new Float32Array(S * S), top = new Float32Array(S * S), base = new Float32Array(S * S), wsum = new Float32Array(S * S);
  let lo = Infinity, hi = -Infinity;
  for (const c of centers) {
    const R = c.size * 0.95, cx = (c.x + WEATHER_HALF) / mpp, cz = (c.z + WEATHER_HALF) / mpp, rp = R / mpp + 2;
    const H = c.tall + c.size * 0.45, B = c.base;
    lo = Math.min(lo, B); hi = Math.max(hi, B + H);
    for (let j = Math.max(0, Math.floor(cz - rp)); j <= Math.min(S - 1, Math.ceil(cz + rp)); j++)
      for (let i = Math.max(0, Math.floor(cx - rp)); i <= Math.min(S - 1, Math.ceil(cx + rp)); i++) {
        const q = (((i + 0.5) - cx) ** 2 + ((j + 0.5) - cz) ** 2) * mpp * mpp / (R * R);
        if (q >= 1.6) continue;
        const k = j * S + i, f = Math.exp(-q * 1.6);
        cov[k] = Math.max(cov[k], f * (0.95 + 0.1 * c.thermal));
        top[k] += H * f; base[k] += B * f; wsum[k] += f;
      }
  }
  for (let k = 0; k < S * S; k++) {
    const ws = wsum[k] || 1;
    d[k * 4] = Math.round(255 * Math.min(1, cov[k]));
    d[k * 4 + 1] = Math.round(255 * Math.min(1, (wsum[k] ? top[k] / ws : 600) / 3000));
    d[k * 4 + 2] = Math.round(255 * Math.min(1, (wsum[k] ? base[k] / ws : 1400) / 4000));
    d[k * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, S, S);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  return { tex: t, lo: lo - 30, hi: hi + 60 };
}

export class AtmospherePass extends Pass {
  constructor(camera, quality) {
    super();
    this.camera = camera; this.quality = quality;
    // AO は深度も一緒に入れて合成時の比較に使うので 32 bit、雲は 16 bit
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.cloudRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const base = () => ({ tDepth: { value: null }, invProj: { value: new THREE.Matrix4() }, logFar: { value: 1 } });
    this.ao = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { ...base(), depthTexel: { value: new THREE.Vector2() }, projScale: { value: 1 }, samples: { value: quality >= 3 ? 12 : 8 } },
      vertexShader: VERT, fragmentShader: AO_FRAG, depthTest: false, depthWrite: false
    }));
    this.cloud = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: {
        ...base(), camWorld: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() },
        weather: { value: null }, weatherRect: { value: new THREE.Vector3(-WEATHER_HALF, -WEATHER_HALF, 1 / (2 * WEATHER_HALF)) },
        noise3: { value: null }, slab: { value: new THREE.Vector2(1000, 3000) },
        sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() }, ambTop: { value: new THREE.Color() }, ambBot: { value: new THREE.Color() },
        fogCol: { value: new THREE.Color() }, fogDensity: { value: 0 }, time: { value: 0 }, wind: { value: new THREE.Vector2() }, steps: { value: 140 }
      },
      vertexShader: VERT, fragmentShader: CLOUD_FRAG, depthTest: false, depthWrite: false
    }));
    this.comp = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tDepth: { value: null }, tAO: { value: this.aoRT.texture }, tCloud: { value: this.cloudRT.texture },
        aoTexel: { value: new THREE.Vector2() }, aoOn: { value: 1 }, cloudOn: { value: 0 }, aoStrength: { value: 0.6 } },
      vertexShader: VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false
    }));
    this.cloudsOn = false; this.time = 0;
  }

  // 立体雲を使う（「最高」だけ）。centers：clouds.js の雲の中心、env：太陽と霞
  setClouds(centers, env, atmo) {
    const u = this.cloud.material.uniforms;
    if (!centers || this.quality < 3) { this.cloudsOn = false; return; }
    if (!u.noise3.value) u.noise3.value = makeNoise3D();
    u.weather.value?.dispose();
    const w = makeWeather(centers);
    u.weather.value = w.tex; u.slab.value.set(w.lo, w.hi);
    this.env = env;
    // 雲は風下へゆっくり流れる（模様だけ。位置は上昇気流と結び付いたまま）
    u.wind.value.set(atmo?.wdx ?? 0, atmo?.wdz ?? 0).multiplyScalar((atmo?.windSpeed ?? 0) * 0.6);
    this.cloudsOn = true;
  }

  setSize(w, h) {
    const hw = Math.max(1, Math.round(w / 2)), hh = Math.max(1, Math.round(h / 2));
    this.aoRT.setSize(hw, hh); this.cloudRT.setSize(hw, hh);
    this.comp.material.uniforms.aoTexel.value.set(1 / hw, 1 / hh);
    this.ao.material.uniforms.depthTexel.value.set(1 / hw, 1 / hh);
    this.size = [w, h];
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    const cam = this.camera, depth = readBuffer.depthTexture;
    const logFar = Math.log2(cam.far + 1);
    for (const q of [this.ao, this.cloud]) {
      const u = q.material.uniforms;
      u.tDepth.value = depth; u.invProj.value.copy(cam.projectionMatrixInverse); u.logFar.value = logFar;
    }
    this.ao.material.uniforms.projScale.value = cam.projectionMatrix.elements[5] * 0.5 * (this.size?.[1] ?? 1) / 2;
    renderer.setRenderTarget(this.aoRT); this.ao.render(renderer);
    const cu = this.cloud.material.uniforms;
    if (this.cloudsOn && this.env) {
      this.time += deltaTime || 0.016;
      const e = this.env;
      cu.camWorld.value.copy(cam.matrixWorld); cu.camPos.value.copy(cam.position);
      cu.sunDir.value.copy(e.sunDir); cu.sunCol.value.copy(e.sunRadiance);
      const sunUp = THREE.MathUtils.clamp(e.sunDir.y * 1.8, 0.08, 1);
      cu.ambTop.value.setRGB(0.62, 0.72, 0.9).multiplyScalar(0.4 + 1.1 * sunUp);
      cu.ambBot.value.copy(e.fogColor).multiplyScalar(0.35 + 0.6 * sunUp);
      cu.fogCol.value.copy(e.fogColor); cu.fogDensity.value = e.scene.fog.density;
      cu.time.value = this.time;
      renderer.setRenderTarget(this.cloudRT); this.cloud.render(renderer);
    }
    const m = this.comp.material.uniforms;
    m.tColor.value = readBuffer.texture; m.tDepth.value = depth; m.cloudOn.value = this.cloudsOn ? 1 : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.comp.render(renderer);
  }

  dispose() {
    this.aoRT.dispose(); this.cloudRT.dispose();
    for (const q of [this.ao, this.cloud, this.comp]) { q.material.dispose(); q.dispose(); }
  }
}
