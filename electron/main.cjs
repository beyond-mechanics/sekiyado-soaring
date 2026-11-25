// SEKIYADO SOARING — Electron メインプロセス
const { app, BrowserWindow, protocol, net, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

// 高解像度データ（scripts/fetch-gsi.mjs の出力）は、ユーザーデータフォルダーに置けば
// 再インストールなしで同梱データより優先して読み込まれる。
function hiresDir() { return path.join(app.getPath('userData'), 'data-hires'); }

function resolveAsset(urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (rel.startsWith('data/')) {
    const name = rel.slice(5);
    for (const dir of [hiresDir(), path.join(ROOT, 'assets', 'data-hires'), path.join(ROOT, 'assets', 'data')]) {
      const p = path.normalize(path.join(dir, name));
      if (p.startsWith(dir) && fs.existsSync(p)) return p;
    }
    return null;
  }
  const p = path.normalize(path.join(ROOT, 'app', rel));
  return p.startsWith(path.join(ROOT, 'app')) && fs.existsSync(p) ? p : null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600, height: 900, minWidth: 960, minHeight: 600,
    backgroundColor: '#0f2a30', title: 'SEKIYADO SOARING', show: false,
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  // フライト録画の JSON は保存ダイアログを出さず（飛行を中断しない）ダウンロードフォルダーへ保存
  win.webContents.session.on('will-download', (e, item) => {
    item.setSavePath(path.join(app.getPath('downloads'), path.basename(item.getFilename())));
  });
  win.loadURL('app://sim/index.html');
  if (process.env.SEKIYADO_SELFTEST) selfTest(win, process.env.SEKIYADO_SELFTEST);
}

// 自己診断：地形の読み込み完了を待って画面を保存し終了（ビルド確認用）
async function selfTest(win, out) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 240; i++) {
    await wait(1000);
    const ok = await win.webContents.executeJavaScript("!document.getElementById('fly').disabled").catch(() => false);
    if (ok) break;
  }
  const info = await win.webContents.executeJavaScript("document.getElementById('dataInfo').textContent + ' / ' + document.getElementById('loadText').textContent");
  await win.webContents.executeJavaScript("document.getElementById('fly').click()");
  await wait(4000);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('SELFTEST', info);
  app.quit();
}

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', (req) => {
    const file = resolveAsset(new URL(req.url).pathname);
    if (!file) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
