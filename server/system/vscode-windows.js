import path from 'node:path';
import { spawn } from 'node:child_process';
import { SCRIPTS_DIR, IS_WINDOWS, audit } from '../config.js';

const SCRIPT = path.join(SCRIPTS_DIR, 'vscode-windows.ps1');

function runPowerShell(args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    if (!IS_WINDOWS) {
      reject(Object.assign(new Error('当前仅支持 Windows'), { status: 400 }));
      return;
    }
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, ...args,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(Object.assign(new Error('读取 VS Code 窗口超时'), { status: 504 }));
    }, timeoutMs);
    child.stdout.on('data', (buf) => { stdout += buf.toString('utf8'); });
    child.stderr.on('data', (buf) => { stderr += buf.toString('utf8'); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(Object.assign(new Error(stderr.trim() || `PowerShell 退出码 ${code}`), { status: 500 }));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch {
        reject(Object.assign(new Error('无法解析 VS Code 窗口列表'), { status: 500 }));
      }
    });
  });
}

export async function listVSCodeWindows() {
  const data = await runPowerShell(['-Action', 'list']);
  return Array.isArray(data) ? data : (data?.windows || []);
}

export async function closeVSCodeWindow(id) {
  if (!/^\d{1,20}$/.test(String(id))) {
    throw Object.assign(new Error('无效的窗口 ID'), { status: 400 });
  }
  const data = await runPowerShell(['-Action', 'close', '-Hwnd', String(id)]);
  if (!data?.ok) {
    const reason = data?.reason === 'not_found' ? '窗口已经不存在' : '关闭窗口失败';
    throw Object.assign(new Error(reason), { status: data?.reason === 'not_found' ? 404 : 500 });
  }
  audit('vscode.window.close', `${data.title || id}`);
  return data;
}

export async function focusVSCodeWindow(id) {
  if (!/^\d{1,20}$/.test(String(id))) {
    throw Object.assign(new Error('无效的窗口 ID'), { status: 400 });
  }
  const data = await runPowerShell(['-Action', 'focus', '-Hwnd', String(id)]);
  if (!data?.ok) {
    throw Object.assign(new Error(data?.reason === 'not_found' ? '窗口已经不存在' : '定位窗口失败'), {
      status: data?.reason === 'not_found' ? 404 : 500,
    });
  }
  return data;
}
