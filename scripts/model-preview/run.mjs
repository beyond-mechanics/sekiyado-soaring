// 使い方：node scripts/model-preview/run.mjs [出力フォルダー]
// 手続き生成の機体と Blender 製の機体を、同じカメラ・同じライトの three.js で撮って PNG に保存します。
// Playwright（Chromium）が入っている環境で動きます（npm i -D playwright など）。
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.resolve(process.argv[2] || 'renders/model-preview');
const TMP = path.join(OUT, '.site');
fs.mkdirSync(path.join(TMP, 'models'), { recursive: true });
await build({ entryPoints: [path.join(ROOT, 'scripts/model-preview/preview.js')], bundle: true, format: 'esm', outfile: path.join(TMP, 'preview.bundle.js'), logLevel: 'warning' });
fs.writeFileSync(path.join(TMP, 'index.html'), '<!doctype html><meta charset="utf-8"><style>body{margin:0}</style><script type="module" src="preview.bundle.js"></script>');
for (const f of fs.readdirSync(path.join(ROOT, 'assets/data/models'))) fs.copyFileSync(path.join(ROOT, 'assets/data/models', f), path.join(TMP, 'models', f));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const server = http.createServer((req, res) => {
  const p = path.join(TMP, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(TMP) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const shots = (process.env.VIEWS || 'front34,side,nose,rear34').split(',');
const variants = [['before', 'model=procedural'], ['after', 'model=glb'], ['after-lod1', 'model=glb&lod=1']];
for (const view of shots) for (const [name, qs] of variants) {
  if (name === 'after-lod1' && view !== 'front34') continue;
  await page.goto(`http://127.0.0.1:${port}/index.html?${qs}&view=${view}${process.env.EXTRA || ''}`);
  const r = await page.waitForFunction(() => window.__done, null, { timeout: 120000 }).then(h => h.jsonValue());
  if (r.error) { console.error(r.error); process.exitCode = 1; continue; }
  const file = path.join(OUT, `${view}-${name}.png`);
  await page.locator('canvas').screenshot({ path: file });
  console.log(file, `${r.tris.toLocaleString()} tris`);
}
await browser.close(); server.close();
