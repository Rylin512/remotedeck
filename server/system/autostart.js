import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, SCRIPTS_DIR, IS_WINDOWS, audit } from '../config.js';

function startupDir() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function shortcutPath() {
  return path.join(startupDir(), 'RemoteDeck.lnk');
}

export function isEnabled() {
  try { return fs.existsSync(shortcutPath()); } catch { return false; }
}

function runPowerShell(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(SCRIPTS_DIR, script), ...args,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => { stdout += buf.toString(); });
    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr.trim() || stdout.trim() || `PowerShell 退出码 ${code}`));
    });
  });
}

export async function setEnabled(enabled) {
  if (!IS_WINDOWS) throw Object.assign(new Error('当前仅支持 Windows'), { status: 400 });
  const want = Boolean(enabled);
  if (want === isEnabled()) return { enabled: want, changed: false };
  const script = want ? 'install-autostart.ps1' : 'uninstall-autostart.ps1';
  const result = await runPowerShell(script, ['-Root', ROOT]);
  audit('autostart', want ? 'enabled' : 'disabled');
  return { enabled: isEnabled(), changed: true, output: result.stdout ? result.stdout.slice(0, 200) : '' };
}

export function status() {
  return {
    enabled: isEnabled(),
    shortcut: shortcutPath(),
    supported: IS_WINDOWS,
  };
}
