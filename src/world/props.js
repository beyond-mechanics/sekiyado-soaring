// 飛行場の小物（Blender 製：blender/props/*.py → assets/data/models/*.glb）を置く。
// ピスト（地上発航の位置の横）にテント一式とグライダートレーラー、吹き流しは景観の吹き流しを置き換える。
import * as THREE from 'three';
import { RUNWAY_HEADING } from '../sim/flight.js';

const H = RUNWAY_HEADING, SH = Math.sin(H), CH = Math.cos(H);
// 滑走路座標（along：RWY36 方向、cross：右が +）→ 世界座標。scenery.js の標識と同じ式
const world = (along, cross) => ({ x: SH * along + CH * cross, z: -CH * along + SH * cross });

// 置き場所（目安。航空写真で滑走路東側の草地を選んだ。実際のピストの位置を教えてもらえれば直す）。
// 地上発航位置（along -640）の右、滑走路の外。西側は河岸なので置かない
const PLACES = {
  // RWY 18（北端から南向きに離陸）。発航点 x≈-84, z≈-635（along≈+640）の東側の草地に置く
  tent: [{ along: 640, cross: 42, yaw: Math.PI }],           // 正面（机の側）を滑走路へ向ける
  trailer: [{ along: 600, cross: 64, yaw: 0 }, { along: 598, cross: 67.5, yaw: 0 }, { along: 601, cross: 71, yaw: 0.04 }],
  windsock: [{ x: 95, z: 120 }]   // scenery.js の吹き流しと同じ位置
};

function withLods(lod0, lod1, quality, far) {
  const l = new THREE.LOD();
  if (lod0 && quality > 0) l.addLevel(lod0, 0);
  if (lod1) l.addLevel(lod1, lod0 && quality > 0 ? 90 : 0);
  l.addLevel(new THREE.Object3D(), far);       // 遠くでは描かない
  l.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return l;
}

export async function buildAirfieldProps(scene, height, quality, loadGLB, scenery) {
  const load = name => Promise.all([quality > 0 ? loadGLB(`data/models/${name}.glb`) : null, loadGLB(`data/models/${name}_lod1.glb`)]);
  const [[t0, t1], [r0, r1], [w0, w1]] = await Promise.all([load('pist_tent'), load('glider_trailer'), load('windsock')]);
  const group = new THREE.Group(); group.name = 'airfield-props'; scene.add(group);
  const place = (obj, x, z, yaw) => { obj.position.set(x, height(x, z), z); obj.rotation.y = -H + yaw; group.add(obj); return obj; };
  for (const p of PLACES.tent) { const { x, z } = world(p.along, p.cross); place(withLods(t0?.clone(), t1.clone(), quality, 2500), x, z, p.yaw); }
  for (const p of PLACES.trailer) { const { x, z } = world(p.along, p.cross); place(withLods(r0?.clone(), r1.clone(), quality, 3000), x, z, p.yaw); }
  // 吹き流し：回転部と布の輪を探して、従来と同じ式で動かす
  const socks = [];
  for (const p of PLACES.windsock) {
    const l = withLods(w0, w1, quality, 3000);
    place(l, p.x, p.z, H);   // 回転は風向で決めるので向きは北のまま
    l.rotation.y = 0;
    l.traverse(o => {
      const n = o.name.replace(/_LOD1$/, '');
      if (n === 'sock_pivot') socks.push({ pivot: o, segs: [] });
    });
    for (const s of socks) s.pivot.traverse(o => { if (/^sock_seg_\d/.test(o.name)) { o.userData.p0 = o.position.clone(); s.segs.push(o); } });
  }
  if (socks.length && scenery?.windsock) scenery.windsock.visible = false;
  console.info(`飛行場の小物：テント ${PLACES.tent.length}・トレーラー ${PLACES.trailer.length}・吹き流し ${socks.length ? 'Blender 製' : '従来'}`);
  return {
    group,
    // windTo：風が吹いていく方位（scenery.js と同じ）、windSpeed：m/s
    update(time, windTo, windSpeed) {
      const lift = Math.min(1, windSpeed / 7.7);     // 15 kt で水平
      for (const s of socks) {
        s.pivot.rotation.y = -windTo + Math.PI;
        s.segs.sort((a, b) => a.userData.p0.z - b.userData.p0.z).forEach((m, i) => {
          const d = m.userData.p0.z;
          m.position.set(m.userData.p0.x, m.userData.p0.y - (1 - lift) * d * 0.9, d * (0.35 + 0.65 * lift) + 0.1 * (1 - lift));
          m.rotation.set(-(1 - lift) * 1.1, 0, Math.sin(time * 6 + i) * 0.05 * lift);
        });
      }
    }
  };
}
