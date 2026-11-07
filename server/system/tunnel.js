import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { BIN_DIR, getState, saveState, audit, IS_WINDOWS } from '../config.js';

const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (IS_WINDOWS && child.pid) {
      spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
}

function parseUrl(text) {
  const match = String(text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : null;
}

function lineReader(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
    if (buffer.length > 20_000) buffer = buffer.slice(-10_000);
  });
}

export class TunnelManager {
  constructor({ port, hub }) {
    this.port = port;
    this.hub = hub;
    this.mode = 'off';
    this.status = 'stopped';
    this.url = null;
    this.error = null;
    this.child = null;
    this.stopping = false;
    this.downloading = null;
    this.startedAt = null;
    this.directServer = null;
    this.directIp = null;
    this.direct = false;
    this.serveConfigured = false;
    this.enableUrl = null;
  }

  getStatus() {
    return {
      mode: this.mode,
      status: this.status,
      url: this.url,
      https: Boolean(this.url && this.url.startsWith('https:')),
      direct: this.direct,
      directIp: this.directIp,
      enableUrl: this.enableUrl,
      error: this.error,
      startedAt: this.startedAt,
      downloading: Boolean(this.downloading),
      cloudflared: this.cloudflaredPath(),
    };
  }

  broadcast() {
    this.hub?.broadcast('tunnel', { tunnel: this.getStatus() });
  }

  setStatus(status, { url = this.url, error = null } = {}) {
    this.status = status;
    this.url = url;
    this.error = error;
    this.broadcast();
  }

  cloudflaredPath() {
    return path.join(BIN_DIR, IS_WINDOWS ? 'cloudflared.exe' : 'cloudflared');
  }

  async resolveCloudflared() {
    if (!IS_WINDOWS) {
      return { path: 'cloudflared', argsPrefix: [] };
    }
    const exe = this.cloudflaredPath();
    try {
      const stat = await fsp.stat(exe);
      if (stat.size > 1_000_000) return { path: exe, argsPrefix: [] };
    } catch {}
    return { path: exe, argsPrefix: [], needsDownload: true };
  }

