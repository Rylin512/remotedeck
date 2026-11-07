import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getState, saveState, audit, SESSION_TTL_MS } from './config.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024;

export function normalizePassword(value) {
  return typeof value === 'string' ? value.normalize('NFKC') : '';
}

export function validatePassword(password) {
  const p = normalizePassword(password);
  if (p.length < 10) return '密码至少需要 10 个字符';
  if (p.length > 200) return '密码不能超过 200 个字符';
  if (/^\s+$/.test(p)) return '密码不能全是空格';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  if (classes < 2 && p.length < 14) return '密码强度不足：至少混合两类字符，或长度达到 14 位';
  return null;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(normalizePassword(password), salt, KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, keyB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scrypt(normalizePassword(password), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function newSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const val = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function clientIp(req) {
  const socketLoopback = req.socket?.remoteAddress && isLoopbackAddress(req.socket.remoteAddress);
  if (socketLoopback) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.trim().slice(0, 80);
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim().slice(0, 80);
  }
  return String(req.socket?.remoteAddress || 'unknown');
}

export function isLoopbackAddress(address) {
  if (!address) return false;
  const a = String(address).replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

export function isLoopback(req) {
  return isLoopbackAddress(req.socket?.remoteAddress);
}

export function requestIsHttps(req) {
  if (req.socket?.encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return Boolean(host) && originHost === host;
}

export function sessionCookie(token, secure, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  const parts = [
    `rd_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  return 'rd_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

export async function createSession({ ip = '', userAgent = '' } = {}) {
  const state = getState();
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const session = {
    id: crypto.randomUUID(),
    tokenHash: hashToken(token),
    csrf,
    createdAt: now,
    lastSeen: now,
    expiresAt: now + SESSION_TTL_MS,
    ip: String(ip).slice(0, 80),
    userAgent: String(userAgent).slice(0, 240),
  };
  state.sessions = state.sessions.filter((s) => s.expiresAt > now);
  state.sessions.push(session);
  if (state.sessions.length > 20) {
    state.sessions.sort((a, b) => b.lastSeen - a.lastSeen);
    state.sessions = state.sessions.slice(0, 20);
  }
  await saveState();
  return { token, csrf, session };
}

export function findSession(token) {
  if (!token) return null;
  const state = getState();
  const hash = hashToken(token);
  const now = Date.now();
  const session = state.sessions.find((s) => s.tokenHash === hash && s.expiresAt > now);
  if (!session) return null;
  if (now - session.lastSeen > 60_000) {
    session.lastSeen = now;
    void saveState().catch(() => {});
  }
  return session;
}

export function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return findSession(cookies.rd_session);
}

export function csrfValid(req, session) {
  const header = req.headers['x-csrf-token'];
  return Boolean(header && session?.csrf && safeEqual(header, session.csrf));
}

export async function destroySession(session) {
  if (!session) return;
  const state = getState();
  state.sessions = state.sessions.filter((s) => s.id !== session.id);
  await saveState();
}

export async function destroyAllSessions() {
  const state = getState();
  state.sessions = [];
  await saveState();
}

export function pruneSessions() {
  const state = getState();
  const now = Date.now();
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.expiresAt > now);
  if (state.sessions.length !== before) void saveState().catch(() => {});
}

export class LoginLimiter {
  constructor({ maxFailures = 5, baseDelayMs = 30_000, maxDelayMs = 15 * 60_000 } = {}) {
    this.maxFailures = maxFailures;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.entries = new Map();
  }

  get(key) {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry) return { blocked: false, retryAfterMs: 0 };
    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfterMs: entry.blockedUntil - now };
    }
    if (entry.blockedUntil && entry.blockedUntil <= now) {
      entry.failures = 0;
      entry.blockedUntil = 0;
    }
    return { blocked: false, retryAfterMs: 0 };
  }

  fail(key) {
    const now = Date.now();
    const entry = this.entries.get(key) || { failures: 0, blockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      const over = entry.failures - this.maxFailures;
      const delay = Math.min(this.baseDelayMs * 2 ** over, this.maxDelayMs);
      entry.blockedUntil = now + delay;
    }
    this.entries.set(key, entry);
    this.cleanup();
  }

  success(key) {
    this.entries.delete(key);
  }

  cleanup() {
    if (this.entries.size < 1000) return;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil < now && entry.failures === 0) this.entries.delete(key);
    }
  }
}

export const loginLimiter = new LoginLimiter();

export function logAuth(action, req, detail = '') {
  audit(action, detail, clientIp(req));
}
