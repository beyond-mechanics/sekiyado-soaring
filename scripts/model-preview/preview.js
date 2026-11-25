// 機体モデルを three.js（シム本体と同じレンダラー設定）で並べて撮る確認用ページ。
// node scripts/model-preview/run.mjs で、手続き生成（従来）と Blender 製（glTF）を同じカメラで撮り比べる。
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { makeGlider, makeDimona } from '../../src/aircraft/models.js';
import { loadGLB, makeAircraftFromGLB } from '../../src/aircraft/gltf-models.js';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') || 1280), H = Number(q.get('h') || 720);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H); renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fbad1);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
scene.add(new THREE.HemisphereLight(0xcfe3f5, 0x56603e, 0.9));
const sun = new THREE.DirectionalLight(0xfff3df, 2.6); sun.position.set(-12, 16, -8); sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096); Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 60 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x6f7f45, roughness: 0.95 }));
const TYPE = q.get('type') || 'glider', GEAR_H = { glider: 0.95, dimona: 1.25 }[TYPE] ?? 0.95;
ground.rotation.x = -Math.PI / 2; ground.position.y = q.get('scene') === 'props' ? 0 : -GEAR_H; ground.receiveShadow = true; scene.add(ground);

const VIEWS = {   // シム座標（右 +x・上 +y・後ろ +z）
  front34: { pos: [-8.5, 1.6, -11], target: [0.8, 0.15, 0.6], fov: 42 },
  side: { pos: [-16, 0.6, -1], target: [0, 0.1, -0.4], fov: 27 },
  nose: { pos: [-3.4, 0.9, -5.6], target: [0, 0.15, -1.9], fov: 32 },
  rear34: { pos: [-9.5, 2.1, 11.5], target: [0.6, 0.05, -0.2], fov: 40 },
  top: { pos: [0.01, 22, 0.5], target: [0, 0, 0.5], fov: 55 },
  // 小物を並べた場面（地面 y=0）
  pist: { pos: [9, 3.2, 13], target: [-2.5, 1.2, 0], fov: 45 },
  sock: { pos: [5, 3.5, 9], target: [0, 4.2, -3.5], fov: 45 }
};

async function props() {
  const add = async (name, x, z, yaw) => { const o = await loadGLB(`models/${name}.glb`); o.position.set(x, 0, z); o.rotation.y = yaw; o.traverse(m => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; } }); scene.add(o); return o; };
  await add('pist_tent', 0, 0, 0);
  for (const [i, x] of [-4.2, -7.7, -11.2].entries()) await add('glider_trailer', x, -3 + i * 0.6, 0);
  const ws = await add('windsock', 3.5, -6, 0);
  ws.getObjectByName('sock_pivot').rotation.y = -0.9;
  return { group: new THREE.Group(), animate() {} };
}

async function main() {
  const kind = q.get('model') || 'glb';
  let h;
  const names = { glider: 'duo_discus_t', dimona: 'super_dimona' };
  if (q.get('scene') === 'props') h = await props();
  else if (kind === 'procedural') h = TYPE === 'dimona' ? makeDimona() : makeGlider();
  else h = makeAircraftFromGLB({ lod0: q.get('lod') === '1' ? null : await loadGLB(`models/${names[TYPE]}.glb`), lod1: await loadGLB(`models/${names[TYPE]}_lod1.glb`) }, q.get('lod') === '1' ? 0 : 2, TYPE);
  scene.add(h.group);
  const s = { aileron: Number(q.get('ail') || 0), elevator: Number(q.get('elev') || 0), rudder: Number(q.get('rud') || 0), brake: q.get('brake') === '1' };
  h.animate(s, 10, Number(q.get('rpm') || 0));
  const v = VIEWS[q.get('view') || 'front34'];
  const cam = new THREE.PerspectiveCamera(v.fov, W / H, 0.05, 1000);
  cam.position.set(...v.pos); cam.lookAt(...v.target);
  renderer.render(scene, cam);
  let tris = 0; h.group.traverse(o => { if (o.isMesh && o.visible) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  window.__done = { tris: Math.round(tris) };
}
main().catch(e => { window.__done = { error: String(e.stack || e) }; });
