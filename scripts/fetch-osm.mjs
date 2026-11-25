#!/usr/bin/env node
// OpenStreetMap（Overpass API）から、滑空場まわりの建物・道路・土地利用・水域・樹林を取得し、
// SIM の座標（x = 東, z = 南 [m]、原点は滑走路中心）に直した assets/data/osm.json を作る。
//
//   node scripts/fetch-osm.mjs                  … 広域地形（約 8 km 四方）の範囲
//   node scripts/fetch-osm.mjs --area detail    … 詳細地形（約 2 × 3 km）＋周り 300 m だけ
//   node scripts/fetch-osm.mjs --endpoint <URL> … 別の Overpass サーバーを使う
//
// 出典：© OpenStreetMap contributors（ODbL 1.0）。アプリと配布物に出典を表示すること。
// https://www.openstreetmap.org/copyright
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'assets', 'data');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
// 公開サーバーは混み合うことがあるので、順に試し、だめなら待ち時間を倍にして再試行する（1 回きりの取得用）
const ENDPOINTS = args.endpoint ? [args.endpoint] : [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
const OUT = path.resolve(args.out || path.join(DATA, 'osm.json'));
const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'terrain.json'), 'utf8'));
const detail = JSON.parse(fs.readFileSync(path.join(DATA, 'detail.json'), 'utf8'));

// ---- 座標：Web メルカトルを原点の緯度での地上距離 [m] に換算（fetch-gsi.mjs・同梱データと同じ） ----
const C = 40075016.686, Z = 20;
const mercX = lon => (lon + 180) / 360 * 256 * 2 ** Z;
const mercY = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 256 * 2 ** Z;
const MPP = C * Math.cos(meta.lat * Math.PI / 180) / (256 * 2 ** Z);
const X0 = mercX(meta.lon), Y0 = mercY(meta.lat);
const toLocal = (lat, lon) => [Math.round((mercX(lon) - X0) * MPP * 10) / 10, Math.round((mercY(lat) - Y0) * MPP * 10) / 10];
const toLon = x => (x / MPP + X0) / (256 * 2 ** Z) * 360 - 180;
const toLat = z => Math.atan(Math.sinh(Math.PI * (1 - 2 * (z / MPP + Y0) / (256 * 2 ** Z)))) * 180 / Math.PI;

const rect = args.area === 'detail'
  ? { xmin: detail.xmin - 300, xmax: detail.xmin + detail.width + 300, zmin: detail.zmin - 300, zmax: detail.zmin + detail.depth + 300 }
  : { xmin: meta.xmin, xmax: meta.xmin + meta.size, zmin: meta.zmin, zmax: meta.zmin + meta.size };
const bbox = [toLat(rect.zmax), toLon(rect.xmin), toLat(rect.zmin), toLon(rect.xmax)].map(v => v.toFixed(6)).join(',');

const query = `[out:json][timeout:180][bbox:${bbox}];
(
  way["building"];
  relation["building"];
  way["highway"];
  way["landuse"];
  relation["landuse"];
  way["natural"~"^(wood|scrub|grassland|water|wetland|sand|heath)$"];
  relation["natural"~"^(wood|water|wetland)$"];
  way["leisure"~"^(park|golf_course|pitch|playground|nature_reserve)$"];
  way["waterway"];
  way["aeroway"];
  way["man_made"~"^(embankment|dyke)$"];
  way["barrier"="hedge"];
  node["natural"="tree"];
);
out body;
>;
out skel qt;`;

async function overpass() {
  let wait = 15;
  for (let attempt = 1; attempt <= 6; attempt++) {
    for (const url of ENDPOINTS) {
      console.log(`Overpass に問い合わせ中（${attempt} 回目、${new URL(url).host}、${bbox}）…`);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'sekiyado-soaring-fetch-osm' },
          body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(240000)
        });
        if (res.ok) return await res.json();
        console.log(`  ${res.status}：${(await res.text()).split('\n').slice(0, 3).join(' ')}`);
      } catch (e) { console.log('  接続エラー：', e.message); }
    }
    console.log(`  ${wait} 秒待って再試行します`);
    await new Promise(r => setTimeout(r, wait * 1000)); wait *= 2;
  }
  throw new Error('Overpass から取得できませんでした');
}
const osm = await overpass();

