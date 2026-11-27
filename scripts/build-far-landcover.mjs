// 遠景の土地被覆マップを作る（森・畑・市街地・水面などの実際の分布）。
// データ: ESA WorldCover 10 m 2021 v200（CC BY 4.0、AWS Open Data）。
//   © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium
// COG（クラウド最適化 GeoTIFF）の縮小版（overview）だけを HTTP の範囲指定で読むので、全体（1 タイル数百 MB）は落とさない。
//
//   node scripts/build-far-landcover.mjs [出力フォルダー=assets/data]
//
// 出力：landcover_far.png（±150 km、約 146 m/画素）、landcover_mid.png（±25 km、約 24 m/画素）、landcover.json
// 画素値は WorldCover の分類コードそのまま（10 樹林 20 低木 30 草地 40 農地 50 市街地 60 裸地 70 雪氷 80 水面 90 湿地 95 マングローブ 100 コケ）。
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { fromUrl } from 'geotiff';
import jpeg from 'jpeg-js';

const LAT0 = 36.01565, LON0 = 139.81657;          // build-far-dem.mjs・terrain.json と同じ原点
const mPerDegLon = 111320 * Math.cos(LAT0 * Math.PI / 180), mPerDegLat = 110574;
const BASE = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/';
// overview の番号：0 = 10 m（36000 画素/3°）、1 = 1/2、2 = 1/4 …
const GRIDS = [
  { name: 'mid', half: 25000, N: 2048, level: 1 },
  { name: 'far', half: 150000, N: 2048, level: 3 }
];
const outDir = process.argv[2] || 'assets/data';
const mids = {};

const tiffs = new Map();
async function tileImage(lat3, lon3, level) {
  const key = `${lat3}_${lon3}`;
  if (!tiffs.has(key)) {
    const name = `ESA_WorldCover_10m_2021_v200_N${String(lat3).padStart(2, '0')}E${String(lon3).padStart(3, '0')}_Map.tif`;
    tiffs.set(key, fromUrl(BASE + name).catch(e => { console.warn(`  ${name} なし（海として扱う）: ${e.message}`); return null; }));
  }
  const t = await tiffs.get(key);
  return t ? t.getImage(level) : null;
}

