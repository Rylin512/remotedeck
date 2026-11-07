import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const SCRIPTS_DIR = path.join(ROOT, 'scripts');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
export const DATA_DIR = process.env.RD_DATA_DIR || path.join(localAppData, 'RemoteDeck');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const BIN_DIR = path.join(DATA_DIR, 'bin');
export const LOG_DIR = path.join(DATA_DIR, 'logs');

export const PORT = Number(process.env.RD_PORT || 8787);
export const HOST = process.env.RD_HOST || '127.0.0.1';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const IS_WINDOWS = process.platform === 'win32';

export function defaultSettings() {
  return {
    host: HOST,
    port: PORT,
    permissionMode: 'default',
    model: '',
    allowedRoots: [os.homedir()],
    workspaces: [],
    autoStartTunnel: false,
    tunnelMode: 'off',
    allowBypassPermissions: false,
    officialRemoteControl: false,
    maxSessions: 3,
  };
}

export function blankState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    password: null,
    secret: null,
    settings: defaultSettings(),
    sessions: [],
    audit: [],
    tunnel: { mode: 'off', url: null, startedAt: null },
  };
}

let state = null;
let writeChain = Promise.resolve();

export async function ensureDataDirs() {
  for (const dir of [DATA_DIR, BIN_DIR, LOG_DIR]) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

export async function loadState() {
  await ensureDataDirs();
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    state = JSON.parse(raw);
    state.settings = { ...defaultSettings(), ...(state.settings || {}) };
    state.sessions = Array.isArray(state.sessions) ? state.sessions : [];
    state.audit = Array.isArray(state.audit) ? state.audit : [];
    state.tunnel = state.tunnel || { mode: 'off', url: null, startedAt: null };
    return state;
  } catch (err) {
    if (err.code === 'ENOENT') {
      state = blankState();
      return state;
    }
    throw new Error(`无法读取 ${STATE_FILE}: ${err.message}`);
  }
}

export function getState() {
  if (!state) throw new Error('state not loaded');
  return state;
}

export function isConfigured() {
  return Boolean(state?.password && state?.secret);
}

export async function saveState() {
  if (!state) throw new Error('state not loaded');
  const snapshot = JSON.stringify(state, null, 2);
  writeChain = writeChain.then(async () => {
    await ensureDataDirs();
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
    await fsp.rename(tmp, STATE_FILE);
  });
  return writeChain;
}

export function audit(action, detail = '', ip = '') {
  if (!state) return;
  state.audit.unshift({
    ts: new Date().toISOString(),
    action,
    detail: String(detail).slice(0, 500),
    ip: String(ip).slice(0, 80),
  });
  state.audit = state.audit.slice(0, 200);
  void saveState().catch(() => {});
}

export function publicSettings() {
  const s = getState().settings;
  return {
    permissionMode: s.permissionMode,
    model: s.model,
    allowedRoots: s.allowedRoots,
    workspaces: s.workspaces,
    autoStartTunnel: s.autoStartTunnel,
    tunnelMode: s.tunnelMode,
    allowBypassPermissions: s.allowBypassPermissions,
    officialRemoteControl: s.officialRemoteControl,
    maxSessions: s.maxSessions,
    port: s.port,
    host: s.host,
  };
}
