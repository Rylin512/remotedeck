import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { findPeerRow, sessionsDir, isPidAlive } from './peer.js';
import { audit } from '../config.js';

function run(exe, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: -1, stdout, stderr: `${stderr}\n超时` });
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.once('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function processInfo(pid) {
  const ps = process.env.WINDIR
    ? path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const result = await run(ps, [
    '-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; "$($p.ProcessName)|$($p.StartTime.ToFileTime())"`,
  ], 8000);
  if (result.code !== 0) return null;
  const [name, start] = result.stdout.trim().split('|');
  return { name: String(name || '').toLowerCase(), start: String(start || '') };
}

async function removeRegistration(row) {
  const dir = sessionsDir();
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      if (data.sessionId !== row.sessionId) continue;
      await fsp.unlink(path.join(dir, name)).catch(() => {});
    } catch {}
  }
  if (row.messagingSocketPath) {
    const digest = crypto.createHash('sha256')
      .update(String(row.messagingSocketPath).toLowerCase())
      .digest('hex');
    await fsp.unlink(path.join(dir, `${row.pid}.${digest}.key`)).catch(() => {});
  }
}

export async function closePluginSession(sessionId, { confirm } = {}) {
  if (confirm !== '关闭') {
    throw Object.assign(new Error('请输入“关闭”以确认'), { status: 400 });
  }
  const row = await findPeerRow(sessionId);
  if (!row) {
    throw Object.assign(new Error('找不到这个会话的运行进程；它可能已经结束'), { status: 404 });
  }
  if (row.entrypoint === 'remotedeck') {
    throw Object.assign(new Error('不能通过插件接口关闭 RemoteDeck 自身'), { status: 403 });
  }
  if (!isPidAlive(row.pid)) {
    await removeRegistration(row);
    throw Object.assign(new Error('该会话进程已经退出'), { status: 409 });
  }
  const info = await processInfo(row.pid);
  if (!info || !['claude', 'node', 'bun'].includes(info.name)) {
    throw Object.assign(new Error('目标进程不是可确认的 Claude 会话，已拒绝关闭'), { status: 409 });
  }
  if (row.procStart && info.start && String(row.procStart) !== info.start) {
    throw Object.assign(new Error('进程启动时间与会话记录不匹配（PID 可能已被复用），已拒绝关闭'), { status: 409 });
  }

  const result = await run('taskkill.exe', ['/PID', String(row.pid), '/T', '/F'], 10_000);
  if (result.code !== 0) {
    const message = result.stderr || result.stdout || `taskkill 退出码 ${result.code}`;
    throw Object.assign(new Error(`关闭失败：${message}`), { status: 500 });
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (isPidAlive(row.pid)) {
    throw Object.assign(new Error('进程仍在运行，关闭失败'), { status: 500 });
  }
  await removeRegistration(row);
  audit('claude.plugin.close', `${sessionId} pid=${row.pid}`);
  return { ok: true, sessionId, pid: row.pid, name: row.name || '' };
}
