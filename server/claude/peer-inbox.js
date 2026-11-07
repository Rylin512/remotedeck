import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, IS_WINDOWS } from '../config.js';

function sessionsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
}

function claudeVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8'));
    return String(pkg.claudeCodeVersion || '2.1.318');
  } catch {
    return '2.1.318';
  }
}

function getProcessStartFileTime() {
  if (!IS_WINDOWS) return Promise.resolve('');
  return new Promise((resolve) => {
    const ps = process.env.WINDIR ? path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${process.pid}).StartTime.ToFileTime()`,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(''); }, 5000);
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.once('error', () => { clearTimeout(timer); resolve(''); });
    child.once('close', () => {
      clearTimeout(timer);
      const value = out.trim().replace(/[^\d]/g, '');
      resolve(value || '');
    });
  });
}

function parseWrapper(text) {
  const source = String(text || '');
  const match = source.match(/<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/i);
  if (!match) return { body: source.trim(), from: '', fromName: '' };
  const attrs = match[1];
  const get = (name) => {
    const m = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'));
    return m ? m[1] : '';
  };
  return {
    body: match[2].replace(/^\n+|\n+$/g, ''),
    from: get('from'),
    fromName: get('from-name'),
  };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text') return block.text || '';
      return '';
    }).join('\n');
  }
  return '';
}

/**
 * A local peer inbox that makes RemoteDeck an addressable Claude Code session.
 * It registers a normal ~/.claude/sessions/<pid>.json row + named pipe, so a
 * plugin's Claude can reply to the sender address instead of guessing another
 * local session.
 */
export class PeerInbox {
  constructor({ hub } = {}) {
    this.hub = hub;
    this.dir = sessionsDir();
    this.server = null;
    this.sessionId = crypto.randomUUID();
    this.name = 'RemoteDeck';
    this.pipePath = `\\\\.\\pipe\\LOCAL\\cc-msg-${crypto.randomBytes(16).toString('hex')}`;
    this.token = crypto.randomBytes(16).toString('hex');
    this.procStart = '';
    this.pidDomain = `win32:${os.hostname().toLowerCase()}`;
    this.startedAt = Date.now();
    this.rowPath = path.join(this.dir, `${process.pid}.json`);
    this.keyPath = null;
    this.updateTimer = null;
    this.started = false;
    this.replies = [];
  }

  identity() {
    return this.started
      ? { sessionId: this.sessionId, name: this.name, pipePath: this.pipePath }
      : null;
  }

  recentReplies() {
    return this.replies.slice(-20);
  }

  row() {
    const now = Date.now();
    return {
      pid: process.pid,
      sessionId: this.sessionId,
      cwd: ROOT,
      startedAt: this.startedAt,
      procStart: this.procStart,
      version: claudeVersion(),
      peerProtocol: 1,
      peerFeatures: [],
      kind: 'background',
      entrypoint: 'remotedeck',
      pidDomain: this.pidDomain,
      asksForConvertedSkills: null,
      messagingSocketPath: this.pipePath,
      name: this.name,
      nameSource: 'system',
      nameSince: this.startedAt,
      updatedAt: now,
      status: 'idle',
      statusUpdatedAt: now,
    };
  }

  async cleanupStale() {
    let names;
    try { names = await fsp.readdir(this.dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const row = JSON.parse(await fsp.readFile(path.join(this.dir, name), 'utf8'));
        if (row.entrypoint !== 'remotedeck' || Number(row.pid) === process.pid) continue;
        let alive = false;
        try {
          process.kill(Number(row.pid), 0);
          alive = true;
        } catch (err) {
          alive = err?.code === 'EPERM';
        }
        if (alive) continue;
        await fsp.unlink(path.join(this.dir, name)).catch(() => {});
        if (row.messagingSocketPath) {
          const digest = crypto.createHash('sha256').update(String(row.messagingSocketPath).toLowerCase()).digest('hex');
          await fsp.unlink(path.join(this.dir, `${row.pid}.${digest}.key`)).catch(() => {});
        }
      } catch {}
    }
  }

  async writeRegistration() {
    await fsp.mkdir(this.dir, { recursive: true });
    const digest = crypto.createHash('sha256').update(this.pipePath.toLowerCase()).digest('hex');
    this.keyPath = path.join(this.dir, `${process.pid}.${digest}.key`);
    await fsp.writeFile(this.keyPath, JSON.stringify({
      peerToken: this.token,
      procStartFt: this.procStart,
      pidDomain: this.pidDomain,
    }), { mode: 0o600 });
    await fsp.writeFile(this.rowPath, JSON.stringify(this.row()), { mode: 0o600 });
  }

  async refreshRegistration() {
    if (!this.started) return;
    try {
      await fsp.writeFile(this.rowPath, JSON.stringify(this.row()), { mode: 0o600 });
    } catch {}
  }

  handleFrame(frame, socket) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'user') {
      const content = frame.message?.content ?? frame.content;
      const text = contentText(content);
      const parsed = parseWrapper(text);
      const from = parsed.from || frame.from || '';
      const fromName = parsed.fromName || frame.from_name || frame.name || from;
      const body = parsed.body || text;
      if (body) {
        const reply = {
          from,
          fromName,
          body,
          msgId: frame.msg_id || frame.msgId || crypto.randomUUID(),
          receivedAt: new Date().toISOString(),
        };
        this.replies.push(reply);
        if (this.replies.length > 50) this.replies.shift();
        this.hub?.broadcast('peer_reply', reply);
      }
    }
    // A reply is fire-and-forget for the sender; the connection can close after
    // the frame is processed.
    try { socket.end(); } catch {}
  }

  handleConnection(socket) {
    let buffer = '';
    let authed = !IS_WINDOWS;
    socket.setEncoding('utf8');
    const timer = setTimeout(() => socket.destroy(), 30_000);
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (!authed) {
          if (frame.type !== 'auth' || frame.token !== this.token) {
            socket.destroy();
            return;
          }
          authed = true;
          continue;
        }
        this.handleFrame(frame, socket);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => clearTimeout(timer));
  }

  async start() {
    if (this.started) return this.identity();
    this.procStart = await getProcessStartFileTime();
    await fsp.mkdir(this.dir, { recursive: true });
    await this.cleanupStale();
    await new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once('error', reject);
      server.listen(this.pipePath, () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
    await this.writeRegistration();
    this.started = true;
    this.updateTimer = setInterval(() => this.refreshRegistration(), 30_000);
    this.updateTimer.unref?.();
    return this.identity();
  }

  async stop() {
    this.started = false;
    clearInterval(this.updateTimer);
    this.updateTimer = null;
    if (this.server) {
      await new Promise((resolve) => {
        try { this.server.close(() => resolve()); } catch { resolve(); }
        setTimeout(resolve, 1000).unref?.();
      });
      this.server = null;
    }
    for (const file of [this.rowPath, this.keyPath]) {
      if (!file) continue;
      try { await fsp.unlink(file); } catch {}
    }
  }
}
