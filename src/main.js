// SEKIYADO SOARING — デスクトップ版 本体
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Atmosphere } from './sim/atmosphere.js';
import { AIRCRAFT, RUNWAY_HEADING, createState, launch, stepFlight, runwayCoords, clampTrim } from './sim/flight.js';
import { createTow, stepTow, releaseTow, stepDeparture } from './sim/tow.js';
import { Environment } from './world/sky.js';
import { loadTerrainData, makeHeight, makeDetailTexture, buildLocalTerrain, buildFarTerrain } from './world/terrain.js';
import { buildScenery } from './world/scenery.js';
import { buildClouds } from './world/clouds.js';
import { makeGlider, makeDimona, makeTowPlane } from './aircraft/models.js';
import { makeCockpit } from './ui/cockpit.js';
import { Input } from './input.js';
import { makeAudio } from './audio.js';

const $ = id => document.getElementById(id);

// ---------- 設定 ----------
const DEFAULTS = { aircraft: 'dimona', mode: 'powered', windDir: '0', windSpeed: '3', thermals: '1', turbulence: '0.5', timeOfDay: '12', visibility: '60000', quality: '2', assist: '1', guide: '1', units: 'metric' };
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('sekiyado.settings') || '{}')); } catch { /* 既定値 */ }
for (const k of Object.keys(DEFAULTS)) { const el = $(k); if (el) el.value = settings[k]; }
function readSettings() { for (const k of Object.keys(DEFAULTS)) { const el = $(k); if (el) settings[k] = el.value; } try { localStorage.setItem('sekiyado.settings', JSON.stringify(settings)); } catch { /* 保存できなくても続行 */ } }
const quality = Number(settings.quality);

// ---------- レンダラー ----------
const canvas = $('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: quality < 2, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
} catch (e) { $('loadText').textContent = '3D描画（WebGL2）を開始できません。グラフィックドライバーを更新してください。'; throw e; }
renderer.setPixelRatio(Math.min(devicePixelRatio, [1, 1, 1.5, 2][quality]));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = quality > 0;
renderer.shadowMap.type = quality >= 3 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.15, 400000);
const env = new Environment(renderer, scene);
env.sun.shadow.mapSize.set(quality >= 2 ? 4096 : 2048, quality >= 2 ? 4096 : 2048);
env.sun.shadow.bias = -0.0002; env.sun.shadow.normalBias = 0.04;

let composer = null;
if (quality >= 2) {
  const rt = new THREE.WebGLRenderTarget(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio(), { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.12, 0.45, 0.95));
  composer.addPass(new OutputPass());
}

// ---------- 状態 ----------
let data, height = () => 10, textures, scenery, clouds, atmo, models = {}, cockpits = {}, ready = false;
let s = null, plane = null, tow = null, towModel = null, ropeLine = null, thermalVisual = null;
let active = false, paused = false, camMode = 0, hudOn = true, path = [], last = 0, uiTime = 0, trailTime = 0, releaseMsg = 0, resultShown = false;
const CAM_NAMES = ['追尾', 'コックピット', '外部', '地上'];
const input = new Input(), sound = makeAudio();

function progress(f, text) { $('loadBar').style.width = Math.round(f * 100) + '%'; if (text) $('loadText').textContent = text + ' を準備しています…'; }
const tick = () => new Promise(r => setTimeout(r, 0));

