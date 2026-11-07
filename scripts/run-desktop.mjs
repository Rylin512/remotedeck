import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.error('未安装 Electron，请先运行 npm install。');
  process.exit(1);
}
if (!electronPath || !fs.existsSync(electronPath)) {
  console.error('找不到 Electron 运行时，请重新运行：node node_modules\\electron\\install.js');
  process.exit(1);
}

// Chromium cannot start reliably when electron.exe lives under a path with
// non-ASCII characters (this project is under "远程控制软件"). Keep a cached
// copy of the runtime at an ASCII path and launch the same app directory.
if (/[^\x00-\x7F]/.test(electronPath)) {
  try {
    const version = require('electron/package.json').version;
    const cacheRoot = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'RemoteDeck',
      'runtime',
      `electron-${version}`,
    );
    const cachedExe = path.join(cacheRoot, 'electron.exe');
    const marker = path.join(cacheRoot, '.ready');
    if (!fs.existsSync(cachedExe) || !fs.existsSync(marker)) {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
      fs.mkdirSync(cacheRoot, { recursive: true });
      fs.cpSync(path.dirname(electronPath), cacheRoot, { recursive: true, force: true });
      fs.writeFileSync(marker, version);
    }
    electronPath = cachedExe;
  } catch (err) {
    console.error('准备桌面运行时失败:', err.message);
    process.exit(1);
  }
}

const env = { ...process.env };
// A DSH/Electron terminal may export ELECTRON_RUN_AS_NODE=1. If Electron
// inherits it, the desktop app starts as Node and immediately exits.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('error', (err) => {
  console.error('启动桌面版失败:', err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
