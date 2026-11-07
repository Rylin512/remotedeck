import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';

export const MIN_PEER_VERSION = [2, 1, 234];
export const PHONE_FROM = 'remotedeck-phone';
export const PHONE_NAME = 'RemoteDeck 手机';

export function sessionsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
}

function versionTuple(value) {
  const parts = String(value || '').split('.').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part))) return [];
  return parts;
}

function versionAtLeast(value, minimum) {
  const a = versionTuple(value);
  const b = minimum;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av !== bv) return av > bv;
  }
  return true;
}

export async function readPeerRows(dir = sessionsDir()) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const row = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      if (row && typeof row === 'object' && typeof row.sessionId === 'string') rows.push(row);
    } catch {}
  }
  return rows;
}

export async function findPeerRow(sessionId, dir = sessionsDir()) {
  const rows = await readPeerRows(dir);
  return rows.find((row) => row.sessionId === sessionId) || null;
}

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function isPidAlive(pid) {
  return pidAlive(pid);
}

function keyPathFor(row, dir) {
  const digest = crypto.createHash('sha256')
    .update(String(row.messagingSocketPath).toLowerCase())
    .digest('hex');
  return path.join(dir, `${row.pid}.${digest}.key`);
}

export async function readPeerToken(row, dir = sessionsDir()) {
  if (!row?.messagingSocketPath) return null;
  const primary = keyPathFor(row, dir);
  try {
    const data = JSON.parse(await fsp.readFile(primary, 'utf8'));
    if (data?.peerToken) return String(data.peerToken);
  } catch {}
  // Be tolerant of older builds that did not lowercase the socket path before hashing.
  try {
    const names = await fsp.readdir(dir);
    const prefix = `${row.pid}.`;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.key')) continue;
      try {
        const data = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
        if (data?.peerToken) return String(data.peerToken);
      } catch {}
    }
  } catch {}
  return null;
}

export async function peerStatus(sessionId, dir = sessionsDir()) {
  const row = await findPeerRow(sessionId, dir);
  if (!row) return { live: false, canSend: false, reason: 'no_registry_row' };
  if (!row.messagingSocketPath) return { live: false, canSend: false, reason: 'no_socket' };
  if (row.peerProtocol !== 1) return { live: false, canSend: false, reason: 'peer_protocol' };
  if (!versionAtLeast(row.version, MIN_PEER_VERSION)) return { live: false, canSend: false, reason: 'version_too_old' };
  if (!pidAlive(row.pid)) return { live: false, canSend: false, reason: 'process_exited' };
  const token = await readPeerToken(row, dir);
  return {
    live: true,
    canSend: Boolean(token),
    reason: token ? '' : 'missing_peer_token',
    name: row.name || '',
    status: row.status || '',
    pid: row.pid,
  };
}

export function wrapCrossSession(body, { from = PHONE_FROM, fromName = PHONE_NAME, fromMode = 'prompting' } = {}) {
  const attrs = [];
  if (from) attrs.push(`from="${String(from).replace(/["<>]/g, '')}"`);
  if (fromName) attrs.push(`from-name="${String(fromName).replace(/["<>]/g, '')}"`);
  if (fromMode) attrs.push(`from-mode="${String(fromMode).replace(/["<>]/g, '')}"`);
  const open = `<cross-session-message${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  const safe = String(body || '').replaceAll('</cross-session-message>', '&lt;/cross-session-message&gt;');
  return `${open}\n${safe}\n</cross-session-message>`;
}

export function stripCrossSession(text) {
  const source = String(text || '');
  const match = source.match(/<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>/i);
  if (!match) return source;
  return match[1].replace(/^\n+|\n+$/g, '');
}

function sendFrame(socketPath, lines, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      if (err) reject(err);
      else resolve();
    };
    const socket = net.connect(socketPath);
    socket.setNoDelay?.(true);
    const timer = setTimeout(() => done(new Error('连接会话消息管道超时')), timeoutMs);
    socket.once('connect', () => {
      try {
        for (const line of lines) socket.write(line);
        // Give the receiver a moment to read the frames before half-closing.
        setTimeout(() => {
          try { socket.end(); } catch {}
          clearTimeout(timer);
          done();
        }, 300);
      } catch (err) {
        clearTimeout(timer);
        done(err);
      }
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      done(new Error(`无法连接会话消息管道：${err.code || err.message}`));
    });
  });
}

/**
 * Deliver a message into an already-running local Claude session using
 * Claude Code's cross-session inbox socket.
 *
 * mode:
 *   nudge     -> priority "next": read at the next tool boundary / next turn
 *   later     -> priority "later": queued after current work
 *   interrupt -> priority "now": interrupts the current turn and delivers
 */
export async function sendPeerMessage(sessionId, {
  text,
  mode = 'nudge',
  dir = sessionsDir(),
  from = PHONE_FROM,
  fromName = PHONE_NAME,
} = {}) {
  const body = String(text || '').trim();
  if (!body) throw Object.assign(new Error('消息不能为空'), { status: 400 });
  if (body.length > 20_000) throw Object.assign(new Error('消息不能超过 20000 字'), { status: 400 });

  const row = await findPeerRow(sessionId, dir);
  if (!row) {
    throw Object.assign(new Error('这个会话没有正在运行的 Claude 进程，无法直接发送。请使用“继续对话”恢复它。'), { status: 409 });
  }
  if (row.peerProtocol !== 1 || !versionAtLeast(row.version, MIN_PEER_VERSION)) {
    throw Object.assign(new Error('当前 Claude Code 版本不支持跨会话消息，请升级到 2.1.234 或更高版本'), { status: 409 });
  }
  if (!row.messagingSocketPath) {
    throw Object.assign(new Error('该会话没有启用跨会话消息通道'), { status: 409 });
  }
  if (!pidAlive(row.pid)) {
    throw Object.assign(new Error('该会话的 Claude 进程已经退出，请使用“继续对话”恢复它'), { status: 409 });
  }
  const token = await readPeerToken(row, dir);
  if (!token) {
    throw Object.assign(new Error('找不到该会话的消息认证密钥，无法发送'), { status: 409 });
  }

  const priority = mode === 'interrupt' ? 'now' : mode === 'later' ? 'later' : 'next';
  const msgId = crypto.randomUUID();
  const framedBody = mode === 'interrupt'
    ? `【用户从手机打断】请停止当前正在进行的任务，优先处理下面这条新指令：\n${body}`
    : body;
  const content = wrapCrossSession(framedBody, { from, fromName });
  const lines = [
    `${JSON.stringify({ type: 'auth', token })}\n`,
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      msg_id: msgId,
      priority,
      ...(from ? { from } : {}),
    })}\n`,
  ];
  try {
    await sendFrame(row.messagingSocketPath, lines);
  } catch (err) {
    throw Object.assign(new Error(err.message), { status: 409 });
  }
  return {
    ok: true,
    sessionId,
    msgId,
    priority,
    mode,
    from,
    fromName,
    delivered: priority === 'next' && row.status === 'idle' ? 'started_turn' : 'queued',
  };
}
