// Blender で組み立てた機体（blender/aircraft/*.py → assets/data/models/*.glb）を読み込み、
// 手続き生成の機体（models.js）と同じ { group, parts, animate } の形で返す。
// 読み込みに失敗したときは呼び出し側が models.js の近似形状に戻す。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { pilot, interiorMaterial } from './models.js';

const loader = new GLTFLoader();
const qTmp = new THREE.Quaternion(), X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);

export async function loadGLB(url) {
  const g = await loader.loadAsync(url);
  return g.scene;
}

// 名前（"aileron_L" や LOD1 の "aileron_L_LOD1"）で動く部品を集める
function collectControls(root) {
  const c = { ailerons: [], brakes: [], wheels: [], elevator: [], rudder: [], props: [], fuselage: null, eye: null, panel: null };
  root.traverse(o => {
    const n = o.name.replace(/_LOD1$/, '');
    if (/^aileron_[LR]$/.test(n)) c.ailerons.push(o);
    else if (/^airbrake_[LR]$/.test(n)) c.brakes.push(o);
    else if (/^wheel_(main|nose|tail)(_[LR])?$/.test(n)) c.wheels.push(o);
    else if (n === 'prop') c.props.push(o);
    else if (n === 'elevator') c.elevator.push(o);
    else if (n === 'rudder') c.rudder.push(o);
    else if (n === 'fuselage') c.fuselage = o;
    else if (n === 'eye_front' || n === 'eye_left') c.eye = o;
    else if (n === 'panel') c.panel = o;
    if (o.isMesh) {
      o.castShadow = !o.material.transparent; o.receiveShadow = true;
      // ガラスは内装の後に描く
      if (o.material.transparent) { o.renderOrder = 2; o.material.depthWrite = false; }
    }
  });
  for (const o of [...c.ailerons, ...c.brakes, ...c.elevator, ...c.rudder]) {
    o.userData.q0 = o.quaternion.clone(); o.userData.p0 = o.position.clone();
  }
  return c;
}

// 機体ごとの内装（パイロット・床）と既定の目・計器盤の位置
const CABIN = {
  glider: { pilots: [[0, 0.0, -2.55], [0, 0.08, -1.45]], tub: [0.34, 0.06, 2.1, 0, -0.24, -2.05], eye: [0, 0.5, -2.55], panel: [0, 0.34, -3.02] },
  dimona: { pilots: [[-0.3, 0.12, -0.85], [0.3, 0.12, -0.85]], tub: [0.9, 0.08, 1.6, 0, -0.27, -1.1], eye: [-0.3, 0.66, -0.9], panel: [0, 0.47, -1.5] }
};

/**
 * Blender 製の機体（Duo Discus T / Super Dimona）。lod0/lod1 は loadGLB の結果（lod0 が無ければ lod1 だけで組む）。
 * quality 0（内蔵 GPU のノート）では LOD1 だけを使う。type は 'glider' か 'dimona'。
 */
export function makeAircraftFromGLB({ lod0, lod1 }, quality = 2, type = 'glider') {
  const cab = CABIN[type];
  const group = new THREE.Group(); group.rotation.order = 'YXZ';
  const useLod0 = lod0 && quality > 0;
  let ctl;
  if (useLod0 && lod1) {
    const lod = new THREE.LOD();
    lod.addLevel(lod0, 0); lod.addLevel(lod1, 140); group.add(lod);
    const a = collectControls(lod0), b = collectControls(lod1);
    ctl = { ...a };
    for (const k of ['ailerons', 'brakes', 'wheels', 'elevator', 'rudder', 'props']) ctl[k] = [...a[k], ...b[k]];
  } else {
    const s = useLod0 ? lod0 : lod1; group.add(s); ctl = collectControls(s);
  }
  // 内装：胴体の内壁（裏面）・床・パイロット 2 名
  const im = interiorMaterial();
  ctl.fuselage?.traverse(o => {
    if (!o.isMesh || o.material.transparent) return;
    const g = o.geometry.clone(); g.scale(0.97, 0.97, 0.995);
    const m = new THREE.Mesh(g, im.shell); m.castShadow = false; m.position.copy(o.position); m.quaternion.copy(o.quaternion);
    o.parent.add(m);
  });
  // 床（胴体より細くして外へ突き出さないように）
  const [tw, th, tl, tx, ty, tz] = cab.tub;
  const tub = new THREE.Mesh(new THREE.BoxGeometry(tw, th, tl), im.tub); tub.position.set(tx, ty, tz); group.add(tub);
  for (const p of cab.pilots) group.add(pilot(im, ...p));
  const parts = { ailerons: ctl.ailerons, brakes: ctl.brakes, wheels: ctl.wheels, eye: new THREE.Vector3(...cab.eye) };
  if (ctl.eye) parts.eye.copy(ctl.eye.position);
  parts.panel = new THREE.Group(); parts.panel.position.copy(ctl.panel ? ctl.panel.position : new THREE.Vector3(...cab.panel)); group.add(parts.panel);
  // プロペラの回転円（高回転で羽根の代わりに薄い円盤を見せる）
  let disc = null;
  if (ctl.props.length) {
    disc = new THREE.Mesh(new THREE.CircleGeometry(0.9, 40), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    disc.position.copy(ctl.props[0].position); disc.position.z -= 0.01; group.add(disc);
    parts.prop = ctl.props[0]; parts.disc = disc;
  }
  let brakeK = 0;
  return {
    group, parts, source: 'blender',
    animate(s, dt, rpm = 0) {
      // 舵面はヒンジ（ノードのローカル軸）まわりに回す。符号は models.js と同じ
      for (const a of ctl.ailerons) a.quaternion.copy(a.userData.q0).multiply(qTmp.setFromAxisAngle(X, -s.aileron * 0.35 * (a.userData.side ?? 1)));
      for (const e of ctl.elevator) e.quaternion.copy(e.userData.q0).multiply(qTmp.setFromAxisAngle(X, s.elevator * 0.35));
      for (const r of ctl.rudder) r.quaternion.copy(r.userData.q0).multiply(qTmp.setFromAxisAngle(Y, -s.rudder * 0.45));
      brakeK += ((s.brake ? 1 : 0) - brakeK) * Math.min(1, dt * 3);
      for (const b of ctl.brakes) b.position.copy(b.userData.p0).addScaledVector(Y.clone().applyQuaternion(b.userData.q0), brakeK * (b.userData.travel ?? 0.11));
      for (const w of ctl.wheels) w.rotation.x -= (s.wheelSpinDelta || 0);
      if (disc) {
        const blur = THREE.MathUtils.clamp((rpm - 900) / 1500, 0, 1);
        for (const p of ctl.props) { p.rotation.z += dt * rpm * 0.10472 * 0.35; p.visible = blur < 0.98; }
        disc.material.opacity = blur * 0.16;
      }
    }
  };
}

// 互換：以前の呼び出し名
export const makeGliderFromGLB = (lods, quality) => makeAircraftFromGLB(lods, quality, 'glider');
