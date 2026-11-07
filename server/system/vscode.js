import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { IS_WINDOWS, getState, audit } from '../config.js';
import { listVSCodeWindows, focusVSCodeWindow } from './vscode-windows.js';
import { findPeerRow, isPidAlive } from '../claude/peer.js';

function findCodeExe() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft VS Code', 'Code.exe'),
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

export function bridgeInstalled() {
  try {
    const dir = path.join(os.homedir(), '.vscode', 'extensions');
    return fs.readdirSync(dir).some((name) => name.startsWith('remotedeck.bridge-'));
  } catch {
    return false;
  }
}

export function bridgeCapabilities() {
  const root = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const dirs = fs.readdirSync(root)
      .filter((name) => name.startsWith('remotedeck.bridge-'))
      .sort()
      .reverse();
    for (const name of dirs) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8'));
        const capabilities = pkg.remotedeckBridge?.capabilities || [];
        return {
          installed: true,
          version: String(pkg.version || '0.0.0'),
          capabilities,
          supportsOpenSession: capabilities.includes('openSession'),
        };
      } catch {}
    }
  } catch {}
  return { installed: false, version: '', capabilities: [], supportsOpenSession: false };
}

export function ideStatus() {
  const dir = path.join(os.homedir(), '.claude', 'ide');
  try {
    const locks = fs.readdirSync(dir).filter((name) => name.endsWith('.lock'));
    let latest = null;
    for (const name of locks) {
      try {
        const stat = fs.statSync(path.join(dir, name));
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { ...data, mtimeMs: stat.mtimeMs, lock: name };
      } catch {}
    }
    if (!latest) return { connected: false };
    return {
      connected: true,
      ideName: latest.ideName || 'VS Code',
      workspaceFolders: Array.isArray(latest.workspaceFolders) ? latest.workspaceFolders : [],
      pid: latest.pid || null,
      updatedAt: latest.mtimeMs,
    };
  } catch {
    return { connected: false };
  }
}

export function ideWorkspaces() {
  const dir = path.join(os.homedir(), '.claude', 'ide');
  const out = [];
  try {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.lock'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        for (const folder of data.workspaceFolders || []) {
          if (folder) out.push(path.resolve(folder));
        }
      } catch {}
    }
  } catch {}
  return [...new Set(out)];
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export function bridgeReady() {
  const file = path.join(os.homedir(), '.remotedeck', 'bridge-state.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - new Date(data.updatedAt || 0).getTime();
    const version = String(data.version || '0.0.0').split('.').map(Number);
    const supported = (data.capabilities || []).includes('openSession');
    return {
      ready: age >= 0 && age < 120_000 && supported && (version[0] > 0 || version[1] >= 1),
      version: data.version || '',
      updatedAt: data.updatedAt || null,
      workspaceFolders: Array.isArray(data.workspaceFolders) ? data.workspaceFolders : [],
    };
  } catch {
    return { ready: false, version: '', updatedAt: null, workspaceFolders: [] };
  }
}

function launchDetached(exe, args, { windowsHide = true } = {}) {
  return new Promise((resolve, reject) => {
    try {
      // DSH/Electron-based terminals export ELECTRON_RUN_AS_NODE=1. If Code.exe
      // inherits it, VS Code starts as a Node process and exits without ever
      // creating a window. Always strip it for GUI launches.
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide, env });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function ensureCode() {
  const code = findCodeExe();
  if (!code) throw Object.assign(new Error('找不到 VS Code（Code.exe），请确认已安装'), { status: 404 });
  return code;
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function openPath(target, { line = null } = {}) {
  if (!IS_WINDOWS) throw Object.assign(new Error('当前仅支持 Windows'), { status: 400 });
  const settings = getState().settings;
  let real;
  let stat;
  try {
    real = await fsp.realpath(path.resolve(String(target || '')));
    stat = await fsp.stat(real);
  } catch {
    throw Object.assign(new Error('路径不存在'), { status: 404 });
  }
  if (!(settings.allowedRoots || []).some((root) => within(path.resolve(root), real))) {
    throw Object.assign(new Error('该路径不在允许的工作区范围内'), { status: 403 });
  }
  const code = await ensureCode();
  const args = stat.isDirectory() ? ['-n', real] : ['-g', `${real}${line ? `:${line}` : ''}`];
  // windowsHide must stay false for a GUI app. With true, Windows can apply a
  // hidden startup show-state and VS Code appears not to launch at all.
  await launchDetached(code, args, { windowsHide: false });
  audit('vscode.open', real);
  return { ok: true, path: real, kind: stat.isDirectory() ? 'folder' : 'file' };
}

function protocolUri(pathname, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) query.set(key, String(value));
  }
  const suffix = query.toString();
  return `vscode://remotedeck.bridge/${pathname}${suffix ? `?${suffix}` : ''}`;
}

async function openUri(uri) {
  if (!IS_WINDOWS) throw Object.assign(new Error('当前仅支持 Windows'), { status: 400 });
  const code = findCodeExe();
  if (code) {
    // This is exactly what the vscode:// protocol handler runs. Calling Code.exe
    // directly also works when VS Code is not running yet, unlike relying on a
    // ShellExecute/rundll32 round-trip that can silently do nothing during a
    // cold start.
    await launchDetached(code, ['--open-url', '--', uri], { windowsHide: false });
    return;
  }
  const rundll = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'rundll32.exe');
  await launchDetached(rundll, ['url.dll,FileProtocolHandler', uri], { windowsHide: false });
}

