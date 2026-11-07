import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

import {
  PUBLIC_DIR, VERSION, PORT, HOST,
  loadState, getState, saveState, isConfigured, publicSettings, audit,
} from './config.js';
import {
  hashPassword, verifyPassword, validatePassword, newSecret, createSession,
  getSessionFromRequest, csrfValid, destroySession, destroyAllSessions,
  sessionCookie, clearSessionCookie, clientIp, isLoopback, originAllowed,
  requestIsHttps, loginLimiter, pruneSessions,
} from './auth.js';
import { EventHub } from './events.js';
import { ClaudeManager, isClaudeInstalled, validateWorkspace } from './claude/manager.js';
import { PluginWatcher } from './claude/plugin-watcher.js';
import { PeerInbox } from './claude/peer-inbox.js';
import { sendPeerMessage } from './claude/peer.js';
import { closePluginSession } from './claude/plugin-close.js';
import { officialStatus, setOfficialRemoteControl } from './claude/official.js';
import { TunnelManager } from './system/tunnel.js';
import { systemInfo } from './system/metrics.js';
import {
  bridgeInstalled, bridgeReady, ideStatus, openPath, openClaudePanel, sendToClaude, recentWorkspaces,
  openSessionInVSCode,
} from './system/vscode.js';
import { listVSCodeWindows, closeVSCodeWindow } from './system/vscode-windows.js';
import { performPowerAction, actionRequirements, validatePowerRequest } from './system/power.js';
import { setEnabled as setAutostart, status as autostartStatus } from './system/autostart.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (requestIsHttps(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

function fail(res, status, message, code = '') {
  json(res, status, { error: code || http.STATUS_CODES[status] || 'ERROR', message });
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 1_000_000) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求体不是有效 JSON'), { status: 400 });
  }
}

function requireAuth(req, res, { csrf = true } = {}) {
  const session = getSessionFromRequest(req);
  if (!session) {
    fail(res, 401, '请先登录', 'UNAUTHORIZED');
    return null;
  }
  if (!originAllowed(req)) {
    fail(res, 403, '请求来源不匹配', 'BAD_ORIGIN');
    return null;
  }
  if (csrf && !csrfValid(req, session)) {
    fail(res, 403, 'CSRF 校验失败，请刷新页面后重试', 'BAD_CSRF');
    return null;
  }
  return session;
}

function parseLimit(value, fallback, max = 500) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

async function buildState(session, manager, tunnel, watcher, inbox) {
  const state = getState();
  const historyRaw = await manager.listHistory({ limit: 30 });
  const history = Array.isArray(historyRaw) ? historyRaw : (historyRaw.sessions || []);
  const historyError = Array.isArray(historyRaw) ? null : historyRaw.error || null;
  const recent = await recentWorkspaces(history.map((item) => item.cwd));
  let system = null;
  try { system = await systemInfo(); } catch {}
  return {
    authenticated: true,
    setupRequired: false,
    version: VERSION,
    csrf: session.csrf,
    serverTime: new Date().toISOString(),
    system,
    settings: publicSettings(),
    claude: {
      sessions: manager.list(),
      history,
      historyError,
      sdk: isClaudeInstalled(),
      official: officialStatus(),
    },
    plugin: {
      sessions: watcher ? watcher.list() : [],
    },
    peer: inbox?.identity()
      ? { ...inbox.identity(), replies: inbox.recentReplies() }
      : null,
    vscode: {
      bridgeInstalled: bridgeInstalled(),
      bridgeReady: bridgeReady(),
      ide: ideStatus(),
      recents: recent,
    },
    power: {
      autostart: autostartStatus(),
      actions: ['shutdown', 'restart', 'lock', 'sleep', 'cancel'],
      requirements: Object.fromEntries(['shutdown', 'restart', 'lock', 'sleep', 'cancel'].map((a) => [a, actionRequirements(a)])),
    },
    tunnel: tunnel.getStatus(),
    audit: state.audit.slice(0, 30),
    security: {
      sessionCount: state.sessions.length,
      serverVersion: VERSION,
      hostname: os.hostname(),
    },
  };
}

