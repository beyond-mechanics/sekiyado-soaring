// 遠景地形（筑波山・日光連山・秩父・富士山など）用の標高グリッドを作る。
// データ: Mapzen/AWS Terrain Tiles (terrarium) — 出典は README を参照。
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const LAT0 = 36.01565, LON0 = 139.81657;
const HALF = 150000;            // 中心から ±150 km
const N = 768;                  // 出力グリッド (N+1)×(N+1)
const Z = 10;
const out = process.argv[2] || 'assets/data/far_dem.bin';
const cache = path.join(path.dirname(out), '.tilecache');
fs.mkdirSync(cache, { recursive: true });

const mPerDegLon = 111320 * Math.cos(LAT0 * Math.PI / 180), mPerDegLat = 110574;
const tiles = new Map();
async function tile(tx, ty) {
  const key = `${tx}_${ty}`;
  if (tiles.has(key)) return tiles.get(key);
  const file = path.join(cache, `t${Z}_${key}.png`);
  if (!fs.existsSync(file)) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`;
    for (let attempt = 0; ; attempt++) {
      try { const r = await fetch(url); if (!r.ok) throw Error(r.status); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); break; }
      catch (e) { if (attempt > 3) throw e; await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); }
    }
  }
  const png = PNG.sync.read(fs.readFileSync(file));
  tiles.set(key, png); return png;
}
function project(lat, lon) {
  const n = 2 ** Z, x = (lon + 180) / 360 * n * 256;
  const y = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n * 256;
  return [x, y];
}
async function px(gx, gy) {
  const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256), t = await tile(tx, ty);
  const i = ((gy - ty * 256) * 256 + (gx - tx * 256)) * 4, d = t.data;
  return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
}
async function sample(lat, lon) {
  const [x, y] = project(lat, lon), x0 = Math.floor(x - .5), y0 = Math.floor(y - .5), a = x - .5 - x0, b = y - .5 - y0;
  const h00 = await px(x0, y0), h10 = await px(x0 + 1, y0), h01 = await px(x0, y0 + 1), h11 = await px(x0 + 1, y0 + 1);
  return (h00 * (1 - a) + h10 * a) * (1 - b) + (h01 * (1 - a) + h11 * a) * b;
}
const data = new Int16Array((N + 1) * (N + 1));
for (let j = 0; j <= N; j++) {
  const zz = -HALF + 2 * HALF * j / N, lat = LAT0 - zz / mPerDegLat;
  for (let i = 0; i <= N; i++) {
    const xx = -HALF + 2 * HALF * i / N, lon = LON0 + xx / mPerDegLon;
    data[j * (N + 1) + i] = Math.round(Math.max(-100, await sample(lat, lon)));
  }
  if (j % 64 === 0) console.log(`row ${j}/${N} (tiles ${tiles.size})`);
}
const header = Buffer.alloc(16); header.writeUInt32LE(N, 0); header.writeFloatLE(HALF, 4);
fs.writeFileSync(out, Buffer.concat([header, Buffer.from(data.buffer)]));
console.log('wrote', out, 'max', data.reduce((a, b) => Math.max(a, b), -1e9));