const nodes = new Map(), ways = new Map();
for (const e of osm.elements) {
  if (e.type === 'node') nodes.set(e.id, e);
  else if (e.type === 'way') ways.set(e.id, e);
}
const wayPts = w => w.nodes.map(id => nodes.get(id)).filter(Boolean).map(n => toLocal(n.lat, n.lon));
const closed = w => w.nodes.length > 3 && w.nodes[0] === w.nodes[w.nodes.length - 1];
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : undefined; };

// マルチポリゴンの外周を、つながる way を順につないで閉じた輪にする
function outerRings(rel) {
  const segs = rel.members.filter(m => m.type === 'way' && (m.role === 'outer' || m.role === '')).map(m => ways.get(m.ref)).filter(Boolean).map(w => [...w.nodes]);
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let grew = true;
    while (ring[0] !== ring[ring.length - 1] && grew) {
      grew = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], end = ring[ring.length - 1];
        if (s[0] === end) ring = ring.concat(s.slice(1));
        else if (s[s.length - 1] === end) ring = ring.concat(s.slice(0, -1).reverse());
        else continue;
        segs.splice(i, 1); grew = true; break;
      }
    }
    if (ring.length > 3 && ring[0] === ring[ring.length - 1]) rings.push({ nodes: ring });
  }
  return rings;
}

const out = {
  source: '© OpenStreetMap contributors (ODbL 1.0) https://www.openstreetmap.org/copyright',
  fetchedAt: new Date().toISOString(), bbox, axes: 'x=east, z=south [m], origin = runway centre',
  buildings: [], roads: [], areas: [], waterways: [], lines: [], trees: []
};
const areaKind = t => t.landuse || (t.natural && `natural:${t.natural}`) || (t.leisure && `leisure:${t.leisure}`) || (t.aeroway && `aeroway:${t.aeroway}`);

function addPolygon(t, pts, id) {
  if (t.building) {
    out.buildings.push({
      id, pts, type: t.building, levels: num(t['building:levels']), height: num(t.height),
      roof: t['roof:shape'], name: t.name
    });
  } else if (areaKind(t)) {
    out.areas.push({ id, kind: areaKind(t), crop: t.crop, leaf: t.leaf_type, pts });
  }
}

for (const w of ways.values()) {
  const t = w.tags; if (!t) continue;
  const pts = wayPts(w); if (pts.length < 2) continue;
  if (closed(w) && (t.building || (areaKind(t) && !t.highway && !t.waterway))) addPolygon(t, pts, w.id);
  else if (t.highway) out.roads.push({ id: w.id, kind: t.highway, surface: t.surface, lanes: num(t.lanes), width: num(t.width), bridge: t.bridge === 'yes', pts });
  else if (t.waterway) out.waterways.push({ id: w.id, kind: t.waterway, width: num(t.width), pts });
  else if (t.aeroway) out.lines.push({ id: w.id, kind: `aeroway:${t.aeroway}`, pts });
  else if (t.man_made || t.barrier) out.lines.push({ id: w.id, kind: t.man_made || `barrier:${t.barrier}`, pts });
}
for (const e of osm.elements) {
  if (e.type === 'relation' && e.tags) for (const r of outerRings(e)) addPolygon(e.tags, r.nodes.map(id => nodes.get(id)).filter(Boolean).map(n => toLocal(n.lat, n.lon)), e.id);
  if (e.type === 'node' && e.tags?.natural === 'tree') out.trees.push({ id: e.id, pt: toLocal(e.lat, e.lon), height: num(e.tags.height) });
}

fs.writeFileSync(OUT, JSON.stringify(out));
const count = Object.fromEntries(Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
console.log(`保存しました：${OUT}`, count, `${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`);