async function loadTexture(url) {
  const t = await new THREE.TextureLoader().loadAsync(url);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

async function init() {
  try {
    data = await loadTerrainData(progress);
    if (data.hires?.detail) Object.assign(data.detail, data.hires.detail);
    height = makeHeight(data);
    progress(0.25, '航空写真');
    textures = { wide: await loadTexture('data/' + (data.hires?.wide?.file || 'terrain_wide.jpg')) };
    if (data.hires?.chunks?.length) {
      textures.detailChunks = [];
      for (const [i, ch] of data.hires.chunks.entries()) {
        progress(0.25 + 0.3 * i / data.hires.chunks.length, `高解像度写真 ${i + 1}/${data.hires.chunks.length}`);
        textures.detailChunks.push({ ...ch, texture: await loadTexture('data/' + ch.file) });
      }
    } else {
      const d = data.detail;
      textures.detailChunks = [{ xmin: d.xmin, zmin: d.zmin, width: d.width, depth: d.depth, texture: await loadTexture('data/terrain_detail.jpg') }];
    }
    progress(0.6, '地形メッシュ'); await tick();
    const detailTex = makeDetailTexture(renderer);
    buildLocalTerrain(scene, data, textures, height, detailTex);
    buildFarTerrain(scene, data, renderer, quality);
    progress(0.72, '樹木と建物（航空写真から検出）'); await tick();
    scenery = buildScenery(scene, data, textures, height, quality);
    progress(0.86, '機体'); await tick();
    models.glider = makeGlider(); models.dimona = makeDimona(); towModel = makeTowPlane();
    for (const k of ['glider', 'dimona']) { scene.add(models[k].group); models[k].group.visible = false; cockpits[k] = makeCockpit(models[k], k); }
    scene.add(towModel.group); towModel.group.visible = false;
    ropeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 20 }, () => new THREE.Vector3())), new THREE.LineBasicMaterial({ color: 0xffe9b0 }));
    ropeLine.frustumCulled = false; ropeLine.visible = false; scene.add(ropeLine);
    progress(0.95, '空と雲');
    applyWeather();
    ready = true;
    $('fly').disabled = false; $('fly').textContent = 'フライトを始める　↗';
    $('loading').hidden = true;
    const px = data.hires?.pixelMeters ?? data.detail.pixelMeters;
    $('dataInfo').textContent = `航空写真 約${px.toFixed(2)} m/画素 · 樹木 ${scenery.treeCount.toLocaleString()} 本`;
    $('terrainInfo').textContent = `滑走路周辺 約${(data.detail.width / 1000).toFixed(1)}×${(data.detail.depth / 1000).toFixed(1)} km は約${px.toFixed(2)} m/画素の航空写真と DEM5 標高、約 ${(data.meta.size / 1000).toFixed(1)} km 四方は広域写真、さらに約 300 km 四方の遠景標高（地球の丸みを反映）を表示しています。樹木は航空写真の色から自動推定した近似配置です。`;
    resetFlight(false);
  } catch (e) { console.error(e); $('loadText').textContent = '地形データを読み込めませんでした：' + e.message; }
}

// 天候（風・上昇気流・時刻・視程）を反映
function applyWeather() {
  readSettings();
  atmo = new Atmosphere({ windSpeed: Number(settings.windSpeed), windFrom: Number(settings.windDir), thermalScale: Number(settings.thermals), turbulence: Number(settings.turbulence) });
  env.set({ hour: Number(settings.timeOfDay), visibility: Number(settings.visibility) });
  if (clouds) scene.remove(clouds.group);
  clouds = buildClouds(scene, atmo, height, env.sunDir, quality, true);
  if (thermalVisual) scene.remove(thermalVisual.group);
  thermalVisual = makeThermalVisual();
}

function makeThermalVisual() {
  const group = new THREE.Group(); scene.add(group);
  const rings = [];
  for (const t of atmo.thermals) {
    for (let i = 0; i < 6; i++) {
      const alt = 120 + i * 180;
      const [cx, cz] = atmo.thermalCenter(t, alt);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(t.r * 0.6, 1.4, 4, 72), new THREE.MeshBasicMaterial({ color: 0xf2db89, transparent: true, opacity: 0.22, depthWrite: false }));
      ring.rotation.x = Math.PI / 2; ring.position.set(cx, height(cx, cz) + alt, cz); group.add(ring); rings.push(ring);
    }
  }
  const pts = [], base = [];
  for (const t of atmo.thermals) for (let i = 0; i < 60; i++) { const a = i * 2.399, r = t.r * Math.sqrt((i + 0.5) / 60) * 0.7; base.push({ t, ox: Math.cos(a) * r, oz: Math.sin(a) * r, alt: (i / 60) * 1100 }); pts.push(0, 0, 0); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xf3df95, size: 4, sizeAttenuation: true, transparent: true, opacity: 0.6, depthWrite: false }));
  points.frustumCulled = false; group.add(points);
  return {
    group, update(visible, dt) {
      group.visible = visible; if (!visible) return;
      const a = geo.attributes.position;
      base.forEach((b, i) => {
        b.alt += dt * 30; if (b.alt > 1150) b.alt = 20;
        const [cx, cz] = atmo.thermalCenter(b.t, b.alt);
        a.setXYZ(i, cx + b.ox, height(cx, cz) + b.alt, cz + b.oz);
      });
      a.needsUpdate = true;
    }
  };
}

