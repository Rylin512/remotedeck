import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.join(ROOT, 'desktop', 'runtime');
const target = path.join(targetDir, 'node.exe');
fs.mkdirSync(targetDir, { recursive: true });

if (!fs.existsSync(process.execPath)) {
  console.error('找不到当前 Node 运行时:', process.execPath);
  process.exit(1);
}
fs.copyFileSync(process.execPath, target);
const stat = fs.statSync(target);
console.log(`已准备内置 Node 运行时：${target} (${Math.round(stat.size / 1024 / 1024)} MB)`);
