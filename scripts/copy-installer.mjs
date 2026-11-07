import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(ROOT, 'dist');
const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const destDir = path.join(local, 'RemoteDeck');
const dest = path.join(destDir, 'RemoteDeck-Setup.exe');

if (!fs.existsSync(dist)) {
  console.error('dist 不存在，请先运行构建。');
  process.exit(1);
}
const candidates = fs.readdirSync(dist)
  .filter((name) => /^RemoteDeck-.*-setup\.exe$/i.test(name))
  .map((name) => path.join(dist, name))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
if (!candidates.length) {
  console.error('dist 中没有找到 RemoteDeck setup.exe');
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(candidates[0], dest);
console.log(`安装包已复制到 ASCII 路径：${dest}`);