// ---------- フライト開始 ----------
function resetFlight(fly = true) {
  readSettings();
  const type = settings.aircraft, mode = settings.mode;
  for (const k of ['glider', 'dimona']) models[k].group.visible = k === type;
  plane = models[type];
  const hs = Math.sin(RUNWAY_HEADING), hc = Math.cos(RUNWAY_HEADING);
  let opts;
  if (mode === 'powered' || mode === 'tow') opts = { x: -hs * 640, z: hc * 640, heading: RUNWAY_HEADING, onGround: true };
  else if (mode === 'approach') opts = { x: -hs * 1900, z: hc * 1900, heading: RUNWAY_HEADING };
  else opts = { x: 600, z: 1700, heading: -0.31 };
  const g = height(opts.x, opts.z);
  opts.y = g + AIRCRAFT[type].gearH + (opts.onGround ? 0 : mode === 'approach' ? 110 : 600);
  s = createState(type, opts);
  if (!opts.onGround) { launch(s, mode === 'approach' ? 25 : s.trim); if (type === 'dimona') s.engine.on = false; }
  tow = null;
  if (mode === 'tow') { tow = createTow(height); s.x = tow.x + hs * 55; s.z = tow.z - hc * 55; }
  path = []; resultShown = false; releaseMsg = 0;
  active = fly; paused = false;
  input.clear(); input.look.yaw = input.look.pitch = 0; input.look.zoom = 1;
  document.body.classList.toggle('menu', !fly); document.body.classList.toggle('flying', fly);
  $('start').hidden = fly; $('flightUI').hidden = !fly; $('result').hidden = true; $('pauseMenu').hidden = true;
  $('pauseBtn').hidden = !fly; $('menuTopBtn').hidden = !fly;
  $('motorHud').hidden = type !== 'dimona'; $('towHud').hidden = !tow; $('thermalHud').hidden = !!tow;
  updateUnits();
  camera.position.set(s.x + 30, s.y + 10, s.z + 50);
}

function updateUnits() { const av = settings.units === 'aviation'; $('speedUnit').textContent = av ? 'kt' : 'km/h'; $('altUnit').textContent = av ? 'ft' : 'm'; }

function aircraftChanged() {
  const isMotor = $('aircraft').value === 'dimona';
  for (const o of $('mode').options) { o.disabled = (o.value === 'tow' && isMotor) || (o.value === 'powered' && !isMotor); o.hidden = o.disabled; }
  if ($('mode').selectedOptions[0]?.disabled) $('mode').value = isMotor ? 'powered' : 'tow';
  $('aircraftNote').textContent = isMotor
    ? '白×赤ストライプ、機首プロペラ、並列2座のモーターグライダー。エンジンで自力離陸し、上空で停止して滑空もできます。'
    : '細長い主翼と T 字尾翼の複座練習グライダー（汎用形状）。航空機曳航で離陸し、上昇気流を探して飛びます。';
  if (ready) resetFlight(false);
}

// ---------- 着陸・終了判定 ----------
function finish(title, text) {
  if (resultShown) return; resultShown = true; active = false; sound.hush();
  $('resultTitle').textContent = title; $('resultText').textContent = text; $('result').hidden = false;
}
function evaluate() {
  const td = s.touchdown, t = `飛行時間 ${Math.floor(s.time / 60)}分${Math.floor(s.time % 60)}秒 / 最高高度 ${Math.round(s.maxAgl)} m / 飛行距離 ${(s.distance / 1000).toFixed(1)} km`;
  if (!td) return;
  const vs = -td.vs;
  if (vs > 3.5 || Math.abs(td.bank) > 0.35) return finish('機体損傷', `接地時の沈下率 ${vs.toFixed(1)} m/s、バンク ${Math.round(Math.abs(td.bank) * 57.3)}°。速度を保ち、翼を水平にしてフレアをかけましょう。\n${t}`);
  const where = td.onRunway ? `滑走路内（中心線から ${Math.abs(td.cross).toFixed(0)} m、南端から ${Math.round(td.along + 750)} m）` : '滑走路の外（場外着陸）';
  const grade = !td.onRunway ? '場外着陸' : vs < 1.0 ? 'ナイスランディング。' : vs < 2.0 ? '着陸成功' : 'ハードランディング';
  finish(grade, `接地 ${where} / 接地速度 ${Math.round(td.speed * 3.6)} km/h / 沈下率 ${vs.toFixed(1)} m/s。\n${t}`);
}

