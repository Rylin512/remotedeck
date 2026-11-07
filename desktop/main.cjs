const { app, BrowserWindow, Tray, Menu, shell, clipboard, dialog, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const ICON = path.join(ASSETS, 'icon.ico');
const TRAY_ICON = path.join(ASSETS, 'tray.ico');
const START_HIDDEN = process.argv.includes('--hidden');
const PORT = Number(process.env.RD_PORT || 8787);

let window = null;
let tray = null;
let serverUrl = '';
let serverChild = null;
let externalServer = false;
let quitting = false;
let hideNoticeShown = false;

// Software rendering was forcing Chromium to composite every blur/shadow on
// the CPU, which made the panel noticeably sluggish. Keep the local page
// hardware accelerated; the sandbox switch is retained for Windows 11 LPAC
// compatibility on this machine.
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.remotedeck.desktop');
  app.on('second-instance', () => showWindow());
  app.whenReady().then(bootstrap).catch((err) => {
    dialog.showErrorBox('RemoteDeck 启动失败', err && err.message ? err.message : String(err));
    void quitApp();
  });
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1200 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(res.statusCode === 200 && data && data.ok ? `http://127.0.0.1:${port}` : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function findNode() {
  const bundled = [
    process.resourcesPath ? path.join(process.resourcesPath, 'node', 'node.exe') : '',
    path.join(ROOT, 'desktop', 'runtime', 'node.exe'),
  ].filter(Boolean);
  for (const candidate of bundled) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  const candidates = [
    process.env.RD_NODE,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return 'node.exe';
}

function startServerProcess() {
  return new Promise(async (resolve, reject) => {
    const existing = await probe(PORT);
    if (existing) {
      externalServer = true;
      resolve(existing);
      return;
    }

    const env = { ...process.env, RD_HOST: '127.0.0.1', RD_PORT: String(PORT), RD_DESKTOP_CHILD: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const node = findNode();
    const child = spawn(node, ['server/index.js'], {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    serverChild = child;
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-3000); });
    child.once('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`内置服务已退出（code ${code}）${stderr ? `：${stderr.trim()}` : ''}`));
      }
    });

    const deadline = Date.now() + 25_000;
    const tick = async () => {
      if (settled) return;
      const url = await probe(PORT);
      if (url) {
        settled = true;
        resolve(url);
        return;
      }
      if (Date.now() >= deadline) {
        settled = true;
        reject(new Error(`内置服务启动超时。${stderr ? stderr.trim() : ''}`));
        return;
      }
      setTimeout(tick, 350);
    };
    setTimeout(tick, 350);
  });
}

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  // A process started from a terminal may not be allowed to steal foreground
  // focus on Windows. Briefly pin it so the panel is actually visible.
  try { window.setAlwaysOnTop(true, 'normal'); } catch {}
  window.show();
  window.focus();
  setTimeout(() => {
    try { window && !quitting && window.setAlwaysOnTop(false); } catch {}
  }, 350);
}

function hideWindow() {
  if (!window) return;
  window.hide();
  if (!hideNoticeShown && tray) {
    hideNoticeShown = true;
    try {
      tray.displayBalloon({
        iconType: 'info',
        title: 'RemoteDeck 仍在后台运行',
        content: '单击任务栏托盘图标，或右键选择「打开 RemoteDeck」重新打开面板。',
      });
    } catch {}
  }
}

function createWindow() {
  const icon = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : undefined;
  window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: 'RemoteDeck',
    icon,
    backgroundColor: '#07101a',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.removeMenu();
  window.setMenuBarVisibility(false);

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== new URL(serverUrl).origin) {
        event.preventDefault();
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    if (window) window.setTitle('RemoteDeck');
  });

  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hideWindow();
    }
  });
  window.on('closed', () => { window = null; });
  const reveal = () => {
    if (!START_HIDDEN) showWindow();
  };
  window.once('ready-to-show', reveal);
  window.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 1500);
  void window.loadURL(serverUrl);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开 RemoteDeck', click: showWindow },
    { label: '在浏览器中打开', click: () => void shell.openExternal(serverUrl) },
    {
      label: '复制访问地址',
      click: () => {
        clipboard.writeText(serverUrl);
        if (tray) {
          try {
            tray.displayBalloon({ iconType: 'info', title: '地址已复制', content: serverUrl });
          } catch {}
        }
      },
    },
    { type: 'separator' },
    { label: externalServer ? '本机服务：复用已有进程' : '本机服务：已内置', enabled: false },
    { label: '重新加载界面', click: () => window && window.reload() },
    {
      label: '打开数据目录',
      click: () => {
        const dataDir = process.env.RD_DATA_DIR
          || path.join(process.env.LOCALAPPDATA || '', 'RemoteDeck');
        void shell.openPath(dataDir);
      },
    },
    { type: 'separator' },
    { label: '退出 RemoteDeck', click: () => void quitApp() },
  ]);
}

function createTray() {
  const icon = fs.existsSync(TRAY_ICON) ? TRAY_ICON : ICON;
  tray = new Tray(icon);
  tray.setToolTip(`RemoteDeck · ${serverUrl}`);
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

async function bootstrap() {
  serverUrl = await startServerProcess();
  createWindow();
  createTray();
}

function stopServerChild() {
  if (!serverChild) return Promise.resolve();
  const child = serverChild;
  serverChild = null;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve();
    };
    child.once('exit', finish);
    try {
      if (child.stdin && child.stdin.writable) {
        child.stdin.write('shutdown\n');
        child.stdin.end();
      } else {
        finish();
        return;
      }
    } catch {
      finish();
      return;
    }
    setTimeout(finish, 3000);
  });
}

async function quitApp() {
  if (quitting) return;
  quitting = true;
  try { await stopServerChild(); } catch {}
  try { tray && tray.destroy(); } catch {}
  tray = null;
  app.exit(0);
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void quitApp();
});
app.on('window-all-closed', () => {
  // The tray keeps the app alive on Windows.
});
app.on('activate', showWindow);
