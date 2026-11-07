import path from 'node:path';
import { spawn } from 'node:child_process';
import { IS_WINDOWS, audit } from '../config.js';

function run(exe, args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`命令超时：${exe}`));
    }, timeoutMs);
    child.stdout.on('data', (buf) => { stdout += buf.toString(); });
    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

const ACTIONS = new Set(['shutdown', 'restart', 'lock', 'sleep', 'cancel']);
const CONFIRM_WORDS = {
  shutdown: '关机',
  restart: '重启',
  lock: '锁定',
  sleep: '睡眠',
  cancel: '取消',
};

export function actionRequirements(action) {
  return { confirm: CONFIRM_WORDS[action] || '' };
}

export function validatePowerRequest({ action, confirm, delaySeconds }) {
  if (!ACTIONS.has(action)) throw Object.assign(new Error('无效的电源操作'), { status: 400 });
  const expected = CONFIRM_WORDS[action];
  if (confirm !== expected) throw Object.assign(new Error(`请输入“${expected}”以确认操作`), { status: 400 });
  const delay = Math.max(0, Math.min(Number(delaySeconds) || 0, 3600));
  return { action, delaySeconds: delay };
}

export async function performPowerAction({ action, delaySeconds = 0 }) {
  if (!IS_WINDOWS) throw Object.assign(new Error('当前仅支持 Windows'), { status: 400 });
  const shutdown = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'shutdown.exe');
  const rundll = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'rundll32.exe');
  let result;
  if (action === 'lock') {
    result = await run(rundll, ['user32.dll,LockWorkStation']);
  } else if (action === 'sleep') {
    result = await run(rundll, ['powrprof.dll,SetSuspendState', '0,1,0']);
  } else if (action === 'cancel') {
    result = await run(shutdown, ['/a']);
  } else {
    const t = Math.max(0, Math.min(Number(delaySeconds) || 0, 3600));
    const flag = action === 'restart' ? '/r' : '/s';
    result = await run(shutdown, [flag, '/t', String(t), '/c', 'RemoteDeck 远程操作']);
  }
  if (result.code !== 0) {
    const message = result.stderr || result.stdout || `退出码 ${result.code}`;
    throw Object.assign(new Error(`操作失败：${message}`), { status: 500 });
  }
  audit(`power.${action}`, `delay=${delaySeconds}s`);
  return { ok: true, action, output: result.stdout || result.stderr };
}