// ---------- メインループ ----------
const v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), q1 = new THREE.Quaternion(), e1 = new THREE.Euler(0, 0, 0, 'YXZ'), UP = new THREE.Vector3(0, 1, 0);
let fpsT = 0, fpsN = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000 || 0.016, 0.05); last = now;
  fpsT += dt; fpsN++; if (fpsT > 1) { $('fps').textContent = `${Math.round(fpsN / fpsT)} FPS`; fpsT = 0; fpsN = 0; }
  if (!ready) return;
  const events = input.poll(dt);
  handleEvents(events);

  if (active && !paused) {
    const steps = Math.max(1, Math.round(dt * 120)), h = dt / steps;
    if (s.type === 'dimona') {
      const e = s.engine;
      if (input.throttleAxis !== null) e.throttle = input.throttleAxis;
      e.throttle = Math.max(0, Math.min(1, e.throttle + ((input.keys.KeyW ? 1 : 0) - (input.keys.KeyS ? 1 : 0)) * dt * 0.5));
    }
    for (let i = 0; i < steps; i++) {
      if (tow?.attached) { if (stepTow(tow, s, h, height)) detach(true); }
      else {
        stepFlight(s, { roll: input.roll, pitch: input.pitch, yaw: input.yaw }, h, { atmo, height }, settings.assist === '1');
        if (tow) stepDeparture(tow, h);
      }
    }
    // 着陸後に停止したら評価
    if (s.onGround && s.hasFlown && s.touchdown) {
      if (-s.touchdown.vs > 3.5 || Math.abs(s.touchdown.bank) > 0.35 || Math.hypot(s.vx, s.vz) < 1) evaluate();
    }
    if (Math.hypot(s.x, s.z) > 40000) finish('再現エリアの外へ', '滑空場から 40 km 以上離れました。飛び直して関宿周辺のフライトを楽しんでください。');
    trailTime += dt; if (trailTime > 0.8) { path.push([s.x, s.z]); if (path.length > 1500) path.shift(); trailTime = 0; }
  }

  // 機体の描画
  const visual = plane;
  if (!active && !$('start').hidden) {
    // メニュー画面：駐機中の機体の周りをゆっくり回る
    const t = now * 0.00008, g = height(0, 0);
    visual.group.position.set(0, g + s.a.gearH, 0); visual.group.rotation.set(0.0, -RUNWAY_HEADING, 0);
    camera.position.set(Math.cos(t) * 14, g + 3.2, Math.sin(t) * 14); camera.up.set(0, 1, 0); camera.lookAt(0, g + 1.4, 0);
    camera.fov = 50;
  } else {
    visual.group.position.set(s.x, s.y, s.z);
    visual.group.rotation.set(s.pitch, -s.heading, -s.bank);
    s.wheelSpinDelta = s.onGround && !paused ? Math.hypot(s.vx, s.vz) * dt / 0.25 : 0;
    updateCamera(dt);
  }
  visual.animate(s, paused ? 0 : dt, s.engine.rpm);
  for (const k of ['glider', 'dimona']) cockpits[k].setVisible(camMode === 1 && active !== null && k === s.type && $('start').hidden);
  // 曳航機と索
  towModel.group.visible = !!tow && $('start').hidden && (tow.attached || tow.departTime < 25);
  if (towModel.group.visible) {
    towModel.group.position.set(tow.x, tow.y + (tow.airborne ? 0 : 0.0), tow.z); towModel.group.rotation.set(tow.pitch, -tow.heading, -tow.bank);
    towModel.animate({ aileron: 0, elevator: 0, rudder: 0, brake: 0 }, dt, 2400 + (tow.attached ? 2600 : 900));
    ropeLine.visible = tow.attached;
    if (tow.attached) {
      const a = v3.set(0, -0.2, 3.6).applyQuaternion(towModel.group.quaternion).add(towModel.group.position);
      const b = v4.set(0, -0.5, -3.9).applyQuaternion(visual.group.quaternion).add(visual.group.position);
      const p = ropeLine.geometry.attributes.position;
      for (let i = 0; i < 20; i++) { const f = i / 19; p.setXYZ(i, a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f - Math.sin(f * Math.PI) * (tow.airborne ? 1.2 : 0.3), a.z + (b.z - a.z) * f); }
      p.needsUpdate = true;
    }
  } else ropeLine.visible = false;

  const camAgl = camera.position.y - height(camera.position.x, camera.position.z);
  env.follow(visual.group.position, visual.group.position.y - height(visual.group.position.x, visual.group.position.z), quality);
  scenery.update(camera.position, now / 1000, Math.atan2(atmo.wdx, -atmo.wdz), atmo.windSpeed);
  clouds.update(camera.position);
  thermalVisual.update(settings.guide === '1' && active !== false && $('start').hidden && !tow?.attached, paused ? 0 : dt);
  // 地上付近では霞を少し強く（遠景の地平線を自然に）
  sound.update({ running: active && !paused, airspeed: s.airspeed, rpm: s.engine.rpm, rolling: s.onGround && Math.hypot(s.vx, s.vz) > 1, te: s.te, cockpit: camMode === 1, varioOn: !s.onGround && !tow?.attached });

  uiTime += dt; if (uiTime > 0.1 && $('start').hidden) { updateHud(); uiTime = 0; }
  camera.near = camAgl > 300 ? 1 : 0.15; camera.updateProjectionMatrix();
  if (composer) composer.render(); else renderer.render(scene, camera);
}