  async ensureCloudflared() {
    if (!IS_WINDOWS) return 'cloudflared';
    const exe = this.cloudflaredPath();
    try {
      const stat = await fsp.stat(exe);
      if (stat.size > 1_000_000) return exe;
    } catch {}
    if (this.downloading) return this.downloading;
    this.downloading = (async () => {
      this.setStatus('downloading', { url: null });
      await fsp.mkdir(BIN_DIR, { recursive: true });
      const response = await fetch(CLOUDFLARED_URL, {
        redirect: 'follow',
        signal: AbortSignal.timeout(180_000),
        headers: { 'User-Agent': 'RemoteDeck/0.1' },
      });
      if (!response.ok) throw new Error(`下载 cloudflared 失败：HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1_000_000 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
        throw new Error('下载的 cloudflared 文件无效');
      }
      const tmp = `${exe}.tmp`;
      await fsp.writeFile(tmp, buffer, { mode: 0o755 });
      await fsp.rename(tmp, exe);
      this.setStatus('starting');
      return exe;
    })().finally(() => { this.downloading = null; });
    return this.downloading;
  }

  findTailscale() {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Tailscale', 'tailscale.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tailscale', 'tailscale.exe'),
    ];
    for (const candidate of candidates) {
      try { if (fs.existsSync(candidate)) return candidate; } catch {}
    }
    return null;
  }

  run(exe, args, timeoutMs = 20_000) {
    return new Promise((resolve) => {
      const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        killTree(child);
        resolve({ code: -1, stdout, stderr: `${stderr}\n超时` });
      }, timeoutMs);
      child.stdout.on('data', (b) => { stdout += b.toString(); });
      child.stderr.on('data', (b) => { stderr += b.toString(); });
      child.once('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
      child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  async start(mode) {
    const wanted = mode === 'tailscale' ? 'tailscale' : mode === 'cloudflare' ? 'cloudflare' : 'off';
    await this.stop({ silent: true });
    if (wanted === 'off') {
      this.setStatus('stopped', { url: null });
      return this.getStatus();
    }
    this.mode = wanted;
    this.startedAt = Date.now();
    this.error = null;
    if (wanted === 'cloudflare') return this.startCloudflare();
    return this.startTailscale();
  }

  async startCloudflare() {
    this.setStatus('starting', { url: null });
    let exe;
    try {
      exe = await this.ensureCloudflared();
    } catch (err) {
      this.setStatus('error', { url: null, error: err.message });
      throw Object.assign(new Error(err.message), { status: 500 });
    }
    const args = ['tunnel', '--url', `http://127.0.0.1:${this.port}`, '--no-autoupdate', '--protocol', 'http2'];
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.stopping = false;
    let settled = false;
    let output = '';
    const urlPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('等待 Cloudflare 隧道地址超时（60 秒）'));
      }, 60_000);
      const onLine = (line) => {
        output = `${output}\n${line}`.slice(-5000);
        const url = parseUrl(line);
        if (url && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(url);
        }
      };
      lineReader(child.stdout, onLine);
      lineReader(child.stderr, onLine);
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`cloudflared 退出（${code}）：${output.slice(-800)}`));
        }
        if (this.stopping) {
          this.status = 'stopped';
        } else {
          this.status = 'error';
          this.error = `cloudflared 已退出（${code}）`;
          this.url = null;
        }
        this.child = null;
        this.broadcast();
      });
    });

    try {
      const url = await urlPromise;
      this.url = url;
      this.startedAt = Date.now();
      this.setStatus('running', { url });
      const state = getState();
      state.tunnel = { mode: 'cloudflare', url, startedAt: this.startedAt };
      state.settings.tunnelMode = 'cloudflare';
      await saveState();
      audit('tunnel.start', `cloudflare ${url}`);
      return this.getStatus();
    } catch (err) {
      killTree(child);
      this.child = null;
      this.setStatus('error', { url: null, error: err.message });
      throw Object.assign(new Error(err.message), { status: 500 });
    }
  }

  async startDirect(tailscaleIp) {
    if (!tailscaleIp) throw new Error('没有可用的 Tailscale IPv4 地址');
    await this.stopDirect();
    const server = net.createServer((socket) => {
      const upstream = net.connect({ port: this.port, host: '127.0.0.1' });
      const close = () => {
        try { socket.destroy(); } catch {}
        try { upstream.destroy(); } catch {}
      };
      socket.on('error', close);
      upstream.on('error', close);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, tailscaleIp);
    });
    this.directServer = server;
    this.directIp = tailscaleIp;
    this.direct = true;
    return `http://${tailscaleIp}:${this.port}/`;
  }

  async stopDirect() {
    if (!this.directServer) return;
    const server = this.directServer;
    this.directServer = null;
    this.directIp = null;
    this.direct = false;
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
      setTimeout(resolve, 1500).unref?.();
    });
  }

  async startTailscale() {
    const exe = this.findTailscale();
    if (!exe) {
      this.setStatus('error', { url: null, error: '未安装 Tailscale' });
      throw Object.assign(new Error('未找到 Tailscale。请先在电脑和手机上安装并登录 Tailscale。'), { status: 404 });
    }
    this.setStatus('starting', { url: null });
    this.enableUrl = null;

    const status = await this.run(exe, ['status', '--json'], 12_000);
    let json = null;
    try { json = JSON.parse(status.stdout); } catch {}
    if (status.code !== 0 || !json) {
      const msg = (status.stderr || status.stdout || '无法读取 Tailscale 状态').trim();
      this.setStatus('error', { url: null, error: msg });
      throw Object.assign(new Error(`Tailscale 未运行或无法读取状态：${msg}`), { status: 500 });
    }
    if (json.BackendState && json.BackendState !== 'Running') {
      const msg = `Tailscale 状态是 ${json.BackendState}，请先登录并连接`;
      this.setStatus('error', { url: null, error: msg });
      throw Object.assign(new Error(msg), { status: 409 });
    }
    const dns = String(json.Self?.DNSName || '').replace(/\.$/, '');
    const tailscaleIp = (json.Self?.TailscaleIPs || []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(String(ip))) || null;

    // --yes is essential: without it, `tailscale serve` waits for an
    // interactive prompt and the HTTP request appears to time out.
    const serve = await this.run(exe, [
      'serve', '--bg', '--yes', '--https=443', `http://127.0.0.1:${this.port}`,
    ], 8_000);
    const output = `${serve.stdout}\n${serve.stderr}`.trim();
    const enableMatch = output.match(/https:\/\/login\.tailscale\.com\/f\/serve[^\s]*/i);
    if (enableMatch) this.enableUrl = enableMatch[0];

    if (serve.code === 0 && !/Serve is not enabled/i.test(output)) {
      this.direct = false;
      this.serveConfigured = true;
      this.url = dns ? `https://${dns}/` : null;
      this.startedAt = Date.now();
      this.setStatus('running', { url: this.url });
      const state = getState();
      state.tunnel = { mode: 'tailscale', url: this.url, startedAt: this.startedAt, direct: false };
      state.settings.tunnelMode = 'tailscale';
      await saveState();
      audit('tunnel.start', `tailscale serve ${this.url || ''}`);
      return this.getStatus();
    }

    // Tailscale Serve is a tailnet-level opt-in. If it is not enabled, fall
    // back to a private HTTP listener bound only to the Tailscale IP. This is
    // reachable from the phone over the encrypted tailnet without exposing
    // the LAN, and avoids a misleading 20s timeout.
    if (tailscaleIp) {
      try {
        const url = await this.startDirect(tailscaleIp);
        this.serveConfigured = false;
        this.url = url;
        this.startedAt = Date.now();
        this.setStatus('running', { url });
        const state = getState();
        state.tunnel = { mode: 'tailscale', url, startedAt: this.startedAt, direct: true };
        state.settings.tunnelMode = 'tailscale';
        await saveState();
        audit('tunnel.start', `tailscale direct ${url}`);
        return this.getStatus();
      } catch (directErr) {
        // Fall through to the actionable Serve error below.
        this.error = directErr.message;
      }
    }

    const hint = this.enableUrl
      ? `Tailscale Serve 尚未在 tailnet 启用。请在电脑浏览器打开 ${this.enableUrl} 启用一次，或继续使用 Tailscale 直连。`
      : (output || 'tailscale serve 启动超时/失败');
    this.setStatus('error', { url: null, error: hint });
    throw Object.assign(new Error(hint), { status: 409 });
  }

  async stop({ silent = false } = {}) {
    this.stopping = true;
    if (this.child) {
      killTree(this.child);
      this.child = null;
    }
    await this.stopDirect();
    if (this.mode === 'tailscale' && this.serveConfigured) {
      const exe = this.findTailscale();
      if (exe) await this.run(exe, ['serve', '--https=443', 'off'], 10_000);
    }
    this.serveConfigured = false;
    this.enableUrl = null;
    this.mode = 'off';
    this.status = 'stopped';
    this.url = null;
    this.startedAt = null;
    this.error = null;
    if (!silent) {
      const state = getState();
      state.tunnel = { mode: 'off', url: null, startedAt: null, direct: false };
      await saveState();
      this.broadcast();
      audit('tunnel.stop');
    }
    return this.getStatus();
  }

  async autoStart() {
    const state = getState();
    if (!state.settings.autoStartTunnel) return;
    const mode = state.settings.tunnelMode;
    if (mode !== 'cloudflare' && mode !== 'tailscale') return;
    setTimeout(() => {
      this.start(mode).catch((err) => {
        this.setStatus('error', { url: null, error: err.message });
      });
    }, 2500).unref?.();
  }
}
