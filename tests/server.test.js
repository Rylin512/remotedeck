import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tempDir = await fs.mkdtemp(path.join(here, '..', '.tmp-server-'));
process.env.RD_DATA_DIR = tempDir;
process.env.RD_PORT = '0';
process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude');

const { startServer } = await import('../server/index.js');

let app;
let cookie = '';
let csrf = '';

async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (cookie) h.Cookie = cookie;
  if (csrf && !('X-CSRF-Token' in headers)) h['X-CSRF-Token'] = csrf;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(app.url + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
  return { res, data };
}

test.before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', peerInbox: false });
});

test.after(async () => {
  try { app.manager.closeAll(); } catch {}
  try { app.watcher.stop(); } catch {}
  try { await app.tunnel.stop({ silent: true }); } catch {}
  app.hub.closeAll();
  await new Promise((resolve) => app.server.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('health is public and first run requires setup', async () => {
  const health = await call('/api/health');
  assert.equal(health.res.status, 200);
  assert.equal(health.data.setupRequired, true);
  const state = await call('/api/state');
  assert.equal(state.res.status, 200);
  assert.equal(state.data.setupRequired, true);
});

test('setup creates a session and state is then authenticated', async () => {
  const setup = await call('/api/setup', {
    method: 'POST',
    body: { password: 'RemoteDeck-Test-2026', confirm: 'RemoteDeck-Test-2026' },
  });
  assert.equal(setup.res.status, 200);
  assert.ok(setup.data.csrf);
  csrf = setup.data.csrf;
  assert.ok(cookie.startsWith('rd_session='));

  const state = await call('/api/state');
  assert.equal(state.res.status, 200);
  assert.equal(state.data.authenticated, true);
  assert.equal(state.data.setupRequired, false);
  assert.ok(Array.isArray(state.data.claude.sessions));
});

test('mutations require the CSRF token and valid confirmation', async () => {
  const noCsrf = await call('/api/power', {
    method: 'POST',
    body: { action: 'shutdown', confirm: '关机' },
    headers: { 'X-CSRF-Token': 'not-the-right-token' },
  });
  assert.equal(noCsrf.res.status, 403);

  const badConfirm = await call('/api/power', {
    method: 'POST',
    body: { action: 'shutdown', confirm: 'x' },
  });
  assert.equal(badConfirm.res.status, 400);
  assert.match(badConfirm.data.message, /关机/);
});

test('settings update persists and rejects missing workspace paths', async () => {
  const workspace = path.join(here, '..');
  const updated = await call('/api/settings', {
    method: 'POST',
    body: { workspaces: [workspace], permissionMode: 'acceptEdits' },
  });
  assert.equal(updated.res.status, 200);
  assert.equal(updated.data.settings.permissionMode, 'acceptEdits');
  assert.ok(updated.data.settings.workspaces.includes(path.resolve(workspace)));

  const bad = await call('/api/settings', {
    method: 'POST',
    body: { workspaces: [path.join(workspace, 'missing-xyz')] },
  });
  assert.equal(bad.res.status, 400);
});

test('logout invalidates the session', async () => {
  const logout = await call('/api/logout', { method: 'POST', body: {} });
  assert.equal(logout.res.status, 200);
  const state = await call('/api/state');
  assert.equal(state.res.status, 401);
});