function updateCamera(dt) {
  const L = input.look, g = visual => visual.group;
  const P = plane.group;
  camera.fov = 60 / L.zoom;
  if (camMode === 1) {
    // コックピット
    camera.fov = 72 / L.zoom;
    v3.copy(plane.parts.eye).applyQuaternion(P.quaternion).add(P.position);
    camera.position.copy(v3);
    e1.set(L.pitch - 0.14, L.yaw, 0); q1.setFromEuler(e1);
    camera.quaternion.copy(P.quaternion).multiply(q1);
  } else if (camMode === 2) {
    // 外部：マウスで機体の周りを回る
    const r = 18 * L.zoom, yaw = -s.heading + L.yaw + Math.PI, pitch = 0.25 + L.pitch;
    camera.position.set(P.position.x + Math.sin(yaw) * Math.cos(pitch) * r, P.position.y + Math.sin(pitch) * r, P.position.z + Math.cos(yaw) * Math.cos(pitch) * r);
    const gy = height(camera.position.x, camera.position.z) + 1; if (camera.position.y < gy) camera.position.y = gy;
    camera.fov = 55; camera.up.copy(UP); camera.lookAt(P.position);
  } else if (camMode === 3) {
    // 地上の観客視点（格納庫前）
    camera.position.set(330, height(330, -300) + 1.7, -300);
    camera.up.copy(UP); camera.lookAt(P.position);
    const d = camera.position.distanceTo(P.position);
    camera.fov = THREE.MathUtils.clamp(2 * Math.atan(30 / d) * 57.3, 4, 60) / L.zoom;
  } else {
    // 追尾
    const dist = 22 * L.zoom, yaw = s.heading + L.yaw;
    v3.set(P.position.x - Math.sin(yaw) * dist * Math.cos(L.pitch + 0.12), P.position.y + 5 + Math.sin(L.pitch + 0.12) * dist, P.position.z + Math.cos(yaw) * dist * Math.cos(L.pitch + 0.12));
    const gy = height(v3.x, v3.z) + 1.2; if (v3.y < gy) v3.y = gy;
    camera.position.lerp(v3, 1 - Math.exp(-dt * 4));
    camera.up.copy(UP);
    camera.lookAt(P.position.x + Math.sin(s.heading) * 12, P.position.y + 1, P.position.z - Math.cos(s.heading) * 12);
  }
}