export async function openClaudePanel(mode = 'panel') {
  if (!bridgeInstalled()) {
    throw Object.assign(new Error('尚未安装 RemoteDeck VS Code 桥接扩展。请先运行 scripts\\install-vscode-bridge.ps1'), { status: 409 });
  }
  const safeMode = mode === 'terminal' ? 'terminal' : 'panel';
  await openUri(protocolUri('claude', { mode: safeMode }));
  audit('vscode.claude.open', safeMode);
  return { ok: true, mode: safeMode };
}

export async function sendToClaude(text) {
  if (!bridgeInstalled()) {
    throw Object.assign(new Error('尚未安装 RemoteDeck VS Code 桥接扩展'), { status: 409 });
  }
  const prompt = String(text || '').trim();
  if (!prompt) throw Object.assign(new Error('指令不能为空'), { status: 400 });
  if (prompt.length > 1500) {
    throw Object.assign(new Error('通过 VS Code 桥接发送的指令不能超过 1500 字；长指令请使用 RemoteDeck 会话'), { status: 400 });
  }
  await openUri(protocolUri('prompt', { text: prompt }));
  audit('vscode.claude.prompt', prompt.slice(0, 120));
  return { ok: true };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ensure a VS Code window for cwd is open, then ask the bridge extension to
 * reopen the given Claude session in that window.
 */
export async function openSessionInVSCode(sessionId, cwd) {
  if (!/^[0-9a-f-]{20,}$/i.test(String(sessionId || ''))) {
    throw Object.assign(new Error('无效的会话 ID'), { status: 400 });
  }
  if (!bridgeInstalled()) {
    throw Object.assign(new Error('尚未安装 RemoteDeck 桥接扩展，无法在 VS Code 中恢复'), { status: 409 });
  }
  const capabilities = bridgeCapabilities();
  if (!capabilities.supportsOpenSession) {
    throw Object.assign(new Error('桥接扩展版本过旧，请运行 scripts\\install-vscode-bridge.ps1 并 Reload VS Code'), { status: 409 });
  }
  const ready = bridgeReady();
  const vscodeWindows = await listVSCodeWindows().catch(() => []);
  if (vscodeWindows.length > 0 && !ready.ready) {
    throw Object.assign(new Error('VS Code 正在运行，但桥接扩展尚未就绪；请执行一次 Developer: Reload Window'), { status: 409 });
  }

  const workdir = path.resolve(String(cwd || ''));
  const folderName = path.basename(workdir).toLowerCase();
  const matchingWindow = folderName
    ? vscodeWindows.find((window) => String(window.title || '').toLowerCase().includes(folderName))
    : null;
  const runningRow = await findPeerRow(sessionId).catch(() => null);
  const alreadyRunning = Boolean(
    runningRow
    && isPidAlive(runningRow.pid)
    && String(runningRow.entrypoint || '').toLowerCase().includes('vscode'),
  );

  let focused = false;
  if (matchingWindow) {
    try {
      await focusVSCodeWindow(matchingWindow.id);
      focused = true;
    } catch {}
  }

  let launched = false;
  if (!matchingWindow) {
    const launchedAt = Date.now();
    await openPath(workdir);
    launched = true;
    // Cold-starting VS Code can take much longer than a warm window. Wait for
    // a fresh bridge heartbeat for the new workspace before sending the URI.
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const state = bridgeReady();
      const bridgeHasFolder = (state.workspaceFolders || []).some((folder) => samePath(folder, workdir));
      const fresh = state.updatedAt && Date.parse(state.updatedAt) >= launchedAt - 2000;
      if (bridgeHasFolder && fresh) break;
    }
  }

  await openUri(protocolUri('openSession', { sessionId }));
  audit('vscode.session.open', `${sessionId} ${workdir}${launched ? ' (launched window)' : ''}${alreadyRunning ? ' (already running)' : ''}`);
  return {
    ok: true,
    sessionId,
    cwd: workdir,
    launched,
    focused,
    alreadyRunning,
    bridgeVersion: ready.version,
  };
}

export async function recentWorkspaces(extra = []) {
  const settings = getState().settings;
  const set = new Map();
  for (const item of [...(settings.workspaces || []), ...extra]) {
    if (!item) continue;
    const p = typeof item === 'string' ? item : item.cwd;
    if (!p) continue;
    if (!set.has(p)) set.set(p, { path: p, name: path.basename(p) || p });
  }
  const ide = ideStatus();
  for (const p of ide.workspaceFolders || []) {
    if (!set.has(p)) set.set(p, { path: p, name: path.basename(p) || p });
  }
  return [...set.values()].slice(0, 30);
}