export function createApp({ manager, tunnel, hub, watcher, inbox }) {
  return http.createServer(async (req, res) => {
    securityHeaders(req, res);
    const started = Date.now();
    try {
      const host = req.headers.host || '127.0.0.1';
      const url = new URL(req.url || '/', `http://${host}`);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname, url, manager, tunnel, hub, watcher, inbox);
      } else {
        await serveStatic(req, res, pathname);
      }
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status >= 500) console.error('[http]', err?.stack || err);
      if (!res.headersSent) {
        fail(res, status, err?.message || '服务器内部错误');
      } else {
        try { res.end(); } catch {}
      }
    } finally {
      if (process.env.RD_HTTP_LOG === '1') {
        console.log(`[http] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });
}

async function handleApi(req, res, pathname, url, manager, tunnel, hub, watcher, inbox) {
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      setupRequired: !isConfigured(),
      uptime: Math.round(process.uptime()),
    });
  }

  if (method === 'POST' && pathname === '/api/setup') {
    if (isConfigured()) return fail(res, 409, '已经完成初始化', 'ALREADY_CONFIGURED');
    if (!isLoopback(req) || req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) {
      return fail(res, 403, '首次初始化只能在电脑本机进行', 'LOCAL_ONLY');
    }
    if (!originAllowed(req)) return fail(res, 403, '请求来源不匹配', 'BAD_ORIGIN');
    const body = await readJson(req);
    const password = typeof body.password === 'string' ? body.password : '';
    const confirm = typeof body.confirm === 'string' ? body.confirm : '';
    const error = validatePassword(password);
    if (error) return fail(res, 400, error, 'WEAK_PASSWORD');
    if (password !== confirm) return fail(res, 400, '两次输入的密码不一致', 'PASSWORD_MISMATCH');
    const state = getState();
    state.password = await hashPassword(password);
    state.secret = newSecret();
    state.createdAt = new Date().toISOString();
    await saveState();
    const { token, csrf } = await createSession({ ip: clientIp(req), userAgent: req.headers['user-agent'] || '' });
    audit('auth.setup', '', clientIp(req));
    return json(res, 200, { ok: true, csrf }, {
      'Set-Cookie': sessionCookie(token, requestIsHttps(req)),
    });
  }

  if (method === 'POST' && pathname === '/api/login') {
    if (!isConfigured()) return fail(res, 409, '尚未初始化，请先在电脑本机设置密码', 'SETUP_REQUIRED');
    if (!originAllowed(req)) return fail(res, 403, '请求来源不匹配', 'BAD_ORIGIN');
    const ip = clientIp(req);
    const limit = loginLimiter.get(ip);
    if (limit.blocked) {
      return fail(res, 429, `尝试次数过多，请 ${Math.ceil(limit.retryAfterMs / 1000)} 秒后重试`, 'RATE_LIMITED');
    }
    const body = await readJson(req);
    const password = typeof body.password === 'string' ? body.password : '';
    const state = getState();
    const ok = password && await verifyPassword(password, state.password);
    if (!ok) {
      loginLimiter.fail(ip);
      audit('auth.login.failed', '', ip);
      return fail(res, 401, '密码错误', 'BAD_PASSWORD');
    }
    loginLimiter.success(ip);
    const { token, csrf } = await createSession({ ip, userAgent: req.headers['user-agent'] || '' });
    audit('auth.login', '', ip);
    return json(res, 200, { ok: true, csrf }, {
      'Set-Cookie': sessionCookie(token, requestIsHttps(req)),
    });
  }

  if (method === 'POST' && pathname === '/api/logout') {
    const session = requireAuth(req, res);
    if (!session) return;
    await destroySession(session);
    audit('auth.logout', '', clientIp(req));
    return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  if (method === 'GET' && pathname === '/api/state') {
    if (!isConfigured()) {
      if (!isLoopback(req) || req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) {
        return fail(res, 403, '首次初始化只能在电脑本机进行', 'LOCAL_ONLY');
      }
      return json(res, 200, {
        authenticated: false,
        setupRequired: true,
        version: VERSION,
        localOnly: true,
      });
    }
    const session = requireAuth(req, res, { csrf: false });
    if (!session) return;
    const state = await buildState(session, manager, tunnel, watcher, inbox);
    return json(res, 200, state);
  }

  if (method === 'GET' && pathname === '/api/events') {
    const session = requireAuth(req, res, { csrf: false });
    if (!session) return;
    hub.add(req, res);
    return;
  }

  // Everything below requires an authenticated session and CSRF for mutations.
  const isMutation = method !== 'GET' && method !== 'HEAD';
  const session = requireAuth(req, res, { csrf: isMutation });
  if (!session) return;

  if (method === 'POST' && pathname === '/api/password') {
    const body = await readJson(req);
    const state = getState();
    if (!await verifyPassword(String(body.current || ''), state.password)) {
      return fail(res, 401, '当前密码不正确', 'BAD_PASSWORD');
    }
    const error = validatePassword(String(body.newPassword || ''));
    if (error) return fail(res, 400, error, 'WEAK_PASSWORD');
    if (body.newPassword !== body.confirm) return fail(res, 400, '两次输入的新密码不一致', 'PASSWORD_MISMATCH');
    state.password = await hashPassword(String(body.newPassword));
    state.sessions = [];
    await saveState();
    const created = await createSession({ ip: clientIp(req), userAgent: req.headers['user-agent'] || '' });
    audit('auth.password', '密码已修改，所有设备已退出', clientIp(req));
    return json(res, 200, { ok: true, csrf: created.csrf }, {
      'Set-Cookie': sessionCookie(created.token, requestIsHttps(req)),
    });
  }

  if (method === 'GET' && pathname === '/api/claude/sessions') {
    return json(res, 200, { sessions: manager.list() });
  }

  if (method === 'POST' && pathname === '/api/claude/sessions') {
    const body = await readJson(req);
    const created = await manager.create({
      cwd: body.cwd,
      permissionMode: body.permissionMode,
      model: typeof body.model === 'string' ? body.model.slice(0, 100) : undefined,
      resume: typeof body.resume === 'string' ? body.resume : undefined,
      forkSession: body.forkSession !== false,
      title: typeof body.title === 'string' ? body.title.slice(0, 80) : undefined,
    });
    manager.invalidateHistory();
    return json(res, 201, { session: created });
  }

  const sessionMatch = pathname.match(/^\/api\/claude\/sessions\/([0-9a-f-]+)(?:\/(prompt|interrupt|stop|permission|mode))?$/i);
  if (sessionMatch) {
    const [, id, action] = sessionMatch;
    if (method === 'GET' && !action) {
      const found = manager.get(id);
      if (!found) return fail(res, 404, '会话不存在', 'NOT_FOUND');
      return json(res, 200, { session: manager.snapshot(found, { includeMessages: true }) });
    }
    if (method === 'POST' && action === 'prompt') {
      const body = await readJson(req);
      const result = await manager.prompt(id, body.text);
      return json(res, 200, result);
    }
    if (method === 'POST' && action === 'interrupt') {
      return json(res, 200, await manager.interrupt(id));
    }
    if ((method === 'POST' || method === 'DELETE') && action === 'stop') {
      return json(res, 200, await manager.stop(id));
    }
    if (method === 'POST' && action === 'permission') {
      const body = await readJson(req);
      return json(res, 200, manager.resolvePermission(id, String(body.requestId || ''), body.decision, {
        always: Boolean(body.always),
      }));
    }
    if (method === 'POST' && action === 'mode') {
      const body = await readJson(req);
      return json(res, 200, await manager.setPermissionMode(id, String(body.mode || '')));
    }
  }

  if (method === 'GET' && pathname === '/api/claude/plugin/sessions') {
    return json(res, 200, { sessions: watcher ? watcher.list() : [] });
  }
  const pluginMatch = pathname.match(/^\/api\/claude\/plugin\/sessions\/([0-9a-f-]+)$/i);
  if (method === 'GET' && pluginMatch) {
    if (!watcher) return fail(res, 503, '插件监视器未启动', 'NOT_AVAILABLE');
    const data = await watcher.getSession(pluginMatch[1]);
    return json(res, 200, data);
  }
  const pluginMessageMatch = pathname.match(/^\/api\/claude\/plugin\/sessions\/([0-9a-f-]+)\/message$/i);
  if (method === 'POST' && pluginMessageMatch) {
    const body = await readJson(req);
    const mode = ['interrupt', 'nudge', 'later'].includes(body.mode) ? body.mode : 'nudge';
    const identity = inbox?.identity();
    const sent = await sendPeerMessage(pluginMessageMatch[1], {
      text: body.text,
      mode,
      from: identity?.sessionId,
      fromName: identity?.name,
    });
    watcher?.noteOutgoing(pluginMessageMatch[1], {
      msgId: sent.msgId,
      text: String(body.text || '').trim(),
      mode,
      peerName: sent.fromName,
    });
    audit('claude.plugin.message', `${pluginMessageMatch[1]} ${mode} ${String(body.text || '').slice(0, 120)}`);
    return json(res, 200, { ok: true, message: sent });
  }
  const pluginCloseMatch = pathname.match(/^\/api\/claude\/plugin\/sessions\/([0-9a-f-]+)\/close$/i);
  if (method === 'POST' && pluginCloseMatch) {
    const body = await readJson(req);
    const result = await closePluginSession(pluginCloseMatch[1], { confirm: body.confirm });
    watcher?.markClosed(pluginCloseMatch[1]);
    hub.broadcast('plugin_closed', { sessionId: pluginCloseMatch[1] });
    return json(res, 200, { ok: true, result });
  }

  if (method === 'GET' && pathname === '/api/claude/history') {
    const cwd = url.searchParams.get('cwd') || undefined;
    const all = url.searchParams.get('all') === '1';
    if (all && url.searchParams.get('refresh') === '1') manager.invalidateHistory();
    const history = all
      ? await manager.listAllHistory()
      : await manager.listHistory({ limit: parseLimit(url.searchParams.get('limit'), 30, 100), cwd });
    if (Array.isArray(history)) return json(res, 200, { sessions: history, error: null });
    return json(res, 200, { sessions: history.sessions || [], error: history.error || null });
  }

  const historyMatch = pathname.match(/^\/api\/claude\/history\/([0-9a-f-]+)(?:\/(resume))?$/i);
  if (historyMatch) {
    const [, id, action] = historyMatch;
    if (method === 'GET' && !action) {
      const cwd = url.searchParams.get('cwd') || undefined;
      const data = await manager.getHistory(id, { cwd, limit: parseLimit(url.searchParams.get('limit'), 300, 500) });
      return json(res, 200, data);
    }
    if (method === 'POST' && action === 'resume') {
      const body = await readJson(req);
      const created = await manager.resumeHistory(id, {
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        title: typeof body.title === 'string' ? body.title.slice(0, 80) : undefined,
        forkSession: Boolean(body.forkSession),
      });
      manager.invalidateHistory();
      return json(res, 201, { session: created, forked: Boolean(body.forkSession) });
    }
  }

  if (method === 'GET' && pathname === '/api/claude/official') {
    return json(res, 200, officialStatus());
  }
  if (method === 'POST' && pathname === '/api/claude/official') {
    const body = await readJson(req);
    const status = await setOfficialRemoteControl(Boolean(body.enabled));
    const state = getState();
    state.settings.officialRemoteControl = Boolean(body.enabled);
    await saveState();
    audit('claude.official', body.enabled ? 'enabled' : 'disabled');
    hub.broadcast('settings', { official: status });
    return json(res, 200, status);
  }

  if (method === 'GET' && pathname === '/api/vscode') {
    const history = await manager.listHistory({ limit: 30 });
    const list = Array.isArray(history) ? history : (history.sessions || []);
    return json(res, 200, {
      bridgeInstalled: bridgeInstalled(),
      bridgeReady: bridgeReady(),
      ide: ideStatus(),
      recents: await recentWorkspaces(list.map((item) => item.cwd)),
    });
  }
  if (method === 'POST' && pathname === '/api/vscode/open-session') {
    const body = await readJson(req);
    if (typeof body.sessionId !== 'string' || typeof body.cwd !== 'string') {
      return fail(res, 400, '缺少会话 ID 或工作目录');
    }
    const result = await openSessionInVSCode(body.sessionId, body.cwd);
    return json(res, 200, result);
  }
  if (method === 'GET' && pathname === '/api/vscode/windows') {
    return json(res, 200, { windows: await listVSCodeWindows() });
  }
  const vscodeWindowMatch = pathname.match(/^\/api\/vscode\/windows\/(\d{1,20})\/close$/);
  if (method === 'POST' && vscodeWindowMatch) {
    const body = await readJson(req);
    if (body.confirm !== '关闭') return fail(res, 400, '请输入“关闭”以确认');
    const result = await closeVSCodeWindow(vscodeWindowMatch[1]);
    return json(res, 200, { ok: true, result });
  }
  if (method === 'POST' && pathname === '/api/vscode/open') {
    const body = await readJson(req);
    return json(res, 200, await openPath(String(body.path || ''), { line: body.line ? Number(body.line) : null }));
  }
  if (method === 'POST' && pathname === '/api/vscode/claude') {
    const body = await readJson(req);
    return json(res, 200, await openClaudePanel(body.mode === 'terminal' ? 'terminal' : 'panel'));
  }
  if (method === 'POST' && pathname === '/api/vscode/prompt') {
    const body = await readJson(req);
    return json(res, 200, await sendToClaude(body.text));
  }

  if (method === 'GET' && pathname === '/api/power') {
    return json(res, 200, {
      autostart: autostartStatus(),
      requirements: Object.fromEntries(['shutdown', 'restart', 'lock', 'sleep', 'cancel'].map((a) => [a, actionRequirements(a)])),
    });
  }
  if (method === 'POST' && pathname === '/api/power') {
    const body = await readJson(req);
    const request = validatePowerRequest({
      action: body.action,
      confirm: body.confirm,
      delaySeconds: body.delaySeconds,
    });
    const payload = {
      ok: true,
      action: request.action,
      delaySeconds: request.delaySeconds,
      scheduledAt: new Date(Date.now() + 1500).toISOString(),
    };
    hub.broadcast('power', payload);
    audit('power.request', `${request.action} in ${request.delaySeconds}s`, clientIp(req));
    setTimeout(() => {
      performPowerAction(request).catch((err) => {
        console.error('[power]', err.message);
        audit('power.error', err.message);
        hub.broadcast('power_error', { action: request.action, message: err.message });
      });
    }, 1500).unref?.();
    return json(res, 200, payload);
  }
  if (method === 'POST' && pathname === '/api/autostart') {
    const body = await readJson(req);
    const result = await setAutostart(Boolean(body.enabled));
    return json(res, 200, result);
  }

  if (method === 'GET' && pathname === '/api/tunnel') {
    return json(res, 200, { tunnel: tunnel.getStatus(), preferred: getState().settings.tunnelMode });
  }
  if (method === 'POST' && pathname === '/api/tunnel/start') {
    if (!isConfigured()) return fail(res, 409, '请先完成初始化', 'SETUP_REQUIRED');
    const body = await readJson(req);
    const status = await tunnel.start(String(body.mode || 'cloudflare'));
    return json(res, 200, { tunnel: status });
  }
  if (method === 'POST' && pathname === '/api/tunnel/stop') {
    return json(res, 200, { tunnel: await tunnel.stop() });
  }
  if (method === 'GET' && pathname === '/api/tunnel/qr') {
    const status = tunnel.getStatus();
    if (!status.url) return fail(res, 404, '隧道尚未启动', 'NO_TUNNEL');
    const dataUrl = await QRCode.toDataURL(status.url, {
      width: 360,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#071018', light: '#ffffff' },
    });
    return json(res, 200, { url: status.url, dataUrl });
  }

  if (method === 'GET' && pathname === '/api/settings') {
    return json(res, 200, { settings: publicSettings(), sdk: isClaudeInstalled() });
  }
  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJson(req);
    const state = getState();
    const s = state.settings;
    if (body.permissionMode !== undefined) {
      const modes = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions']);
      if (!modes.has(body.permissionMode)) return fail(res, 400, '无效的默认权限模式', 'BAD_MODE');
      if (body.permissionMode === 'bypassPermissions' && !s.allowBypassPermissions) {
        return fail(res, 403, '请先显式启用“允许完全跳过权限”', 'BYPASS_NOT_ALLOWED');
      }
      s.permissionMode = body.permissionMode;
    }
    if (body.model !== undefined) s.model = String(body.model || '').slice(0, 100);
    if (body.maxSessions !== undefined) s.maxSessions = Math.max(1, Math.min(5, Number(body.maxSessions) || 3));
    if (body.autoStartTunnel !== undefined) s.autoStartTunnel = Boolean(body.autoStartTunnel);
    if (body.tunnelMode !== undefined) {
      if (!['off', 'cloudflare', 'tailscale'].includes(body.tunnelMode)) return fail(res, 400, '无效的隧道模式', 'BAD_TUNNEL');
      s.tunnelMode = body.tunnelMode;
    }
    if (body.allowBypassPermissions !== undefined) {
      if (body.allowBypassPermissions && body.confirm !== '允许') {
        return fail(res, 400, '启用完全权限需要输入“允许”确认', 'CONFIRM_REQUIRED');
      }
      s.allowBypassPermissions = Boolean(body.allowBypassPermissions);
      if (!s.allowBypassPermissions && s.permissionMode === 'bypassPermissions') s.permissionMode = 'default';
    }
    if (body.workspaces !== undefined) {
      if (!Array.isArray(body.workspaces)) return fail(res, 400, 'workspaces 必须是数组', 'BAD_WORKSPACES');
      const cleaned = [];
      for (const item of body.workspaces.slice(0, 50)) {
        try {
          const real = await validateWorkspace(String(item), s.allowedRoots);
          if (!cleaned.includes(real)) cleaned.push(real);
        } catch (err) {
          return fail(res, 400, err.message, 'BAD_WORKSPACE');
        }
      }
      s.workspaces = cleaned;
    }
    if (body.allowedRoots !== undefined) {
      if (!Array.isArray(body.allowedRoots) || body.allowedRoots.length === 0) {
        return fail(res, 400, '至少保留一个允许的根目录', 'BAD_ROOTS');
      }
      const roots = [];
      for (const item of body.allowedRoots.slice(0, 20)) {
        const resolved = path.resolve(String(item));
        try {
          const stat = await fsp.stat(resolved);
          if (!stat.isDirectory()) throw new Error('不是目录');
          if (!roots.includes(resolved)) roots.push(resolved);
        } catch {
          return fail(res, 400, `根目录不存在：${resolved}`, 'BAD_ROOT');
        }
      }
      s.allowedRoots = roots;
    }
    await saveState();
    hub.broadcast('settings', { settings: publicSettings() });
    audit('settings.update', Object.keys(body).join(','), clientIp(req));
    return json(res, 200, { ok: true, settings: publicSettings() });
  }

  if (method === 'GET' && pathname === '/api/audit') {
    return json(res, 200, { audit: getState().audit.slice(0, 100) });
  }

  if (method === 'GET' && pathname === '/api/system') {
    return json(res, 200, { system: await systemInfo() });
  }

  return fail(res, 404, '接口不存在', 'NOT_FOUND');
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return fail(res, 405, 'Method Not Allowed');
  }
  let relative = pathname === '/' ? '/index.html' : pathname;
  if (relative.endsWith('/')) relative += 'index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    return fail(res, 403, 'Forbidden');
  }
  let stat;
  try { stat = await fsp.stat(filePath); } catch {}
  if (!stat || !stat.isFile()) {
    if (!path.extname(relative)) {
      return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }
    return fail(res, 404, 'Not Found');
  }
  return serveFile(req, res, filePath, stat);
}

async function serveFile(req, res, filePath, stat = null) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const info = stat || await fsp.stat(filePath);
  const isHtml = ext === '.html';
  const isServiceWorker = path.basename(filePath) === 'sw.js';
  const isCode = ['.js', '.mjs', '.css', '.webmanifest'].includes(ext);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': isHtml || isServiceWorker || isCode ? 'no-cache' : 'public, max-age=86400',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).on('error', () => { try { res.destroy(); } catch {} }).pipe(res);
}

export async function startServer({ port = PORT, host = HOST, peerInbox = true } = {}) {
  await loadState();
  pruneSessions();
  const hub = new EventHub();
  const manager = new ClaudeManager({ hub });
  const tunnel = new TunnelManager({ port, hub });
  const watcher = new PluginWatcher({ hub });
  let inbox = null;
  if (peerInbox) {
    inbox = new PeerInbox({ hub });
    try {
      await inbox.start();
    } catch (err) {
      console.error('[peer-inbox]', err.message);
      inbox = null;
    }
  }
  const server = createApp({ manager, tunnel, hub, watcher, inbox });

  const tlsKey = process.env.RD_TLS_KEY;
  const tlsCert = process.env.RD_TLS_CERT;
  let finalServer = server;
  if (tlsKey && tlsCert) {
    finalServer = https.createServer({
      key: await fsp.readFile(tlsKey),
      cert: await fsp.readFile(tlsCert),
    }, server.listeners('request')[0]);
  }

  await new Promise((resolve, reject) => {
    finalServer.once('error', reject);
    finalServer.listen(port, host, () => {
      finalServer.off('error', reject);
      resolve();
    });
  });

  const address = finalServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const scheme = tlsKey && tlsCert ? 'https' : 'http';
  const localUrl = `${scheme}://127.0.0.1:${actualPort}`;

  console.log('');
  console.log('  RemoteDeck 已启动');
  console.log(`  版本: ${VERSION}   Node: ${process.version}`);
  console.log(`  本机: ${localUrl}`);
  if (host === '0.0.0.0' || host === '::') {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const item of list || []) {
        if (item.family === 'IPv4' && !item.internal) console.log(`  局域网: http://${item.address}:${actualPort}  (${name})`);
      }
    }
    console.log('  注意: 直接暴露到局域网时，请确保使用 HTTPS 或可信网络。');
  }
  if (!isConfigured()) {
    console.log('');
    console.log('  首次使用: 在电脑浏览器打开上面的“本机”地址，设置密码。');
  } else {
    console.log('');
    console.log('  手机远程: 在“设置 → 远程访问”中启动 Cloudflare 隧道或 Tailscale。');
  }
  console.log('');

  if (isConfigured()) tunnel.autoStart();
  else setTimeout(() => tunnel.autoStart(), 1000).unref?.();
  watcher.start();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n[RemoteDeck] 收到 ${signal}，正在关闭…`);
    await stopServer({ server: finalServer, manager, watcher, inbox, tunnel, hub });
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (process.env.RD_DESKTOP_CHILD === '1') {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (String(chunk).includes('shutdown')) void shutdown('desktop');
    });
  }

  return { server: finalServer, manager, tunnel, hub, watcher, inbox, port: actualPort, url: localUrl };
}

export async function stopServer({ server, manager, watcher, inbox, tunnel, hub } = {}) {
  try { manager?.closeAll(); } catch {}
  try { watcher?.stop(); } catch {}
  try { await inbox?.stop(); } catch {}
  try { await tunnel?.stop({ silent: true }); } catch {}
  try { hub?.closeAll(); } catch {}
  if (!server) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2500);
    try {
      if (typeof server.close === 'function') {
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      } else {
        clearTimeout(timer);
        resolve();
      }
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  startServer().catch((err) => {
    console.error('RemoteDeck 启动失败:', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用。请关闭占用程序，或设置环境变量 RD_PORT 使用其他端口。`);
    }
    process.exit(1);
  });
}