function handleEvents(ev) {
  if (ev.has('Escape')) { if (active) setPause(!paused); else if (!$('result').hidden) resetFlight(false); }
  if (!active) return;
  if (ev.has('KeyP') || ev.has('Space')) setPause(!paused);
  if (paused) return;
  if (ev.has('KeyC')) { camMode = (camMode + 1) % 4; input.look.yaw = input.look.pitch = 0; input.look.zoom = 1; flash('視点：' + CAM_NAMES[camMode]); }
  if (ev.has('KeyH')) { hudOn = !hudOn; document.body.classList.toggle('hudoff', !hudOn); }
  if (ev.has('KeyB') && !tow?.attached) { s.brake = s.brake ? 0 : 1; flash('エアブレーキ ' + (s.brake ? 'ON' : 'OFF')); }
  if (ev.has('KeyR')) detach(false);
  if (ev.has('KeyE') && s.type === 'dimona') { s.engine.on = !s.engine.on; sound.unlock(); flash('エンジン ' + (s.engine.on ? '始動' : '停止')); }
  if (ev.has('BracketLeft') || ev.has('BracketRight')) { clampTrim(s, s.trim + (ev.has('BracketRight') ? 1.39 : -1.39)); flash(`トリム ${Math.round(s.trim * 3.6)} km/h`); }
  if (ev.has('KeyM')) { const on = sound.toggle(); flash('音 ' + (on ? 'ON' : 'OFF')); }
}

let flashText = '', flashUntil = 0;
function flash(t) { flashText = t; flashUntil = performance.now() + 1800; }

function detach(auto) {
  if (!tow?.attached || !active) return;
  if (!releaseTow(tow, s, height)) { if (!auto) flash('高度 30 m 以上で切り離せます'); return; }
  s.trim = AIRCRAFT[s.type].trim; s.alpha = 0.05; releaseMsg = s.time + 6;
  $('towHud').hidden = true; $('thermalHud').hidden = false;
}

function setPause(v) { paused = v; if (v) sound.hush(); $('pauseMenu').hidden = !v; $('pauseBtn').textContent = v ? '再開 [P]' : '一時停止 [P]'; }

// ---------- HUD ----------
const mapctx = $('map').getContext('2d'), actx = $('attitude').getContext('2d');
function updateHud() {
  const av = settings.units === 'aviation';
  const agl = Math.max(0, s.y - height(s.x, s.z) - s.a.gearH);
  $('speed').textContent = Math.round(av ? s.airspeed * 1.944 : s.airspeed * 3.6);
  $('alt').textContent = Math.round(av ? agl * 3.281 : agl);
  $('vario').textContent = (s.te >= 0 ? '+' : '') + s.te.toFixed(1);
  $('vario').style.color = s.te > 0.2 ? '#dbed97' : s.te < -2 ? '#f0b39a' : '';
  const hdg = ((s.heading * 180 / Math.PI) % 360 + 360) % 360;
  $('hdg').textContent = String(Math.round(hdg) % 360).padStart(3, '0') + '°';
  $('trimInfo').textContent = 'TRIM ' + Math.round(av ? s.trim * 1.944 : s.trim * 3.6);
  // 上昇気流表示
  const inside = s.lift > 0.6, rising = inside && s.te > 0.2;
  $('thermalHud').classList.toggle('inside', inside); $('thermalHud').classList.toggle('rising', rising);
  $('thermalLabel').textContent = settings.thermals === '0' ? '上昇気流：なし' : s.type === 'dimona' && s.engine.on && inside ? '上昇気流内 · エンジン併用' : !inside ? '上昇気流を探そう' : rising ? '上昇気流に乗っています' : '上昇気流内 · 旋回を締めて中心へ';
  $('airLift').textContent = (s.lift >= 0 ? '+' : '') + s.lift.toFixed(1);
  $('netLift').textContent = (s.te >= 0 ? '+' : '') + s.te.toFixed(1);
  $('thermalFill').style.width = Math.max(0, Math.min(100, s.lift / 4 * 100)) + '%';
  if (s.type === 'dimona') {
    const e = s.engine; $('engineState').textContent = e.on ? 'RUN' : 'OFF'; $('rpm').textContent = Math.round(e.rpm) + ' rpm';
    $('throttleValue').textContent = Math.round(e.throttle * 100) + '%'; $('throttleFill').style.width = e.throttle * 100 + '%';
    $('motorHud').classList.toggle('on', e.on);
  }
  if (tow?.attached) {
    $('towStage').textContent = !tow.airborne ? '滑走・加速中' : agl < 30 ? '離陸 — 初期上昇' : '曳航上昇 · ' + Math.round(agl) + ' m';
    $('towHelp').textContent = agl < 30 ? '自動追従中 · 高度 30 m から索を切り離せます' : 'R キー／ボタンで切り離し · 600 m で自動切り離し';
    $('towProgress').value = agl;
  }
  // 注意表示
  let note = '';
  if (performance.now() < flashUntil) note = flashText;
  else if (tow?.attached) note = '曳航機に自動追従中 · R で索を切り離し';
  else if (s.time < releaseMsg) note = '索を切り離しました — 右へ旋回して曳航機から離れましょう';
  else if (s.type === 'dimona' && s.onGround && !s.hasFlown) note = !s.engine.on ? 'E キーでエンジン始動 → W でスロットル 100%' : s.airspeed < 20 ? '加速中 — 75 km/h を超えたら ↓ で機首上げ' : '↓ を押して機首を上げ、離陸';
  else if (s.stall > 0.1) note = '失速 — ↑ で機首を下げて速度を回復';
  else if (s.airspeed > s.a.vne * 0.9) note = '超過禁止速度に接近 — 機首を上げて減速';
  else if (s.brake && !s.onGround) note = 'エアブレーキ展開中';
  $('notice').textContent = note;
  $('statusLine').textContent = `視点：${CAM_NAMES[camMode]} [C] · 風 ${settings.windSpeed} m/s · ${input.padName ? '🎮 ' + input.padName.slice(0, 32) : 'キーボード'}`;
  drawMap(); drawAttitude();
  if (camMode === 1) cockpits[s.type].update(s, agl, agl, settings.units);
}

