#!/usr/bin/env node
// 国土地理院タイルから高解像度の航空写真と DEM5A 標高を取得し、SIM 用データを作る。
// ネットに接続できる PC で 1 回だけ実行します（数分〜十数分）。
//
//   node scripts/fetch-gsi.mjs                 … 写真 ズーム18（約0.48m/画素）＋広域ズーム16
//   node scripts/fetch-gsi.mjs --zoom 17       … 軽量版（約0.97m/画素）
//   node scripts/fetch-gsi.mjs --out <フォルダ> … 出力先（既定：assets/data-hires）
//
// 出力したフォルダの中身を、インストール版ではユーザーデータフォルダーの data-hires へコピーします
//   Windows: %APPDATA%\sekiyado-soaring\data-hires   macOS: ~/Library/Application Support/sekiyado-soaring/data-hires
// 出典：国土地理院（地理院タイル 全国最新写真（シームレス）・数値標高モデル DEM5A）
// 利用規約：https://maps.gsi.go.jp/development/ichiran.html （出典の明示が必要です）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const ZOOM = Number(args.zoom || 18), WIDE_ZOOM = Number(args['wide-zoom'] || 16), CHUNK_TILES = Number(args['chunk-tiles'] || 8);
const OUT = path.resolve(args.out || path.join(HERE, '..', 'assets', 'data-hires'));
const BASE = args.base || 'https://cyberjapandata.gsi.go.jp/xyz';
const DATA = path.join(HERE, '..', 'assets', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'terrain.json'), 'utf8'));
const detail = JSON.parse(fs.readFileSync(path.join(DATA, 'detail.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
const cacheDir = path.join(OUT, '.cache'); fs.mkdirSync(cacheDir, { recursive: true });

// ---- 座標：Web メルカトルのピクセルを原点の緯度での地上距離 [m] に換算（同梱データと同じ） ----
const C = 40075016.686;
const mercX = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
const mercY = (lat, z) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 256 * 2 ** z;
const mpp = z => C * Math.cos(meta.lat * Math.PI / 180) / (256 * 2 ** z);
const toLocal = (px, py, z) => [(px - mercX(meta.lon, z)) * mpp(z), (py - mercY(meta.lat, z)) * mpp(z)];
const toPixel = (x, zz, z) => [mercX(meta.lon, z) + x / mpp(z), mercY(meta.lat, z) + zz / mpp(z)];

let requests = 0;
async function getTile(layer, z, x, y, ext) {
  const file = path.join(cacheDir, `${layer}_${z}_${x}_${y}.${ext}`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const url = `${BASE}/${layer}/${z}/${x}/${y}.${ext}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'sekiyado-soaring-sim (aviation club, offline cache)' } });
      if (r.status === 404) return null;
      if (!r.ok) throw Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(file, buf); requests++;
      await new Promise(res => setTimeout(res, 60));   // サーバーへの負荷を抑える
      return buf;
    } catch (e) {
      if (attempt >= 4) { console.warn('  取得失敗', url, e.message); return null; }
      await new Promise(res => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
}

async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

// 写真タイルを tx0..tx1, ty0..ty1 の範囲で 1 枚に合成
async function mosaic(z, tx0, ty0, nx, ny) {
  const W = nx * 256, H = ny * 256, out = Buffer.alloc(W * H * 4, 0);
  const jobs = []; for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) jobs.push([i, j]);
  await pool(jobs, 4, async ([i, j]) => {
    const buf = await getTile('seamlessphoto', z, tx0 + i, ty0 + j, 'jpg');
    if (!buf) return;
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    for (let y = 0; y < 256; y++) out.set(img.data.subarray(y * 1024, (y + 1) * 1024), ((j * 256 + y) * W + i * 256) * 4);
  });
  return { W, H, data: out };
}

// 霞の除去（チャンネルごとのレベル補正）。全チャンクで同じ値を使う。
function levels(samples) {
  const ch = [0, 1, 2].map(c => samples.map(p => p[c]).sort((a, b) => a - b));
  const q = (a, f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  return { lo: ch.map(a => q(a, 0.005)), hi: ch.map(a => q(a, 0.995)) };
}
function applyLevels(img, L) {
  const d = img.data, lut = [0, 1, 2].map(c => { const t = new Uint8Array(256); for (let v = 0; v < 256; v++) t[v] = Math.max(0, Math.min(255, Math.round((v - L.lo[c]) / (L.hi[c] - L.lo[c]) * 255))); return t; });
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[0][d[i]]; d[i + 1] = lut[1][d[i + 1]]; d[i + 2] = lut[2][d[i + 2]]; d[i + 3] = 255; }
}

async function main() {
  console.log(`出力先: ${OUT}`);
  // ---- 詳細域の写真（ズーム ZOOM、CHUNK_TILES×CHUNK_TILES タイルずつ） ----
  const [px0, py0] = toPixel(detail.xmin, detail.zmin, ZOOM), [px1, py1] = toPixel(detail.xmin + detail.width, detail.zmin + detail.depth, ZOOM);
  const tx0 = Math.floor(px0 / 256), ty0 = Math.floor(py0 / 256), tx1 = Math.ceil(px1 / 256), ty1 = Math.ceil(py1 / 256);
  const cx = Math.ceil((tx1 - tx0) / CHUNK_TILES), cy = Math.ceil((ty1 - ty0) / CHUNK_TILES);
  console.log(`航空写真 ズーム${ZOOM}（約${mpp(ZOOM).toFixed(2)} m/画素）: ${(tx1 - tx0) * (ty1 - ty0)} タイル、${cx}×${cy} チャンク`);
  const chunks = [], mosaics = [];
  for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    const ax = tx0 + i * CHUNK_TILES, ay = ty0 + j * CHUNK_TILES, nx = Math.min(CHUNK_TILES, tx1 - ax), ny = Math.min(CHUNK_TILES, ty1 - ay);
    process.stdout.write(`  チャンク ${j * cx + i + 1}/${cx * cy} … `);
    const m = await mosaic(ZOOM, ax, ay, nx, ny);
    const [x0, z0] = toLocal(ax * 256, ay * 256, ZOOM), [x1, z1] = toLocal((ax + nx) * 256, (ay + ny) * 256, ZOOM);
    chunks.push({ file: `photo_z${ZOOM}_${i}_${j}.jpg`, xmin: x0, zmin: z0, width: x1 - x0, depth: z1 - z0 });
    mosaics.push(m); console.log('完了');
  }
  // 霞補正の値：全チャンクから間引いてサンプル
  const samples = [];
  for (const m of mosaics) for (let k = 0; k < m.data.length; k += 4 * 97) if (m.data[k + 3] || m.data[k] || m.data[k + 1]) samples.push([m.data[k], m.data[k + 1], m.data[k + 2]]);
  const L = levels(samples);
  mosaics.forEach((m, k) => { applyLevels(m, L); fs.writeFileSync(path.join(OUT, chunks[k].file), jpeg.encode({ width: m.W, height: m.H, data: m.data }, 90).data); });

  // ---- 広域写真（約 8 km 四方、ズーム WIDE_ZOOM） ----
  const [wx0, wy0] = toPixel(meta.xmin, meta.zmin, WIDE_ZOOM), [wx1, wy1] = toPixel(meta.xmin + meta.size, meta.zmin + meta.size, WIDE_ZOOM);
  const wtx0 = Math.floor(wx0 / 256), wty0 = Math.floor(wy0 / 256), wtx1 = Math.ceil(wx1 / 256), wty1 = Math.ceil(wy1 / 256);
  console.log(`広域写真 ズーム${WIDE_ZOOM}: ${(wtx1 - wtx0) * (wty1 - wty0)} タイル`);
  const wm = await mosaic(WIDE_ZOOM, wtx0, wty0, wtx1 - wtx0, wty1 - wty0);
  // 広域メッシュの範囲（meta）に合わせて切り出し・リサンプル
  const WS = Math.min(8192, 2 ** Math.round(Math.log2(meta.size / mpp(WIDE_ZOOM))));
  const wide = { W: WS, H: WS, data: Buffer.alloc(WS * WS * 4) };
  for (let y = 0; y < WS; y++) for (let x = 0; x < WS; x++) {
    const sx = Math.min(wm.W - 1, Math.max(0, Math.round(wx0 + (wx1 - wx0) * (x + 0.5) / WS - wtx0 * 256)));
    const sy = Math.min(wm.H - 1, Math.max(0, Math.round(wy0 + (wy1 - wy0) * (y + 0.5) / WS - wty0 * 256)));
    wm.data.copy(wide.data, (y * WS + x) * 4, (sy * wm.W + sx) * 4, (sy * wm.W + sx) * 4 + 4);
  }
  applyLevels(wide, L);
  fs.writeFileSync(path.join(OUT, `wide_z${WIDE_ZOOM}.jpg`), jpeg.encode({ width: WS, height: WS, data: wide.data }, 90).data);

  // ---- DEM5A（ズーム15、5 m 間隔）→ 詳細域の標高グリッド ----
  const ux = Math.min(...chunks.map(c => c.xmin)), uz = Math.min(...chunks.map(c => c.zmin));
  const uw = Math.max(...chunks.map(c => c.xmin + c.width)) - ux, ud = Math.max(...chunks.map(c => c.zmin + c.depth)) - uz;
  const step = Number(args['mesh-step'] || 4);
  const segx = Math.round(uw / step), segz = Math.round(ud / step);
  console.log(`標高 DEM5A: ${segx + 1}×${segz + 1} 点（${step} m 間隔）`);
  const demCache = new Map();
  async function demTile(tx, ty) {
    const key = tx + ',' + ty; if (demCache.has(key)) return demCache.get(key);
    const buf = await getTile('dem5a_png', 15, tx, ty, 'png');
    const v = buf ? PNG.sync.read(buf) : null; demCache.set(key, v); return v;
  }
  // 同梱データでの補間（欠測点の補完用）
  const old = (x, z) => {
    const u = Math.max(0, Math.min(detail.segx - 1e-6, (x - detail.xmin) / detail.width * detail.segx)), v = Math.max(0, Math.min(detail.segz - 1e-6, (z - detail.zmin) / detail.depth * detail.segz));
    const i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j, n = detail.segx + 1, h = detail.heights;
    return (h[j * n + i] * (1 - a) + h[j * n + i + 1] * a) * (1 - b) + (h[(j + 1) * n + i] * (1 - a) + h[(j + 1) * n + i + 1] * a) * b;
  };
  const heights = new Array((segx + 1) * (segz + 1));
  let missing = 0;
  for (let j = 0; j <= segz; j++) for (let i = 0; i <= segx; i++) {
    const x = ux + uw * i / segx, z = uz + ud * j / segz, [px, py] = toPixel(x, z, 15);
    const t = await demTile(Math.floor(px / 256), Math.floor(py / 256));
    let h = null;
    if (t) {
      const ix = Math.floor(px) - Math.floor(px / 256) * 256, iy = Math.floor(py) - Math.floor(py / 256) * 256, k = (iy * 256 + ix) * 4;
      const val = t.data[k] * 65536 + t.data[k + 1] * 256 + t.data[k + 2];
      if (val !== 8388608) h = (val < 8388608 ? val : val - 16777216) * 0.01;
    }
    if (h === null) { h = old(x, z); missing++; }
    heights[j * (segx + 1) + i] = Math.round(h * 100) / 100;
  }
  if (missing) console.log(`  欠測 ${missing} 点は同梱データで補完`);

  const hires = {
    source: '国土地理院 地理院タイル（全国最新写真（シームレス）・DEM5A）を加工',
    created: new Date().toISOString(), zoom: ZOOM, pixelMeters: mpp(ZOOM),
    detail: { xmin: ux, zmin: uz, width: uw, depth: ud, segx, segz, heights, pixelMeters: mpp(ZOOM), meshMeters: step },
    wide: { file: `wide_z${WIDE_ZOOM}.jpg` },
    chunks
  };
  fs.writeFileSync(path.join(OUT, 'hires.json'), JSON.stringify(hires));
  console.log(`完了：${chunks.length} チャンク、新規ダウンロード ${requests} タイル。`);
  if (!args['keep-cache']) fs.rmSync(cacheDir, { recursive: true, force: true });
}
main().catch(e => { console.error(e); process.exit(1); });
