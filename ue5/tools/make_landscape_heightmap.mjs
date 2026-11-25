#!/usr/bin/env node
// 同梱の標高データ（assets/data の elevation.json＋detail.json）から、
// UE5 の Landscape に読み込める 16bit 高さマップと読み込み設定を作る（外部パッケージ不要）。
//
//   node ue5/tools/make_landscape_heightmap.mjs [--size 1009|2017|4033|8129] [--data assets/data] [--out ue5/SekiyadoUE/RawData]
//
// 出力：
//   sekiyado_heightmap_<size>.png … 16bit グレースケール PNG（Landscape の「Import from File」で指定）
//   sekiyado_heightmap_<size>.r16 … 同じ内容の RAW（リトルエンディアン）
//   sekiyado_heightmap_<size>.json … Landscape の Location / Scale に入れる値
//
// 向き：UE は X=北, Y=東。高さマップの列（横）方向が UE の X（北）、行（縦）方向が Y（東）になる。
// 高さの換算は UE の規約どおり 高さ[cm] = (値 − 32768) / 128 × ScaleZ。
// DEM5A（5m 間隔）を fetch-gsi で取った data-hires を --data に渡せば 2017 以上で細かくなる。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const SIZE = Number(args.size || 1009);
if (![505, 1009, 2017, 4033, 8129].includes(SIZE)) throw Error('--size は UE 推奨値（505, 1009, 2017, 4033, 8129）にしてください');
const DATA = path.resolve(args.data || path.join(ROOT, 'assets', 'data'));
const OUT = path.resolve(args.out || path.join(ROOT, 'ue5', 'SekiyadoUE', 'RawData'));
const SCALE_Z = Number(args['scale-z'] || 20);   // ±256 × 20 / 100 = ±51.2 m、刻み 1.6 mm

const read = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const meta = read('terrain.json'), dem = read('elevation.json'), detail = read('detail.json');

// ---- src/world/terrain.js の makeHeight と同じ補間（遠景 far_dem は別メッシュにするので使わない） ----
function sampleGrid(d, x, z) {
  const nx = d.segx, nz = d.segz;
  const u = Math.max(0, Math.min(nx - 1e-7, (x - d.xmin) / d.width * nx)), v = Math.max(0, Math.min(nz - 1e-7, (z - d.zmin) / d.depth * nz));
  const i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j, n = nx + 1, h = d.heights;
  return (h[j * n + i] * (1 - a) + h[j * n + i + 1] * a) * (1 - b) + (h[(j + 1) * n + i] * (1 - a) + h[(j + 1) * n + i + 1] * a) * b;
}
const base = { xmin: meta.xmin, zmin: meta.zmin, width: meta.size, depth: meta.size, segx: dem.segments, segz: dem.segments, heights: dem.heights };
function height(x, z) {
  const low = sampleGrid(base, x, z);
  const edge = Math.min(x - detail.xmin, detail.xmin + detail.width - x, z - detail.zmin, detail.zmin + detail.depth - z);
  if (edge <= 0) return low;
  const mix = Math.min(1, edge / (meta.size / dem.segments));
  return low + (sampleGrid(detail, x, z) - low) * mix;
}

// ---- 格子を作る：列 i → 北向き（z が減る）、行 j → 東向き（x が増える） ----
const step = meta.size / (SIZE - 1);
const zmax = meta.zmin + meta.size;
const values = new Uint16Array(SIZE * SIZE);
let hmin = Infinity, hmax = -Infinity, clipped = 0;
for (let j = 0; j < SIZE; j++) {
  const x = meta.xmin + j * step;
  for (let i = 0; i < SIZE; i++) {
    const z = zmax - i * step;
    const h = height(x, z);
    hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
    let v = Math.round(32768 + h * 100 * 128 / SCALE_Z);
    if (v < 0 || v > 65535) { clipped++; v = Math.max(0, Math.min(65535, v)); }
    values[j * SIZE + i] = v;
  }
}

// ---- 16bit グレースケール PNG（自前の最小エンコーダー） ----
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 16; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc(SIZE * (1 + SIZE * 2));
for (let j = 0; j < SIZE; j++) {
  const o = j * (1 + SIZE * 2); raw[o] = 0;
  for (let i = 0; i < SIZE; i++) raw.writeUInt16BE(values[j * SIZE + i], o + 1 + i * 2);
}
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

fs.mkdirSync(OUT, { recursive: true });
const name = `sekiyado_heightmap_${SIZE}`;
fs.writeFileSync(path.join(OUT, `${name}.png`), png);
fs.writeFileSync(path.join(OUT, `${name}.r16`), Buffer.from(values.buffer));
const settings = {
  source: '国土地理院 DEM（同梱 elevation.json / detail.json）', origin: { lat: meta.lat, lon: meta.lon, note: 'UE 原点 = この地点（滑走路中央）、標高 0 m' },
  size: SIZE, metersPerQuad: step,
  landscape: {
    location_cm: { X: -zmax * 100, Y: meta.xmin * 100, Z: 0 },
    scale: { X: step * 100, Y: step * 100, Z: SCALE_Z },
    note: 'Landscape モード → Import from File でこの PNG を選び、Location と Scale をこの値にする'
  },
  heightRange_m: [Number(hmin.toFixed(2)), Number(hmax.toFixed(2))], clippedSamples: clipped
};
fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(settings, null, 2) + '\n');
console.log(`${name}: ${SIZE}×${SIZE}、${step.toFixed(2)} m/格子、標高 ${hmin.toFixed(1)}〜${hmax.toFixed(1)} m、はみ出し ${clipped}`);
console.log(`  Location(cm) X=${settings.landscape.location_cm.X.toFixed(0)} Y=${settings.landscape.location_cm.Y.toFixed(0)} Z=0  Scale X=Y=${(step * 100).toFixed(2)} Z=${SCALE_Z}`);