function drawMap() {
  const c = mapctx, meta = data.meta, S = 260;
  const mp = (x, z) => [(x - meta.xmin) / meta.size * S, (z - meta.zmin) / meta.size * S];
  c.clearRect(0, 0, S, S); c.drawImage(textures.wide.image, 0, 0, S, S); c.fillStyle = '#102a3040'; c.fillRect(0, 0, S, S);
  if (settings.guide === '1') for (const t of atmo.thermals) {
    const [x, y] = mp(t.x, t.z); c.strokeStyle = '#e6d88c'; c.fillStyle = '#f3df6f33'; c.beginPath(); c.arc(x, y, t.r / meta.size * S, 0, 6.29); c.fill(); c.stroke();
  }
  c.strokeStyle = '#e9f4cb'; c.lineWidth = 1.5; c.beginPath(); path.forEach((p, i) => { const q = mp(p[0], p[1]); i ? c.lineTo(...q) : c.moveTo(...q); }); c.stroke();
  const [rx, ry] = mp(0, 0); c.save(); c.translate(rx, ry); c.rotate(RUNWAY_HEADING); c.strokeStyle = '#eaffc0'; c.lineWidth = 2; c.strokeRect(-2.5, -750 / meta.size * S, 5, 1500 / meta.size * S); c.restore();
  let [px, py] = mp(s.x, s.z); const out = px < 0 || px > S || py < 0 || py > S; px = Math.max(6, Math.min(S - 6, px)); py = Math.max(6, Math.min(S - 6, py));
  c.save(); c.translate(px, py); c.rotate(s.heading); c.fillStyle = out ? '#f3b07a' : '#fff'; c.strokeStyle = '#143d44'; c.beginPath(); c.moveTo(0, -9); c.lineTo(6, 7); c.lineTo(0, 3); c.lineTo(-6, 7); c.closePath(); c.fill(); c.stroke(); c.restore();
  // 風向（矢印は風が吹いていく方向）
  if (atmo.windSpeed > 0) { c.save(); c.translate(S - 22, 22); c.rotate(Math.atan2(atmo.wdx, -atmo.wdz)); c.strokeStyle = '#cfe8ff'; c.lineWidth = 2; c.beginPath(); c.moveTo(0, 10); c.lineTo(0, -10); c.lineTo(-5, -4); c.moveTo(0, -10); c.lineTo(5, -4); c.stroke(); c.restore(); }
  const d = Math.hypot(s.x, s.z), { along } = runwayCoords(s.x, s.z);
  $('distance').textContent = `滑走路中心まで ${(d / 1000).toFixed(2)} km` + (out ? '（地図の外）' : '') + (Math.abs(along) < 760 && d < 800 ? '' : '');
}