for (const g of GRIDS) {
  const { half, N } = g, px = 2 * half / N;
  const latMax = LAT0 + half / mPerDegLat, latMin = LAT0 - half / mPerDegLat;
  const lonMin = LON0 - half / mPerDegLon, lonMax = LON0 + half / mPerDegLon;
  const out = new Uint8Array(N * N).fill(80);
  console.log(`${g.name}: ±${half / 1000} km、${N}×${N}（${px.toFixed(0)} m/画素）`);
  for (let lat3 = Math.floor(latMin / 3) * 3; lat3 < latMax; lat3 += 3) {
    for (let lon3 = Math.floor(lonMin / 3) * 3; lon3 < lonMax; lon3 += 3) {
      const im = await tileImage(lat3, lon3, g.level);
      if (!im) continue;
      const W = im.getWidth(), deg = 3 / W;          // 1 画素の角度
      // このタイルで必要な範囲（画素）
      const a = Math.max(lonMin, lon3), b = Math.min(lonMax, lon3 + 3);
      const c = Math.max(latMin, lat3), d = Math.min(latMax, lat3 + 3);
      if (a >= b || c >= d) continue;
      const x0 = Math.max(0, Math.floor((a - lon3) / deg) - 1), x1 = Math.min(W, Math.ceil((b - lon3) / deg) + 1);
      const y0 = Math.max(0, Math.floor((lat3 + 3 - d) / deg) - 1), y1 = Math.min(W, Math.ceil((lat3 + 3 - c) / deg) + 1);
      console.log(`  N${lat3}E${lon3} overview ${g.level}: ${x1 - x0}×${y1 - y0} 画素を読み込み`);
      const [r] = await im.readRasters({ window: [x0, y0, x1, y1] });
      const w = x1 - x0;
      for (let j = 0; j < N; j++) {
        const lat = LAT0 - (-half + (j + 0.5) * px) / mPerDegLat;
        if (lat < lat3 || lat >= lat3 + 3) continue;
        const yy = Math.floor((lat3 + 3 - lat) / deg) - y0;
        if (yy < 0 || yy >= y1 - y0) continue;
        for (let i = 0; i < N; i++) {
          const lon = LON0 + (-half + (i + 0.5) * px) / mPerDegLon;
          if (lon < lon3 || lon >= lon3 + 3) continue;
          const xx = Math.floor((lon - lon3) / deg) - x0;
          if (xx < 0 || xx >= w) continue;
          const v = r[yy * w + xx];
          out[j * N + i] = v === 0 ? 80 : v;          // 0 = データなし（海上）
        }
      }
    }
  }
  mids[g.name] = out;
  const png = new PNG({ width: N, height: N, colorType: 0, inputColorType: 0, bitDepth: 8 });
  png.data = Buffer.from(out);
  const file = path.join(outDir, `landcover_${g.name}.png`);
  fs.writeFileSync(file, PNG.sync.write(png, { colorType: 0, inputColorType: 0 }));
  const hist = {}; for (const v of out) hist[v] = (hist[v] || 0) + 1;
  console.log(`  → ${file}（${(fs.statSync(file).size / 1e6).toFixed(1)} MB）`, Object.fromEntries(Object.entries(hist).map(([k, v]) => [k, (v / out.length * 100).toFixed(1) + '%'])));
}
// 色合わせ：同梱の広域航空写真（約 8 km 四方）と重なる所で、分類ごとの写真の平均色と色のばらつきを求める。
// シムはこの色で遠景を塗るので、航空写真の端で色が変わらず、写真の撮影時期の色合いになる。
const palette = {};
{
  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'terrain.json'), 'utf8'));
  const img = jpeg.decode(fs.readFileSync(path.join(outDir, 'terrain_wide.jpg')), { useTArray: true });
  const g = GRIDS.find(q => q.name === 'mid'), cls = mids.mid, px = 2 * g.half / g.N;
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const srgb = v => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  const acc = {};
  for (let j = 0; j < g.N; j++) for (let i = 0; i < g.N; i++) {
    const x = -g.half + (i + 0.5) * px, z = -g.half + (j + 0.5) * px;
    const u = (x - meta.xmin) / meta.size, v = (z - meta.zmin) / meta.size;
    if (u < 0.02 || u > 0.98 || v < 0.02 || v > 0.98) continue;
    const k = ((Math.floor(v * img.height) * img.width) + Math.floor(u * img.width)) * 4;
    const c = cls[j * g.N + i], a = acc[c] ??= [0, 0, 0, 0, 0, 0, 0];
    for (let q = 0; q < 3; q++) { const l = lin(img.data[k + q]); a[q] += l; a[q + 3] += l * l; }
    a[6]++;
  }
  for (const [c, a] of Object.entries(acc)) {
    if (a[6] < 200) continue;                         // 写真の中にほとんど無い分類は既定の色
    const mean = [0, 1, 2].map(q => a[q] / a[6]);
    const sd = [0, 1, 2].map(q => Math.sqrt(Math.max(0, a[q + 3] / a[6] - mean[q] ** 2)));
    palette[c] = { color: mean.map(srgb), spread: +(sd.reduce((x, y) => x + y) / mean.reduce((x, y) => x + y)).toFixed(3), samples: a[6] };
  }
  console.log('写真から求めた色', palette);
}
fs.writeFileSync(path.join(outDir, 'landcover.json'), JSON.stringify({
  source: 'ESA WorldCover 10m 2021 v200 (CC BY 4.0)', lat: LAT0, lon: LON0, palette,
  grids: Object.fromEntries(GRIDS.map(g => [g.name, { half: g.half, N: g.N }]))
}, null, 1) + '\n');
console.log('完了');
