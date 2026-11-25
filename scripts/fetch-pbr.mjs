#!/usr/bin/env node
// 地面の近距離ディテール用の写真ベース PBR 素材（芝・土・舗装）を Poly Haven（CC0）から取得する。
//   node scripts/fetch-pbr.mjs   → assets/data/pbr/{grass,soil,asphalt}_{albedo,normal,rough}.jpg と CREDITS.json
// 候補の素材が無くなっていたら、同じ分類の別の素材を使う。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'data', 'pbr');
const RES = process.env.PBR_RES || '1k';
const WANT = {
  grass: { ids: ['aerial_grass_rock', 'grass_path_2', 'leafy_grass', 'forrest_ground_01', 'rocky_terrain_02'], tags: ['grass', 'lawn', 'meadow'] },
  soil: { ids: ['brown_mud_leaves_01', 'brown_mud_02', 'dry_ground_01', 'red_dirt_mud_01', 'forrest_ground_01'], tags: ['mud', 'soil', 'dirt', 'ground'] },
  asphalt: { ids: ['asphalt_02', 'asphalt_track', 'asphalt_01', 'asphalt_03'], tags: ['asphalt', 'road'] }
};
const UA = { 'User-Agent': 'sekiyado-soaring-fetch-pbr' };
const getJSON = async u => { const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };

const all = await getJSON('https://api.polyhaven.com/assets?t=textures');
fs.mkdirSync(OUT, { recursive: true });
const credits = {};
const used = new Set();
for (const [name, want] of Object.entries(WANT)) {
  let id = want.ids.find(i => all[i] && !used.has(i));
  if (!id) id = Object.keys(all).find(i => !used.has(i) && (all[i].tags || []).concat(all[i].categories || []).some(t => want.tags.includes(String(t).toLowerCase())));
  if (!id) throw new Error(`${name} の素材が見つかりません`);
  used.add(id);
  const files = await getJSON(`https://api.polyhaven.com/files/${id}`);
  const pick = (...keys) => { for (const k of Object.keys(files)) if (keys.includes(k.toLowerCase())) return files[k]; return null; };
  const maps = { albedo: pick('diffuse', 'diff', 'albedo'), normal: pick('nor_gl', 'normal'), rough: pick('rough', 'roughness') };
  for (const [kind, m] of Object.entries(maps)) {
    const f = m?.[RES]?.jpg || m?.[RES]?.png;
    if (!f) throw new Error(`${id} に ${kind} の ${RES} がありません`);
    const buf = Buffer.from(await (await fetch(f.url, { headers: UA })).arrayBuffer());
    const ext = f.url.endsWith('.png') ? 'png' : 'jpg';
    fs.writeFileSync(path.join(OUT, `${name}_${kind}.${ext}`), buf);
    console.log(`${name}_${kind}.${ext} ← ${id}（${(buf.length / 1024).toFixed(0)} KB）`);
  }
  credits[name] = { id, name: all[id].name, authors: all[id].authors, license: 'CC0 1.0', url: `https://polyhaven.com/a/${id}` };
}
fs.writeFileSync(path.join(OUT, 'CREDITS.json'), JSON.stringify({ source: 'Poly Haven (https://polyhaven.com)', resolution: RES, materials: credits }, null, 2));
console.log('保存しました：', OUT);