function drawAttitude() {
  const c = actx; c.clearRect(0, 0, 120, 120); c.save(); c.beginPath(); c.arc(60, 60, 54, 0, 6.29); c.clip(); c.translate(60, 60); c.rotate(-s.bank);
  const py = s.pitch * 170; c.fillStyle = '#6fa4c4'; c.fillRect(-120, -240 + py, 240, 240); c.fillStyle = '#6c6450'; c.fillRect(-120, py, 240, 240);
  c.strokeStyle = '#ebefd0'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(-120, py); c.lineTo(120, py); c.stroke();
  for (let i = -3; i <= 3; i++) if (i) { c.beginPath(); c.moveTo(-(i % 2 ? 8 : 15), py + i * 15); c.lineTo(i % 2 ? 8 : 15, py + i * 15); c.stroke(); }
  c.restore(); c.strokeStyle = '#f5d76e'; c.lineWidth = 3; c.beginPath(); c.moveTo(24, 60); c.lineTo(48, 60); c.lineTo(60, 67); c.lineTo(72, 60); c.lineTo(96, 60); c.stroke();
  // バンク目盛
  c.save(); c.translate(60, 60); c.strokeStyle = '#ffffffaa'; c.lineWidth = 1.5;
  for (const a of [-60, -45, -30, -15, 0, 15, 30, 45, 60]) { c.save(); c.rotate(a * Math.PI / 180); c.beginPath(); c.moveTo(0, -54); c.lineTo(0, a % 30 ? -49 : -45); c.stroke(); c.restore(); }
  c.rotate(-s.bank); c.fillStyle = '#f5d76e'; c.beginPath(); c.moveTo(0, -44); c.lineTo(-5, -36); c.lineTo(5, -36); c.closePath(); c.fill(); c.restore();
}

// ---------- UI イベント ----------
$('fly').onclick = () => { sound.unlock(); if (!ready) return; readSettings(); if (Number(settings.quality) !== quality) { location.reload(); return; } applyWeather(); resetFlight(true); canvas.focus(); };
$('again').onclick = () => { resetFlight(true); };
$('menuBtn').onclick = () => resetFlight(false);
$('resumeBtn').onclick = () => setPause(false);
$('restartBtn').onclick = () => resetFlight(true);
$('toMenuBtn').onclick = () => resetFlight(false);
$('pauseBtn').onclick = () => { if (active) setPause(!paused); };
$('menuTopBtn').onclick = () => resetFlight(false);
$('infoBtn').onclick = () => { if (active) setPause(true); $('info').showModal(); };
$('closeInfo').onclick = () => $('info').close();
$('aircraft').onchange = aircraftChanged;
$('mode').onchange = () => ready && resetFlight(false);
$('windSpeed').oninput = () => { $('windSpeedOut').textContent = $('windSpeed').value + ' m/s'; };
$('timeOfDay').oninput = () => { const h = Number($('timeOfDay').value); $('timeOut').textContent = `${Math.floor(h)}:${String(Math.round(h % 1 * 60)).padStart(2, '0')}`; };
for (const id of ['timeOfDay', 'visibility', 'windDir', 'windSpeed', 'thermals']) $(id).addEventListener('change', () => ready && applyWeather());
$('windSpeed').oninput(); $('timeOfDay').oninput();
$('quality').onchange = () => { readSettings(); $('fly').textContent = Number(settings.quality) !== quality ? '画質を適用して再読み込み　↻' : 'フライトを始める　↗'; };
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && active) setPause(true); });
// 診断用（開発者ツールから参照）
window.__sim = () => s && { t: s.time, x: s.x, y: s.y, z: s.z, agl: s.y - height(s.x, s.z) - s.a.gearH, v: s.airspeed, te: s.te, onGround: s.onGround, active, paused };
aircraftChanged();
init();
requestAnimationFrame(frame);
