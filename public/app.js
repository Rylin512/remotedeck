import { buildEditDiff } from './diff.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  state: null,
  csrf: '',
  view: 'chat',
  activeSessionId: null,
  session: null,
  historyView: null,
  historyTimer: null,
  historySig: null,
  historyShowAll: false,
  historyAll: null,
  historyAllError: null,
  historyAllLoading: false,
  continueBusy: false,
  wakeLock: null,
  wakeLockActive: false,
  noSleep: null,
  wakeLockEnabled: false,
  pluginSession: null,
  pluginSessionId: null,
  pluginMode: 'nudge',
  thinkingTokens: 0,
  thinkingEstimated: true,
  currentActivity: null,
  vscodeWindowTimer: null,
  vscodeWindowsLoading: false,
  pluginLiveFrame: 0,
  sse: null,
  sseRetry: null,
  lastSseAt: 0,
  sseWatchdog: null,
  resyncTimer: null,
  resyncing: false,
  messageLimit: 120,
  hasOlder: false,
  loadingOlder: false,
  deltaBuffers: new Map(),
  deltaFrame: 0,
  connected: false,
  rendered: new Map(),
  toolEls: new Map(),
  toolNames: new Map(),
  liveByMessage: new Map(),
  permissions: new Map(),
  questions: new Map(),
  currentPermission: null,
  currentQuestion: null,
  powerAction: null,
  autoScroll: true,
  qrUrl: null,
  installPrompt: null,
  pollBusy: false,
};

const MODE_LABELS = {
  default: '逐项批准',
  acceptEdits: '自动批准编辑',
  auto: '自动模式',
  plan: '仅规划',
  dontAsk: '不询问',
  bypassPermissions: '完全跳过权限',
};

const STATUS_LABELS = {
  starting: '启动中',
  idle: '空闲',
  running: '运行中',
  waiting_permission: '等待批准',
  stopped: '已停止',
  error: '错误',
};

const POWER_LABELS = {
  shutdown: { title: '关机', word: '关机', desc: '电脑将在倒计时结束后关机。未保存的工作可能丢失。', danger: true },
  restart: { title: '重启', word: '重启', desc: '电脑将在倒计时结束后重启。', danger: false },
  lock: { title: '锁定', word: '锁定', desc: '立即锁定当前 Windows 会话。', danger: false },
  sleep: { title: '睡眠', word: '睡眠', desc: '让电脑进入睡眠。部分主板可能配置为休眠。', danger: false },
  cancel: { title: '取消关机', word: '取消', desc: '取消已经计划的关机或重启。', danger: false },
};

const AUDIT_LABELS = {
  'auth.setup': '完成初始化',
  'auth.login': '登录成功',
  'auth.login.failed': '登录失败',
  'auth.logout': '退出登录',
  'auth.password': '修改密码',
  'claude.start': '启动会话',
  'claude.prompt': '发送指令',
  'claude.interrupt': '中断任务',
  'claude.stop': '停止会话',
  'claude.permission': '请求权限',
  'claude.permission.resolve': '处理权限',
  'claude.official': '官方远程控制',
  'vscode.open': '打开 VS Code',
  'vscode.claude.open': '打开 Claude 面板',
  'vscode.claude.prompt': '发送到 VS Code',
  'power.request': '电源操作',
  'power.error': '电源操作失败',
  'tunnel.start': '启动隧道',
  'tunnel.stop': '停止隧道',
  autostart: '开机自启动',
  'settings.update': '更新设置',
};

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function inlineMd(escaped) {
  let text = escaped;
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return text;
}

function markdown(text) {
  const source = String(text || '');
  const parts = source.split(/```/);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      const cleaned = part.replace(/^[a-zA-Z0-9_+-]*\n/, '');
      return `<pre><code>${escapeHtml(cleaned.replace(/\n$/, ''))}</code></pre>`;
    }
    const escaped = escapeHtml(part);
    return inlineMd(escaped).replace(/\n/g, '<br>');
  }).join('');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatTokenCount(tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(Number(ts)).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function clockTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', Boolean(isError));
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function showLaunchOverlay(title, detail) {
  $('#launch-title').textContent = title;
  $('#launch-detail').textContent = detail;
  $('#launch-overlay').hidden = false;
  document.body.classList.add('launching');
}

function updateLaunchOverlay(title, detail) {
  if ($('#launch-overlay').hidden) return;
  $('#launch-title').textContent = title;
  $('#launch-detail').textContent = detail;
}

function hideLaunchOverlay() {
  $('#launch-overlay').hidden = true;
  document.body.classList.remove('launching');
}

function updateComposerStatusRow() {
  const row = $('#composer-status-row');
  if (!row) return;
  const actions = $('#plugin-send-mode');
  const indicator = $('#thinking-indicator');
  row.hidden = Boolean(actions?.hidden && indicator?.hidden);
}

function updateThinkingIndicator() {
  const box = $('#thinking-indicator');
  if (!box) return;
  if (S.historyView) {
    box.hidden = true;
    updateComposerStatusRow();
    return;
  }
  const session = S.pluginSession || S.session;
  const running = session && !session.closed && ['starting', 'running'].includes(session.status);
  if (!running) {
    box.hidden = true;
    updateComposerStatusRow();
    return;
  }
  const pendingTools = S.pluginSession ? Number(S.pluginSession.pendingTools) || 0 : 0;
  let label = 'Claude 正在思考…';
  if (pendingTools > 0 || S.currentActivity === 'tool') label = 'Claude 正在执行工具…';
  else if (S.currentActivity === 'writing') label = 'Claude 正在输出…';
  const tokenText = S.thinkingTokens && S.currentActivity === 'thinking'
    ? `${S.thinkingEstimated ? '约 ' : ''}${formatTokenCount(S.thinkingTokens)} tokens`
    : '';
  const labelEl = $('#thinking-indicator-label');
  const tokenEl = $('#thinking-indicator-token');
  if (labelEl.textContent !== label) labelEl.textContent = label;
  if (tokenEl.textContent !== tokenText) tokenEl.textContent = tokenText;
  box.hidden = false;
  updateComposerStatusRow();
}

function hideThinkingIndicator() {
  const box = $('#thinking-indicator');
  if (box) box.hidden = true;
  updateComposerStatusRow();
}

function getNoSleep() {
  if (!S.noSleep && typeof window.NoSleep === 'function') S.noSleep = new window.NoSleep();
  return S.noSleep;
}

function syncNativeKeepAwake() {
  try {
    window.RemoteDeckNative?.setKeepScreenOn?.(Boolean(S.wakeLockEnabled));
  } catch {}
}

async function requestWakeLock(showError = false) {
  if (!S.wakeLockEnabled || S.wakeLockActive) return;
  if (document.visibilityState !== 'visible') return;
  const noSleep = getNoSleep();
  if (noSleep) {
    try {
      await noSleep.enable();
      S.wakeLockActive = true;
      S.wakeLock = null;
      $('#wake-lock-toggle').checked = true;
      $('#wake-lock-hint').textContent = window.isSecureContext
        ? '屏幕常亮已开启；切到后台会自动释放，回来后重新获取。'
        : '屏幕常亮已开启（HTTP 兼容模式，使用静音视频保持唤醒）。';
      return;
    } catch (err) {
      S.wakeLockActive = false;
      if (showError) toast(`开启屏幕常亮失败：${err.message}`, true);
      // Fall through to the native Wake Lock API below.
    }
  }
  if (!('wakeLock' in navigator)) {
    S.wakeLockEnabled = false;
    localStorage.removeItem('rd_wake_lock');
    $('#wake-lock-toggle').checked = false;
    $('#wake-lock-hint').textContent = '当前浏览器不支持屏幕常亮。';
    if (showError) toast('当前浏览器不支持屏幕常亮', true);
    return;
  }
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLockActive = true;
    S.wakeLock.addEventListener('release', () => {
      S.wakeLock = null;
      S.wakeLockActive = false;
      if (S.wakeLockEnabled) setTimeout(() => requestWakeLock(false), 800);
    });
    $('#wake-lock-toggle').checked = true;
    $('#wake-lock-hint').textContent = '屏幕常亮已开启；切到后台会自动释放，回来后重新获取。';
  } catch (err) {
    S.wakeLock = null;
    S.wakeLockActive = false;
    S.wakeLockEnabled = false;
    localStorage.removeItem('rd_wake_lock');
    $('#wake-lock-toggle').checked = false;
    $('#wake-lock-hint').textContent = '无法开启屏幕常亮；请使用 HTTPS 或 localhost 打开 RemoteDeck。';
    if (showError) toast(`开启屏幕常亮失败：${err.message}`, true);
  }
}

async function setWakeLock(enabled) {
  S.wakeLockEnabled = Boolean(enabled);
  syncNativeKeepAwake();
  if (enabled) localStorage.setItem('rd_wake_lock', '1');
  else localStorage.setItem('rd_wake_lock', '0');
  if (!enabled) {
    try { S.noSleep?.disable(); } catch {}
    try { await S.wakeLock?.release(); } catch {}
    S.wakeLock = null;
    S.wakeLockActive = false;
    $('#wake-lock-toggle').checked = false;
    $('#wake-lock-hint').textContent = '已关闭屏幕常亮。';
    return;
  }
  await requestWakeLock(true);
}

function initWakeLock() {
  S.wakeLockEnabled = localStorage.getItem('rd_wake_lock') !== '0';
  syncNativeKeepAwake();
  const toggle = $('#wake-lock-toggle');
  if (!toggle) return;
  toggle.checked = S.wakeLockEnabled;
  if (typeof window.NoSleep !== 'function' && !('wakeLock' in navigator)) {
    toggle.checked = false;
    toggle.disabled = true;
    $('#wake-lock-hint').textContent = '当前浏览器不支持屏幕常亮。';
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.wakeLockEnabled) {
      const fallbackPaused = Boolean(S.noSleep?.noSleepVideo?.paused);
      if (!S.wakeLockActive || fallbackPaused) {
        S.wakeLockActive = false;
        void requestWakeLock(false);
      }
    }
  });
  if (S.wakeLockEnabled) {
    document.addEventListener('pointerdown', () => void requestWakeLock(false), { once: true });
  }
}

async function waitForPluginSession(sessionId, seconds = 15) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await refreshState({ silent: true });
    const live = (S.state?.plugin?.sessions || []).some((s) => s.id === sessionId && s.live);
    if (live) return true;
  }
  return false;
}

function setButtonBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.oldText = button.innerHTML;
    button.disabled = true;
    if (label) button.textContent = label;
  } else {
    button.disabled = false;
    if (button.dataset.oldText) {
      button.innerHTML = button.dataset.oldText;
      delete button.dataset.oldText;
    }
  }
}

async function api(path, { method = 'GET', body, timeout = 120_000 } = {}) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = S.csrf;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  init.signal = controller.signal;
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('请求超时，请检查网络');
    throw new Error('无法连接电脑，请检查网络或服务是否在运行');
  }
  clearTimeout(timer);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (res.status === 401) {
    showAuth('login');
    throw new Error(data.message || '登录已过期，请重新登录');
  }
  if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
  return data;
}

async function fetchState() {
  const res = await fetch('/api/state', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (res.status === 401) return { authenticated: false, setupRequired: data.setupRequired || false };
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

/* ---------------- Boot ---------------- */

document.addEventListener('DOMContentLoaded', init);

function initComposerDock() {
  const dock = $('#composer-dock');
  if (!dock) return;
  const update = () => {
    const height = Math.ceil(dock.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty('--dock-h', `${height}px`);
  };
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(update).observe(dock);
  }
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  update();
}

async function init() {
  bindEvents();
  initWakeLock();
  initResumeRecovery();
  startSseWatchdog();
  initComposerDock();
  registerServiceWorker();
  setupInstallPrompt();
  try {
    const state = await fetchState();
    if (state.setupRequired) {
      showAuth('setup');
    } else if (!state.authenticated) {
      showAuth('login');
    } else {
      enterApp(state);
    }
  } catch (err) {
    showAuth('login');
    toast(err.message, true);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!secure) return;
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    S.installPrompt = event;
    const card = document.querySelector('.about-card');
    if (card && !document.getElementById('install-app-btn')) {
      const btn = document.createElement('button');
      btn.id = 'install-app-btn';
      btn.className = 'secondary full';
      btn.style.marginTop = '10px';
      btn.textContent = '安装到手机桌面';
      btn.addEventListener('click', async () => {
        if (!S.installPrompt) {
          $('#install-dialog').showModal();
          return;
        }
        S.installPrompt.prompt();
        await S.installPrompt.userChoice;
        S.installPrompt = null;
      });
      card.appendChild(btn);
    }
  });
}

function showAuth(mode = 'login') {
  closeSSE();
  $('#auth').hidden = false;
  $('#shell').hidden = true;
  $('#login-card').hidden = mode !== 'login';
  $('#setup-card').hidden = mode !== 'setup';
  $('#login-error').textContent = '';
  $('#setup-error').textContent = '';
  setTimeout(() => {
    const input = mode === 'setup' ? $('#setup-password') : $('#login-password');
    input?.focus();
  }, 120);
}

function enterApp(state) {
  S.state = state;
  S.csrf = state.csrf || '';
  $('#auth').hidden = true;
  $('#shell').hidden = false;
  renderAll();
  connectSSE();
  const saved = localStorage.getItem('rd_active_session');
  if (saved && state.claude.sessions.some((s) => s.id === saved)) {
    loadSession(saved).catch(() => {});
  } else {
    showEmptyChat();
  }
  switchView('chat');
  const initialView = new URLSearchParams(location.search).get('view');
  if (['chat', 'power', 'vscode', 'settings'].includes(initialView)) switchView(initialView);
}

async function refreshState({ silent = false } = {}) {
  try {
    const state = await fetchState();
    if (!state.authenticated) {
      showAuth('login');
      return;
    }
    S.state = state;
    S.csrf = state.csrf || S.csrf;
    renderAll();
    if (S.activeSessionId) {
      const current = state.claude.sessions.find((s) => s.id === S.activeSessionId);
      if (current) {
        S.session = { ...(S.session || {}), ...current };
        renderSessionHeader();
        updateComposerState();
      }
    }
  } catch (err) {
    if (!silent) toast(err.message, true);
  }
}

/* ---------------- SSE ---------------- */

function connectSSE() {
  closeSSE();
  const es = new EventSource('/api/events');
  S.sse = es;
  S.lastSseAt = Date.now();
  setConnected(false, '连接中…');
  es.onopen = () => {
    S.lastSseAt = Date.now();
    setConnected(true, '已连接');
    scheduleSessionResync(700);
  };
  es.onerror = () => {
    setConnected(false, '正在重连…');
    if (es.readyState === EventSource.CLOSED) {
      clearTimeout(S.sseRetry);
      S.sseRetry = setTimeout(() => {
        if (S.state?.authenticated) connectSSE();
      }, 3000);
    }
  };
  const mark = () => { S.lastSseAt = Date.now(); };
  es.addEventListener('ping', () => {
    mark();
    setConnected(true, '已连接');
  });
  es.addEventListener('hello', () => {
    mark();
    setConnected(true, '已连接');
  });
  es.addEventListener('session', (evt) => { mark(); onSessionEvent(parseEvent(evt)); });
  es.addEventListener('claude', (evt) => { mark(); onClaudeEvent(parseEvent(evt)); });
  es.addEventListener('permission', (evt) => { mark(); onPermissionEvent(parseEvent(evt)); });
  es.addEventListener('permission_resolved', (evt) => { mark(); onPermissionResolved(parseEvent(evt)); });
  es.addEventListener('question', (evt) => { mark(); onQuestionEvent(parseEvent(evt)); });
  es.addEventListener('question_resolved', (evt) => { mark(); onQuestionResolved(parseEvent(evt)); });
  es.addEventListener('plugin_sessions', (evt) => { mark(); onPluginSessions(parseEvent(evt)); });
  es.addEventListener('plugin_event', (evt) => { mark(); onPluginEvent(parseEvent(evt)); });
  es.addEventListener('peer_reply', (evt) => { mark(); onPeerReply(parseEvent(evt)); });
  es.addEventListener('plugin_closed', (evt) => { mark(); onPluginClosed(parseEvent(evt)); });
  es.addEventListener('tunnel', (evt) => { mark(); onTunnelEvent(parseEvent(evt)); });
  es.addEventListener('settings', () => { mark(); refreshState({ silent: true }); });
  es.addEventListener('power', (evt) => { mark(); onPowerEvent(parseEvent(evt)); });
  es.addEventListener('power_error', (evt) => { mark(); toast(parseEvent(evt).message || '电源操作失败', true); });
}

function closeSSE() {
  if (S.sse) {
    try { S.sse.close(); } catch {}
    S.sse = null;
  }
  clearTimeout(S.sseRetry);
}

function startSseWatchdog() {
  if (S.sseWatchdog) return;
  S.sseWatchdog = setInterval(() => {
    if (!S.state?.authenticated || document.visibilityState !== 'visible') return;
    const stale = Date.now() - (S.lastSseAt || 0) > 45_000;
    const dead = !S.sse || S.sse.readyState === EventSource.CLOSED;
    if (stale || dead) {
      setConnected(false, '正在恢复连接…');
      connectSSE();
      scheduleSessionResync(900);
    }
  }, 15_000);
}

function resumeFromSleep() {
  if (!S.state?.authenticated) return;
  if (document.visibilityState !== 'visible') return;
  const stale = Date.now() - (S.lastSseAt || 0) > 20_000;
  const socketBad = !S.sse || S.sse.readyState !== EventSource.OPEN;
  if (stale || socketBad) {
    setConnected(false, '正在恢复连接…');
    connectSSE();
  }
  scheduleSessionResync(650);
}

function initResumeRecovery() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeFromSleep();
  });
  window.addEventListener('pageshow', () => resumeFromSleep());
  window.addEventListener('online', () => resumeFromSleep());
  window.addEventListener('focus', () => {
    if (Date.now() - (S.lastSseAt || 0) > 30_000) resumeFromSleep();
  });
}

function scheduleSessionResync(delay = 650) {
  clearTimeout(S.resyncTimer);
  S.resyncTimer = setTimeout(() => {
    resyncActiveSession().catch(() => {});
  }, delay);
}

async function resyncActiveSession() {
  if (!S.state?.authenticated || S.resyncing || S.historyView) return;
  const pluginId = S.pluginSessionId;
  const sessionId = S.activeSessionId;
  if (!pluginId && !sessionId) {
    await refreshState({ silent: true });
    return;
  }
  const box = $('#messages');
  const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const oldTop = box?.scrollTop || 0;
  S.resyncing = true;
  try {
    if (pluginId) {
      const data = await api(`/api/claude/plugin/sessions/${pluginId}?limit=${S.messageLimit}`);
      if (S.pluginSessionId !== pluginId) return;
      if (data.session) S.pluginSession = { ...(S.pluginSession || {}), ...data.session };
      renderMessages(data.messages || [], { scroll: atBottom, hasOlder: Boolean(data.session?.hasMore) });
      if (!atBottom && box) box.scrollTop = oldTop;
      updatePluginHeader();
      updateComposerState();
      updateThinkingIndicator();
      await refreshState({ silent: true });
      return;
    }
    const data = await api(`/api/claude/sessions/${sessionId}?limit=${S.messageLimit}`);
    if (S.activeSessionId !== sessionId) return;
    if (!data.session) return;
    S.session = data.session;
    renderSessionHeader();
    renderMessages(S.session.messages || [], { scroll: atBottom, hasOlder: Boolean(S.session.hasMore) });
    if (!atBottom && box) box.scrollTop = oldTop;
    updateComposerState();
    updateThinkingIndicator();
    syncQuestionsFromSession(S.session);
    await refreshState({ silent: true });
  } finally {
    S.resyncing = false;
  }
}

function parseEvent(evt) {
  try { return JSON.parse(evt.data || '{}'); } catch { return {}; }
}

function setConnected(ok, label) {
  S.connected = ok;
  $('#conn-dot').className = `status-dot ${ok ? 'on' : 'busy'}`;
  $('#conn-label').textContent = label;
}

function onSessionEvent(data) {
  const session = data.session;
  if (!session || !S.state) return;
  const list = S.state.claude.sessions || [];
  const index = list.findIndex((s) => s.id === session.id);
  if (index >= 0) list[index] = { ...list[index], ...session };
  else list.unshift(session);
  if (S.activeSessionId === session.id) {
    S.session = { ...(S.session || {}), ...session };
    renderSessionHeader();
    updateComposerState();
    renderPendingBar();
  }
  renderHistory();
  updateThinkingIndicator();
  if (S.activeSessionId === session.id) syncQuestionsFromSession(session);
}

function onClaudeEvent(data) {
  if (!data.sessionId || data.sessionId !== S.activeSessionId) return;
  if (data.event) applyClaudeEvent(data.event);
}

function onPermissionEvent(data) {
  if (!data.permission) return;
  const permission = { ...data.permission, sessionId: data.sessionId, sessionTitle: data.sessionTitle };
  S.permissions.set(permission.requestId, permission);
  renderPendingBar();
  if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
  if (S.activeSessionId === permission.sessionId && !$('#permission-dialog').open) {
    showPermission(permission);
  } else {
    toast(`Claude 请求批准：${permission.toolName}`);
  }
}

function onPermissionResolved(data) {
  S.permissions.delete(data.requestId);
  if (S.currentPermission?.requestId === data.requestId) {
    hidePermissionDialog();
    setTimeout(() => {
      const nextQuestion = [...S.questions.values()].find((q) => q.sessionId === S.activeSessionId);
      if (nextQuestion) {
        showQuestion(nextQuestion);
        return;
      }
      const next = [...S.permissions.values()].find((p) => p.sessionId === S.activeSessionId);
      if (next) showPermission(next);
    }, 250);
  }
  renderPendingBar();
}

function onQuestionEvent(data) {
  if (!data.question) return;
  const question = { ...data.question, sessionId: data.sessionId, sessionTitle: data.sessionTitle };
  S.questions.set(question.requestId, question);
  renderPendingBar();
  if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
  if (S.activeSessionId === question.sessionId && !$('#question-dialog').open) {
    showQuestion(question);
  } else {
    toast('Claude 有问题需要你选择');
  }
}

function onQuestionResolved(data) {
  S.questions.delete(data.requestId);
  if (S.currentQuestion?.requestId === data.requestId) {
    S.currentQuestion = null;
    if ($('#question-dialog').open) $('#question-dialog').close();
    setTimeout(() => {
      const next = [...S.questions.values()].find((q) => q.sessionId === S.activeSessionId);
      if (next) showQuestion(next);
      else {
        const nextPermission = [...S.permissions.values()].find((p) => p.sessionId === S.activeSessionId);
        if (nextPermission) showPermission(nextPermission);
      }
    }, 250);
  }
  renderPendingBar();
}

function onTunnelEvent(data) {
  if (!S.state || !data.tunnel) return;
  S.state.tunnel = data.tunnel;
  renderTunnel();
  renderRemotePill();
}

function onPluginSessions(data) {
  if (!S.state || !Array.isArray(data.sessions)) return;
  const beforeLive = (S.state.plugin?.sessions || [])
    .filter((s) => s.live).map((s) => s.id).sort().join('|');
  S.state.plugin = { ...(S.state.plugin || {}), sessions: data.sessions };
  const afterLive = data.sessions.filter((s) => s.live).map((s) => s.id).sort().join('|');
  renderPluginLive();
  if (beforeLive !== afterLive) renderHistory();
  if (S.pluginSessionId) {
    const current = data.sessions.find((s) => s.id === S.pluginSessionId);
    if (current) {
      S.pluginSession = { ...S.pluginSession, ...current };
      updatePluginHeader();
      updateThinkingIndicator();
    } else {
      // The backing Claude process exited or its VS Code window was closed.
      // Do not leave the old conversation on screen.
      showEmptyChat();
      toast('插件会话已结束');
    }
  }
}

function onPluginEvent(data) {
  if (!data.sessionId) return;
  const sessions = S.state?.plugin?.sessions || [];
  const current = sessions.find((s) => s.id === data.sessionId);
  if (current) {
    current.lastModified = Date.now();
    current.status = 'running';
    if (data.event?.event === 'assistant' && data.event.text) current.preview = data.event.text.slice(0, 180);
    schedulePluginLiveRender();
  }
  if (S.pluginSessionId === data.sessionId) {
    if (data.event) applyClaudeEvent(data.event);
    if (S.pluginSession) S.pluginSession.lastModified = Date.now();
    updatePluginHeader();
    updateThinkingIndicator();
  }
}

function onPeerReply(data) {
  const body = String(data.body || '').trim();
  if (!body) return;
  const fromName = data.fromName || data.from || 'Claude 插件';
  toast(`插件回复：${body.length > 120 ? `${body.slice(0, 120)}…` : body}`);
  if (S.pluginSessionId) {
    applyClaudeEvent({
      event: 'system',
      id: `peer-reply:${data.msgId || Date.now()}`,
      text: `来自 ${fromName} 的回复：${body}`,
      source: 'peer',
      ts: data.receivedAt || new Date().toISOString(),
    });
  }
}

function onPluginClosed(data) {
  if (!data.sessionId) return;
  if (S.pluginSessionId === data.sessionId) {
    showEmptyChat();
    toast('插件会话已关闭');
  }
  const sessions = S.state?.plugin?.sessions || [];
  const current = sessions.find((s) => s.id === data.sessionId);
  if (current) {
    current.live = false;
    renderPluginLive();
    renderHistory();
  }
}

function onPowerEvent(data) {
  if (data.action === 'shutdown') toast('电脑将在倒计时后关机');
  else if (data.action === 'restart') toast('电脑将在倒计时后重启');
  else if (data.action === 'cancel') toast('已请求取消关机');
}

/* ---------------- Render ---------------- */

function renderAll() {
  if (!S.state) return;
  const host = S.state.system?.hostname || 'RemoteDeck';
  $('#topbar-host').textContent = host;
  $('#login-version').textContent = `v${S.state.version || '0.1.0'}`;
  $('#settings-version').textContent = `v${S.state.version || '0.1.0'}`;
  $('#security-version').textContent = `v${S.state.version || '0.1.0'}`;
  $('#power-host').textContent = host;
  renderRemotePill();
  renderChatEmpty();
  renderPluginLive();
  renderHistory();
  renderPower();
  renderVSCode();
  renderSettings();
  if (S.session) {
    renderSessionHeader();
    updateComposerState();
  }
  renderPendingBar();
  if (S.session) syncQuestionsFromSession(S.session);
}

function renderRemotePill() {
  const tunnel = S.state?.tunnel;
  const pill = $('#remote-pill');
  const active = tunnel && tunnel.status === 'running' && tunnel.url;
  pill.hidden = !active;
  if (active) {
    pill.title = tunnel.url;
    pill.onclick = () => {
      navigator.clipboard?.writeText(tunnel.url).then(() => toast('远程地址已复制')).catch(() => {});
    };
  }
}

function currentModeLabel(mode) {
  return MODE_LABELS[mode] || mode || '默认';
}

function renderChatEmpty() {
  const select = $('#workspace-select');
  const previous = select.value;
  const workspaces = S.state?.vscode?.recents || [];
  const options = [];
  for (const item of workspaces) {
    if (!item?.path) continue;
    options.push(`<option value="${escapeHtml(item.path)}">${escapeHtml(item.name)} · ${escapeHtml(item.path)}</option>`);
  }
  if (!options.length) options.push('<option value="">暂无最近项目，请使用自定义路径</option>');
  select.innerHTML = options.join('');
  if (previous && [...select.options].some((o) => o.value === previous)) select.value = previous;

  $('#permission-mode').value = S.state?.settings?.permissionMode || 'default';
  if (!$('#model-input').dataset.touched) $('#model-input').value = S.state?.settings?.model || '';
  $('#start-hint').textContent = S.state?.claude?.sessions?.length
    ? `已有 ${S.state.claude.sessions.filter((s) => s.status !== 'stopped').length} 个活动会话`
    : '首次启动会加载 Claude Code，可能需要几秒。';
}

function schedulePluginLiveRender() {
  if (S.pluginLiveFrame) return;
  S.pluginLiveFrame = requestAnimationFrame(() => {
    S.pluginLiveFrame = 0;
    renderPluginLive();
  });
}

function renderPluginLive() {
  const section = $('#plugin-live-section');
  const list = $('#plugin-live-list');
  if (!section || !list) return;
  const sessions = S.state?.plugin?.sessions || [];
  section.hidden = sessions.length === 0;
  if (!sessions.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = sessions.slice(0, 4).map((item) => {
    const running = item.status === 'running';
    const statusLabel = running ? '实时运行中' : item.status === 'recent' ? '最近活跃' : '空闲';
    const detail = item.pendingTools
      ? `${item.pendingTools} 个工具调用中`
      : (item.preview || item.cwd || '');
    const sendable = item.live ? ' · 可发送' : '';
    return `
      <button class="plugin-live-item" data-plugin-id="${escapeHtml(item.id)}">
        <span class="pulse-icon"><svg class="icon"><use href="#i-terminal"/></svg></span>
        <span class="plugin-main">
          <strong>${escapeHtml(item.title || 'Claude Code 会话')}</strong>
          <span>${escapeHtml(detail)}${sendable} · ${timeAgo(item.lastModified)}</span>
        </span>
        <span class="plugin-live-status ${running ? '' : 'idle'}"><span class="live-dot"></span>${statusLabel}</span>
      </button>`;
  }).join('');
  $$('.plugin-live-item', list).forEach((button) => {
    button.addEventListener('click', () => {
      const item = sessions.find((s) => s.id === button.dataset.pluginId);
      if (item) openPluginSession(item).catch((err) => toast(err.message, true));
    });
  });
}

function updatePluginHeader() {
  if (!S.pluginSession) return;
  const s = S.pluginSession;
  const status = s.status === 'running' ? '实时监视中' : s.status === 'recent' ? '最近活跃' : '空闲';
  $('#chat-title').textContent = s.title || 'VS Code 插件会话';
  $('#chat-sub').textContent = `${s.cwd || ''} · ${status} · ${s.live ? '可发送消息' : '会话已结束'}`;
  $('#plugin-send-mode').hidden = !s.live;
  $('#prompt-input').disabled = !s.live;
  $('#send-btn').disabled = !s.live;
  $('#plugin-open-vscode-inline').hidden = false;
  $('#plugin-resume-inline').hidden = Boolean(s.live);
  $('#plugin-close-inline').hidden = !s.live;
  if (!s.live) $('#prompt-input').placeholder = '会话已结束，请点“继续对话”恢复';
  updateComposerStatusRow();
}

async function openPluginSession(item) {
  stopHistoryPolling();
  S.historyView = null;
  S.activeSessionId = null;
  S.session = null;
  S.pluginSession = item;
  S.pluginSessionId = item.id;
  S.pluginMode = 'nudge';
  S.thinkingTokens = 0;
  S.currentActivity = null;
  S.messageLimit = 120;
  showActive();
  $('#composer').hidden = false;
  $('.composer-meta').hidden = false;
  $('#history-bar').hidden = true;
  $('#plugin-send-mode').hidden = !item.live;
  $('#chat-menu-btn').hidden = true;
  $('#prompt-input').placeholder = item.live ? '给 VS Code 插件里的 Claude 发消息…' : '会话已结束，请点“继续对话”恢复';
  $('#prompt-input').value = '';
  $$('#plugin-send-mode [data-plugin-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.pluginMode === 'nudge');
  });
  $('#messages').innerHTML = '<div class="empty-list">正在读取插件会话…</div>';
  updatePluginHeader();
  updateComposerState();
  updateThinkingIndicator();
  try {
    const data = await api(`/api/claude/plugin/sessions/${item.id}?limit=${S.messageLimit}`);
    if (S.pluginSessionId !== item.id) return;
    if (!data.session || data.session.id !== item.id) {
      throw new Error('返回的会话不匹配，已取消打开');
    }
    S.pluginSession = { ...S.pluginSession, ...data.session };
    renderMessages(data.messages || [], { hasOlder: Boolean(data.session.hasMore) });
    updatePluginHeader();
    updateComposerState();
    updateThinkingIndicator();
    scrollBottom(true);
  } catch (err) {
    if (S.pluginSessionId === item.id) {
      $('#messages').innerHTML = `<div class="empty-list">读取失败：${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderHistory() {
  const list = $('#history-list');
  if (!list) return;
  updateHistoryAllButton();
  const all = S.historyShowAll && Array.isArray(S.historyAll) ? S.historyAll : null;
  const history = all || S.state?.claude?.history || [];
  const error = all ? S.historyAllError : S.state?.claude?.historyError;
  if (error) {
    list.innerHTML = `<div class="empty-list">读取历史失败：${escapeHtml(error)}</div>`;
    return;
  }
  if (!history.length) {
    list.innerHTML = '<div class="empty-list">还没有历史会话。开始第一个吧。</div>';
    return;
  }
  const shown = S.historyShowAll ? history : history.slice(0, 15);
  const remoteSessions = S.state?.claude?.sessions || [];
  const activeRemoteBySdk = new Map();
  const stoppedSdk = new Set();
  for (const session of remoteSessions) {
    if (!session.sdkSessionId) continue;
    if (session.closed || ['stopped', 'error'].includes(session.status)) {
      stoppedSdk.add(session.sdkSessionId);
    } else {
      activeRemoteBySdk.set(session.sdkSessionId, session);
    }
  }
  list.innerHTML = shown.map((item) => {
    const livePlugin = (S.state?.plugin?.sessions || []).find((p) => p.id === item.sessionId && p.live);
    const activeRemote = activeRemoteBySdk.get(item.sessionId)
      || (item.active && !stoppedSdk.has(item.sessionId) ? { id: item.activeId } : null);
    const live = Boolean(activeRemote || livePlugin);
    const title = item.summary || item.firstPrompt || '未命名会话';
    const sub = `${item.cwd || '未知目录'} · ${timeAgo(item.lastModified)}`;
    const badge = live ? '正在对话' : '历史对话';
    return `
      <div class="history-item ${live ? 'live' : ''}" data-history-id="${escapeHtml(item.sessionId)}" data-history-cwd="${escapeHtml(item.cwd || '')}" data-active-id="${escapeHtml(activeRemote?.id || item.activeId || '')}">
        <span class="history-icon ${live ? 'live' : ''}"><svg class="icon"><use href="#${live ? 'i-chat' : 'i-history'}"/></svg></span>
        <span class="history-main">
          <span class="history-title">${escapeHtml(title)}</span>
          <span class="history-sub">${escapeHtml(sub)}</span>
        </span>
        <span class="history-actions">
          <span class="history-badge ${live ? 'live' : ''}">${badge}</span>
          <button class="history-continue" data-continue-id="${escapeHtml(item.sessionId)}">继续</button>
        </span>
      </div>`;
  }).join('');
  $$('.history-item', list).forEach((row) => {
    const item = {
      sessionId: row.dataset.historyId,
      cwd: row.dataset.historyCwd,
      activeId: row.dataset.activeId,
      summary: row.querySelector('.history-title')?.textContent || '历史会话',
    };
    row.addEventListener('click', () => {
      const plugin = (S.state?.plugin?.sessions || []).find((p) => p.id === item.sessionId && p.live);
      if (plugin) openPluginSession(plugin).catch((err) => toast(err.message, true));
      else if (item.activeId) loadSession(item.activeId).catch((err) => toast(err.message, true));
      else openHistory(item).catch((err) => toast(err.message, true));
    });
    row.querySelector('.history-continue')?.addEventListener('click', (event) => {
      event.stopPropagation();
      continueHistory(item, { fork: false }).catch((err) => toast(err.message, true));
    });
  });
}

function updateHistoryAllButton() {
  const button = $('#show-all-history-btn');
  if (!button) return;
  const heading = $('#history-heading');
  if (heading) heading.textContent = S.historyShowAll ? '全部会话记录' : '最近会话';
  button.disabled = S.historyAllLoading;
  button.textContent = S.historyAllLoading
    ? '读取中…'
    : S.historyShowAll
      ? '仅看最近'
      : '显示全部记录';
}

async function toggleAllHistory(refresh = false) {
  if (S.historyAllLoading) return;
  if (S.historyShowAll) {
    S.historyShowAll = false;
    updateHistoryAllButton();
    renderHistory();
    return;
  }
  S.historyAllLoading = true;
  S.historyAllError = null;
  updateHistoryAllButton();
  try {
    const data = await api(`/api/claude/history?all=1${refresh ? '&refresh=1' : ''}`);
    S.historyAll = data.sessions || [];
    S.historyAllError = data.error || null;
    S.historyShowAll = true;
    renderHistory();
  } catch (err) {
    S.historyAllError = err.message;
    S.historyShowAll = true;
    S.historyAll = S.historyAll || [];
    renderHistory();
    toast(`读取全部记录失败：${err.message}`, true);
  } finally {
    S.historyAllLoading = false;
    updateHistoryAllButton();
  }
}

function renderPower() {
  const system = S.state?.system;
  if (!system) return;
  const cpu = system.cpuPercent ?? 0;
  const mem = system.memory?.percent ?? 0;
  const disk = system.disk?.percent ?? 0;
  const stats = [
    { icon: 'i-cpu', label: 'CPU', value: system.cpuPercent == null ? '—' : `${cpu}%`, meter: cpu },
    { icon: 'i-memory', label: '内存', value: `${mem}%`, sub: `${formatBytes(system.memory?.used)} / ${formatBytes(system.memory?.total)}`, meter: mem },
    { icon: 'i-disk', label: '磁盘', value: `${disk}%`, sub: system.disk ? `${formatBytes(system.disk.free)} 可用` : '—', meter: disk },
    { icon: 'i-clock', label: '运行时间', value: formatDuration(system.uptimeSeconds), meter: null },
  ];
  $('#system-stats').innerHTML = stats.map((item) => `
    <div class="stat-card">
      <div class="stat-top"><svg class="icon"><use href="#${item.icon}"/></svg>${item.label}</div>
      <div class="stat-value">${escapeHtml(item.value)}${item.sub ? `<small>${escapeHtml(item.sub)}</small>` : ''}</div>
      ${item.meter == null ? '' : `<div class="meter ${item.meter > 85 ? 'warn' : ''}"><span style="width:${Math.max(0, Math.min(100, item.meter))}%"></span></div>`}
    </div>`).join('');

  $('#autostart-toggle').checked = Boolean(S.state.power?.autostart?.enabled);
  const audit = S.state.audit || [];
  $('#audit-list').innerHTML = audit.length ? audit.slice(0, 12).map((item) => `
    <div class="audit-item">
      <time>${escapeHtml(new Date(item.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}</time>
      <span><b>${escapeHtml(AUDIT_LABELS[item.action] || item.action)}</b> ${escapeHtml(item.detail || '')}</span>
    </div>`).join('') : '<div class="empty-list">暂无记录</div>';
}

function renderVSCode() {
  const vscode = S.state?.vscode || {};
  const bridge = Boolean(vscode.bridgeInstalled);
  const ready = Boolean(vscode.bridgeReady?.ready);
  $('#bridge-badge').textContent = bridge ? (ready ? '已就绪' : '需重载') : '未安装';
  $('#bridge-badge').className = `badge ${bridge && ready ? 'ok' : 'warn'}`;
  $('#bridge-status-text').textContent = bridge
    ? (ready
      ? '扩展已就绪。可以从手机打开 Claude 面板、恢复会话或注入短指令。'
      : '扩展已安装但尚未就绪；请 Reload VS Code 一次以加载新版桥接。')
    : '未检测到桥接扩展。安装后即可从手机打开 VS Code 里的 Claude。';
  $('#bridge-warning').hidden = bridge;
  const ide = vscode.ide || {};
  $('#vscode-ide-chip').innerHTML = `<span class="status-dot ${ide.connected ? 'on' : ''}"></span><span>${ide.connected ? escapeHtml(ide.ideName || 'VS Code') : '未检测到'}</span>`;
  const official = S.state?.claude?.official || {};
  $('#official-rc-toggle').checked = Boolean(official.enabled);
  $('#official-rc-toggle-settings').checked = Boolean(official.enabled);

  const recents = vscode.recents || [];
  $('#workspaces-list').innerHTML = recents.length ? recents.map((item) => `
    <div class="workspace-item">
      <svg class="icon"><use href="#i-folder"/></svg>
      <div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.path)}</span></div>
      <button class="small-btn" data-open-path="${escapeHtml(item.path)}">打开</button>
    </div>`).join('') : '<div class="empty-list">暂无项目目录</div>';
  $$('[data-open-path]').forEach((button) => {
    button.addEventListener('click', async () => {
      setButtonBusy(button, true, '打开中…');
      try {
        await api('/api/vscode/open', { method: 'POST', body: { path: button.dataset.openPath } });
        toast('已在 VS Code 中打开');
      } catch (err) { toast(err.message, true); }
      setButtonBusy(button, false);
    });
  });
}

async function loadVSCodeWindows({ silent = false } = {}) {
  const list = $('#vscode-windows-list');
  if (!list || S.vscodeWindowsLoading) return;
  S.vscodeWindowsLoading = true;
  if (!silent) list.innerHTML = '<div class="empty-list">正在读取窗口…</div>';
  try {
    const data = await api('/api/vscode/windows');
    renderVSCodeWindows(data.windows || []);
  } catch (err) {
    if (!silent) list.innerHTML = `<div class="empty-list">读取失败：${escapeHtml(err.message)}</div>`;
  } finally {
    S.vscodeWindowsLoading = false;
  }
}

function startVSCodeWindowPolling() {
  clearInterval(S.vscodeWindowTimer);
  loadVSCodeWindows();
  S.vscodeWindowTimer = setInterval(() => {
    if (!document.hidden) loadVSCodeWindows({ silent: true });
  }, 4000);
}

function stopVSCodeWindowPolling() {
  clearInterval(S.vscodeWindowTimer);
  S.vscodeWindowTimer = null;
}

function renderVSCodeWindows(windows) {
  const list = $('#vscode-windows-list');
  if (!list) return;
  if (!windows.length) {
    list.innerHTML = '<div class="empty-list">没有检测到正在运行的 VS Code 窗口</div>';
    return;
  }
  list.innerHTML = windows.map((item) => `
    <div class="vscode-window-item">
      <span class="window-icon"><svg class="icon"><use href="#i-code"/></svg></span>
      <span class="vscode-window-main">
        <span class="vscode-window-title" title="${escapeHtml(item.title || 'VS Code')}">${escapeHtml(item.title || 'VS Code')}</span>
        <span class="vscode-window-meta">PID ${escapeHtml(String(item.pid || '—'))} · 关闭时若有未保存内容会弹出保存确认</span>
      </span>
      <button class="window-close-btn" data-close-window="${escapeHtml(String(item.id))}" data-close-title="${escapeHtml(item.title || 'VS Code')}">关闭</button>
    </div>`).join('');
  $$('[data-close-window]', list).forEach((button) => {
    button.addEventListener('click', async () => {
      const title = button.dataset.closeTitle;
      if (!confirm(`关闭这个 VS Code 窗口？\n\n${title}\n\n有未保存内容时，窗口会等待你确认保存。`)) return;
      setButtonBusy(button, true, '关闭中…');
      try {
        const data = await api(`/api/vscode/windows/${button.dataset.closeWindow}/close`, {
          method: 'POST',
          body: { confirm: '关闭' },
        });
        if (data.result?.pending) toast('窗口存在未保存内容，可能正在等待确认', true);
        else toast('VS Code 窗口已关闭');
        await loadVSCodeWindows();
      } catch (err) {
        toast(err.message, true);
        setButtonBusy(button, false);
      }
    });
  });
}

function renderSettings() {
  if (!S.state) return;
  const settings = S.state.settings || {};
  const tunnel = S.state.tunnel || {};
  const preferred = tunnel.mode && tunnel.mode !== 'off' ? tunnel.mode : (settings.tunnelMode || 'cloudflare');
  $('#tunnel-mode').value = preferred;
  $('#default-permission-mode').value = settings.permissionMode || 'default';
  if (document.activeElement !== $('#default-model')) $('#default-model').value = settings.model || '';
  if (document.activeElement !== $('#allowed-roots')) $('#allowed-roots').value = (settings.allowedRoots || []).join('\n');
  $('#allow-bypass-toggle').checked = Boolean(settings.allowBypassPermissions);
  $('#tunnel-autostart-toggle').checked = Boolean(settings.autoStartTunnel);
  $('#wake-lock-toggle').checked = S.wakeLockEnabled;
  const canKeepAwake = typeof window.NoSleep === 'function' || ('wakeLock' in navigator);
  if (!canKeepAwake) {
    $('#wake-lock-toggle').checked = false;
    $('#wake-lock-toggle').disabled = true;
    $('#wake-lock-hint').textContent = '当前浏览器不支持屏幕常亮。';
  } else if (S.wakeLockEnabled && !S.wakeLockActive) {
    $('#wake-lock-hint').textContent = '已开启；需要页面保持可见，首次触摸后重新获取。';
  }
  $('#session-count').textContent = S.state.security?.sessionCount ?? '—';
  $('#settings-host').textContent = S.state.system?.hostname || '—';
  $('#settings-port').textContent = settings.port ?? '—';
  $('#settings-autostart').textContent = S.state.power?.autostart?.enabled ? '已启用' : '未启用';
  $('#settings-sdk').textContent = S.state.claude?.sdk?.claudeCode || S.state.claude?.sdk?.sdk || '—';
  renderTunnel();
}

function renderTunnel() {
  const tunnel = S.state?.tunnel || {};
  const el = $('#tunnel-status');
  if (!el) return;
  const status = tunnel.status || 'stopped';
  if (status === 'running' && tunnel.url) {
    const label = tunnel.mode === 'tailscale'
      ? (tunnel.direct ? 'Tailscale 直连（HTTP）' : 'Tailscale Serve (HTTPS)')
      : 'Cloudflare';
    const note = tunnel.direct
      ? `Serve 未启用，当前通过 Tailscale 私有 IP 直连；仅 tailnet 内可访问，浏览器可用，但无法安装 PWA。${tunnel.enableUrl ? ` <a href="${escapeHtml(tunnel.enableUrl)}" target="_blank" rel="noopener noreferrer">启用 Serve（一次性）</a>` : ''}`
      : '地址刚生成时，DNS 可能需要 30–90 秒生效。';
    el.innerHTML = `<strong>● 运行中</strong> · ${label}<span class="url">${escapeHtml(tunnel.url)}</span><br><span class="hint">${note}</span>`;
    $('#tunnel-qr-wrap').hidden = false;
    $('#tunnel-url').textContent = tunnel.url;
    loadQr(tunnel.url);
  } else if (status === 'downloading') {
    el.innerHTML = '<strong>正在下载 cloudflared…</strong> 首次启动需要一点时间。';
    $('#tunnel-qr-wrap').hidden = true;
  } else if (status === 'starting') {
    el.innerHTML = '<strong>正在建立隧道…</strong>';
    $('#tunnel-qr-wrap').hidden = true;
  } else if (status === 'error') {
    const link = tunnel.enableUrl
      ? `<br><a href="${escapeHtml(tunnel.enableUrl)}" target="_blank" rel="noopener noreferrer">去 Tailscale 启用 Serve</a>`
      : '';
    el.innerHTML = `<strong class="danger-text">启动失败</strong><br>${escapeHtml(tunnel.error || '未知错误')}${link}`;
    $('#tunnel-qr-wrap').hidden = true;
  } else {
    el.innerHTML = '<strong>未启动</strong><br>选择方式后点击“启动隧道”。';
    $('#tunnel-qr-wrap').hidden = true;
  }
}

async function loadQr(url) {
  if (S.qrUrl === url) return;
  S.qrUrl = url;
  try {
    const data = await api('/api/tunnel/qr');
    $('#tunnel-qr').src = data.dataUrl;
  } catch {
    S.qrUrl = null;
  }
}

/* ---------------- Session / messages ---------------- */

async function loadSession(id) {
  stopHistoryPolling();
  S.messageLimit = 120;
  const data = await api(`/api/claude/sessions/${id}?limit=${S.messageLimit}`);
  if (!data.session || data.session.id !== id) {
    throw new Error('返回的会话不匹配');
  }
  S.activeSessionId = id;
  S.session = data.session;
  S.historyView = null;
  S.pluginSession = null;
  S.pluginSessionId = null;
  S.thinkingTokens = 0;
  S.currentActivity = null;
  localStorage.setItem('rd_active_session', id);
  showActive();
  $('#chat-menu-btn').hidden = false;
  $('#plugin-send-mode').hidden = true;
  $('#prompt-input').disabled = false;
  $('#send-btn').disabled = false;
  $('#prompt-input').placeholder = '给 Claude 发指令…';
  renderMessages(S.session.messages || [], { hasOlder: Boolean(S.session.hasMore) });
  renderSessionHeader();
  updateComposerState();
  renderPendingBar();
  scrollBottom(true);
  updateThinkingIndicator();
  syncQuestionsFromSession(S.session);
}

function showActive() {
  $('#chat-empty').hidden = true;
  $('#chat-active').hidden = false;
  $('#composer').hidden = false;
  $('.composer-meta').hidden = false;
  $('#history-bar').hidden = true;
}

function showEmptyChat() {
  stopHistoryPolling();
  S.activeSessionId = null;
  S.session = null;
  S.historyView = null;
  S.pluginSession = null;
  S.pluginSessionId = null;
  S.thinkingTokens = 0;
  S.currentActivity = null;
  S.currentQuestion = null;
  S.messageLimit = 120;
  S.hasOlder = false;
  if ($('#question-dialog')?.open) $('#question-dialog').close();
  hideThinkingIndicator();
  localStorage.removeItem('rd_active_session');
  $('#chat-empty').hidden = false;
  $('#chat-active').hidden = true;
  $('#plugin-send-mode').hidden = true;
  $('#prompt-input').disabled = false;
  $('#send-btn').disabled = false;
  $('#prompt-input').placeholder = '给 Claude 发指令…';
  $('#messages').innerHTML = '';
  S.rendered.clear();
  S.toolEls.clear();
  S.toolNames.clear();
  S.liveByMessage.clear();
}

async function openHistory(item) {
  const livePlugin = (S.state?.plugin?.sessions || []).find((p) => p.id === item.sessionId && p.live);
  if (livePlugin) {
    await openPluginSession(livePlugin);
    toast('该历史会话仍在运行，已打开实时发送界面');
    return;
  }
  stopHistoryPolling();
  S.activeSessionId = null;
  S.session = null;
  S.historyView = item;
  S.historySig = null;
  S.pluginSession = null;
  S.pluginSessionId = null;
  S.thinkingTokens = 0;
  S.currentActivity = null;
  hideThinkingIndicator();
  showActive();
  $('#chat-menu-btn').hidden = false;
  $('#plugin-send-mode').hidden = true;
  $('#prompt-input').disabled = false;
  $('#send-btn').disabled = false;
  $('#prompt-input').placeholder = '给 Claude 发指令…';
  $('#composer').hidden = true;
  $('#composer').hidden = true;
  $('.composer-meta').hidden = true;
  $('#history-bar').hidden = false;
  $('#chat-title').textContent = item.summary || '历史会话';
  $('#chat-sub').textContent = `${item.cwd || ''} · 只读`;
  $('#messages').innerHTML = '<div class="empty-list">正在读取历史…</div>';
  await refreshHistoryView();
  S.historyTimer = setInterval(() => refreshHistoryView().catch(() => {}), 3000);
  scrollBottom(true);
}

async function refreshHistoryView({ force = false } = {}) {
  if (!S.historyView || S.pollBusy) return;
  S.pollBusy = true;
  try {
    const query = new URLSearchParams();
    if (S.historyView.cwd) query.set('cwd', S.historyView.cwd);
    query.set('limit', '300');
    const data = await api(`/api/claude/history/${S.historyView.sessionId}?${query}`);
    if (data.sessionId !== S.historyView.sessionId) throw new Error('返回的历史会话不匹配');
    const messages = data.messages || [];
    const signature = `${messages.length}:${messages.at(-1)?.id || ''}:${messages.at(-1)?.ts || ''}`;
    if (!force && signature === S.historySig) return;
    S.historySig = signature;
    const box = $('#messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const previousTop = box.scrollTop;
    renderMessages(messages, { scroll: false });
    if (atBottom) scrollBottom(true);
    else box.scrollTop = previousTop;
    $('#chat-sub').textContent = `${data.cwd || S.historyView.cwd || ''} · 只读 · ${timeAgo(data.lastModified)}`;
  } finally {
    S.pollBusy = false;
  }
}

function stopHistoryPolling() {
  clearInterval(S.historyTimer);
  S.historyTimer = null;
}

function renderSessionHeader() {
  if (!S.session) return;
  const s = S.session;
  $('#chat-title').textContent = s.title || '会话';
  const parts = [s.cwd, s.model || '默认模型', currentModeLabel(s.permissionMode)];
  if (s.costUsd) parts.push(`$${Number(s.costUsd).toFixed(3)}`);
  $('#chat-sub').textContent = parts.filter(Boolean).join(' · ');
}

function updateComposerState() {
  if (S.pluginSessionId) {
    const live = Boolean(S.pluginSession?.live);
    $('#stop-btn').hidden = true;
    $('#send-btn').hidden = false;
    $('#send-btn').disabled = !live;
    $('#quick-interrupt').hidden = true;
    $('#plugin-open-vscode-inline').hidden = false;
    $('#plugin-resume-inline').hidden = live;
    $('#plugin-close-inline').hidden = !live;
    const mode = S.pluginMode === 'interrupt' ? '直接打断' : '微调（不打断）';
    $('#composer-status').textContent = live
      ? `跨会话消息 · ${mode} · 发送到正在运行的插件`
      : '插件会话已结束，可用“继续对话”恢复';
    return;
  }
  $('#plugin-open-vscode-inline').hidden = true;
  $('#plugin-resume-inline').hidden = true;
  $('#plugin-close-inline').hidden = true;
  const running = S.session && ['running', 'waiting_permission', 'starting'].includes(S.session.status);
  $('#stop-btn').hidden = !running;
  $('#send-btn').hidden = Boolean(running);
  $('#send-btn').disabled = false;
  $('#quick-interrupt').hidden = !running;
  const status = S.session ? (STATUS_LABELS[S.session.status] || S.session.status) : '未连接';
  $('#composer-status').textContent = `${currentModeLabel(S.session?.permissionMode)} · ${status} · 实时同步`;
}

function renderPendingBar() {
  const permissions = [...S.permissions.values()].filter((p) => !S.activeSessionId || p.sessionId === S.activeSessionId);
  const questions = [...S.questions.values()].filter((q) => !S.activeSessionId || q.sessionId === S.activeSessionId);
  const pending = permissions.length + questions.length;
  $('#pending-permission-bar').hidden = pending === 0;
  if (pending) {
    const parts = [];
    if (permissions.length) parts.push(`${permissions.length} 个操作等待批准`);
    if (questions.length) parts.push(`${questions.length} 个问题等待选择`);
    $('#pending-permission-bar').querySelector('span').textContent = parts.join(' · ');
  }
  document.title = pending ? `(${pending}) RemoteDeck` : 'RemoteDeck';
}

function syncQuestionsFromSession(session) {
  if (!session?.pendingQuestions) return;
  const active = new Set(session.pendingQuestions.map((q) => q.requestId));
  for (const question of S.questions.values()) {
    if (question.sessionId === session.id && !active.has(question.requestId)) S.questions.delete(question.requestId);
  }
  for (const question of session.pendingQuestions) {
    S.questions.set(question.requestId, { ...question, sessionId: session.id, sessionTitle: session.title });
  }
  renderPendingBar();
  if (S.activeSessionId === session.id && !S.currentQuestion && !$('#permission-dialog').open) {
    const next = [...S.questions.values()].find((q) => q.sessionId === session.id);
    if (next) showQuestion(next);
  }
}

function renderMessages(messages, { scroll = true, hasOlder = false } = {}) {
  flushDeltaBuffers();
  S.deltaBuffers.clear();
  if (S.deltaFrame) cancelAnimationFrame(S.deltaFrame);
  S.deltaFrame = 0;
  S.hasOlder = Boolean(hasOlder);
  const box = $('#messages');
  box.innerHTML = '';
  S.rendered.clear();
  S.toolEls.clear();
  S.toolNames.clear();
  S.liveByMessage.clear();
  if (!messages.length) {
    box.innerHTML = '<div class="empty-list">还没有消息。发送第一条指令吧。</div>';
    return;
  }
  if (hasOlder) {
    const button = makeEl('button', 'load-older', '加载更早的消息');
    button.type = 'button';
    button.addEventListener('click', () => {
      loadOlderMessages().catch((err) => toast(err.message, true));
    });
    box.appendChild(button);
  }
  for (const event of messages) applyClaudeEvent(event, { initial: true });
  if (scroll) scrollBottom(true);
}

async function loadOlderMessages() {
  if (S.loadingOlder || !S.hasOlder) return;
  if (S.messageLimit >= 1000) {
    toast('已加载最近 1000 条消息');
    return;
  }
  const pluginId = S.pluginSessionId;
  const sessionId = S.activeSessionId;
  const box = $('#messages');
  const oldHeight = box.scrollHeight;
  const oldTop = box.scrollTop;
  const wasAtBottom = oldHeight - oldTop - box.clientHeight < 40;
  S.loadingOlder = true;
  S.messageLimit = Math.min(1000, S.messageLimit + 120);
  try {
    if (pluginId) {
      const data = await api(`/api/claude/plugin/sessions/${pluginId}?limit=${S.messageLimit}`);
      if (S.pluginSessionId !== pluginId) return;
      if (data.session) S.pluginSession = { ...(S.pluginSession || {}), ...data.session };
      renderMessages(data.messages || [], { scroll: false, hasOlder: Boolean(data.session?.hasMore || data.hasMore) });
      updatePluginHeader();
      updateComposerState();
      updateThinkingIndicator();
    } else if (sessionId) {
      const data = await api(`/api/claude/sessions/${sessionId}?limit=${S.messageLimit}`);
      if (S.activeSessionId !== sessionId) return;
      S.session = data.session;
      renderSessionHeader();
      renderMessages(data.session.messages || [], { scroll: false, hasOlder: Boolean(data.session.hasMore) });
      updateComposerState();
      updateThinkingIndicator();
      syncQuestionsFromSession(data.session);
    } else {
      return;
    }
    box.scrollTop = wasAtBottom ? box.scrollHeight : oldTop + (box.scrollHeight - oldHeight);
  } finally {
    S.loadingOlder = false;
  }
}

function flushDeltaBuffers() {
  S.deltaFrame = 0;
  if (!S.deltaBuffers.size) return;
  for (const [messageId, text] of S.deltaBuffers) {
    let live = S.liveByMessage.get(messageId);
    if (!live) {
      live = makeEl('div', 'msg assistant');
      live.dataset.messageId = messageId;
      const bubble = makeEl('div', 'bubble live');
      live.appendChild(bubble);
      appendMessage(live);
      S.liveByMessage.set(messageId, live);
    }
    const bubble = live.querySelector('.bubble');
    bubble.textContent += text;
  }
  S.deltaBuffers.clear();
  if (S.autoScroll) {
    const box = $('#messages');
    box.scrollTop = box.scrollHeight;
  }
}

function queueDelta(messageId, text) {
  if (!messageId || !text) return;
  S.deltaBuffers.set(messageId, (S.deltaBuffers.get(messageId) || '') + text);
  if (!S.deltaFrame) S.deltaFrame = requestAnimationFrame(flushDeltaBuffers);
}

function appendMessage(el) {
  const box = $('#messages');
  const empty = box.querySelector('.empty-list');
  if (empty) empty.remove();
  box.appendChild(el);
}

function makeEl(tag, className, html = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (html) el.innerHTML = html;
  return el;
}

function renderEditDiff(event) {
  const diff = buildEditDiff(event.name, event.input || {});
  if (!diff) return '<div class="diff-empty">没有可显示的差异</div>';
  const rows = diff.lines.map((line) => {
    if (line.type === 'sep') return `<div class="diff-line sep"><span class="diff-sign"></span><span>${escapeHtml(line.text)}</span></div>`;
    const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
    return `<div class="diff-line ${line.type}"><span class="diff-sign">${sign}</span><span>${escapeHtml(line.text || ' ')}</span></div>`;
  }).join('');
  const note = diff.truncated ? '<div class="diff-more">差异较长，仅显示前一部分</div>' : '';
  return `
    <div class="diff-summary"><span class="diff-stat add">+${diff.adds}</span><span class="diff-stat del">−${diff.dels}</span></div>
    <div class="diff-body">${rows}${note}</div>`;
}

function applyClaudeEvent(event, { initial = false } = {}) {
  if (!event || !event.event) return;
  if (event.event !== 'delta') flushDeltaBuffers();
  if (!initial) {
    if (event.event === 'user') {
      S.thinkingTokens = 0;
      S.thinkingEstimated = true;
      S.currentActivity = 'thinking';
    } else if (event.event === 'delta') {
      S.currentActivity = 'writing';
    } else if (event.event === 'thinking') {
      S.thinkingTokens = Number(event.tokens) || 0;
      S.thinkingEstimated = event.estimated !== false;
      S.currentActivity = 'thinking';
    } else if (event.event === 'tool_use') {
      S.currentActivity = 'tool';
    } else if (event.event === 'tool_result') {
      S.currentActivity = 'thinking';
    } else if (event.event === 'assistant') {
      S.currentActivity = 'writing';
    } else if (event.event === 'result') {
      S.currentActivity = null;
    }
    updateThinkingIndicator();
  }
  if (event.event === 'delta') {
    queueDelta(event.messageId, event.text || '');
    return;
  }

  if (event.id && S.rendered.has(event.id) && event.event !== 'tool_result' && event.event !== 'tool_progress') {
    return;
  }

  if (event.event === 'user') {
    const el = makeEl('div', 'msg user');
    const phone = event.source === 'phone';
    el.innerHTML = `<div class="bubble"><span class="msg-badge ${phone ? 'phone' : ''}">${phone ? '手机' : '你'}</span>${escapeHtml(event.text || '')}</div><div class="msg-time">${clockTime(event.ts)}</div>`;
    appendMessage(el);
    S.rendered.set(event.id, el);
  } else if (event.event === 'assistant') {
    const live = S.liveByMessage.get(event.messageId);
    if (live) {
      const bubble = live.querySelector('.bubble');
      bubble.classList.remove('live');
      bubble.innerHTML = markdown(event.text || '');
      S.liveByMessage.delete(event.messageId);
      S.rendered.set(event.id, live);
    } else {
      const el = makeEl('div', 'msg assistant');
      el.innerHTML = `<div class="bubble">${markdown(event.text || '')}</div><div class="msg-time">${clockTime(event.ts)}</div>`;
      appendMessage(el);
      S.rendered.set(event.id, el);
    }
  } else if (event.event === 'thinking') {
    const el = makeEl('div', 'msg assistant');
    const tokens = Number(event.tokens) || 0;
    const tokenLabel = tokens ? `${event.estimated ? '约 ' : ''}${formatTokenCount(tokens)} tokens` : '';
    el.innerHTML = `
      <div class="thinking-card done">
        <svg class="icon"><use href="#i-spark"/></svg>
        <span class="thinking-label">${event.redacted ? '思考内容已加密' : '思考完成'}</span>
        ${tokenLabel ? `<span class="thinking-tokens">${escapeHtml(tokenLabel)}</span>` : ''}
      </div>`;
    appendMessage(el);
    S.rendered.set(event.id, el);
  } else if (event.event === 'tool_use') {
    const el = makeEl('div', 'msg assistant');
    const title = event.title || '';
    const isEdit = event.name === 'Edit' || event.name === 'MultiEdit';
    const input = isEdit ? '' : JSON.stringify(event.input || {}, null, 2);
    const body = isEdit
      ? renderEditDiff(event)
      : `<details class="tool-body"><summary>查看参数</summary><pre>${escapeHtml(input)}</pre></details>`;
    el.innerHTML = `
      <div class="tool-card ${isEdit ? 'edit-card' : ''}" data-tool-id="${escapeHtml(event.toolUseId || '')}">
        <div class="tool-head">
          <span class="tool-icon"><svg class="icon"><use href="#i-tool"/></svg></span>
          <span class="tool-main"><span class="tool-name" title="${escapeHtml(event.name || 'Tool')}">${escapeHtml(event.name || 'Tool')}</span><span class="tool-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span></span>
          <span class="tool-status">运行中</span>
        </div>
        ${body}
      </div>`;
    appendMessage(el);
    S.rendered.set(event.id, el);
    S.toolEls.set(event.toolUseId, el);
    S.toolNames.set(event.toolUseId, event.name || 'Tool');
  } else if (event.event === 'tool_result') {
    const el = S.toolEls.get(event.toolUseId) || [...S.toolEls.entries()].find(([id]) => id === event.toolUseId)?.[1];
    if (el) {
      const status = el.querySelector('.tool-status');
      status.textContent = event.isError ? '失败' : '完成';
      status.className = `tool-status ${event.isError ? 'error' : 'done'}`;
      const toolName = S.toolNames.get(event.toolUseId) || '';
      const isEdit = toolName === 'Edit' || toolName === 'MultiEdit';
      if (isEdit && !event.isError) return;
      const card = el.querySelector('.tool-card');
      let result = card.querySelector('.tool-result');
      if (!result) {
        result = document.createElement('div');
        result.className = 'tool-result';
        card.appendChild(result);
      }
      result.innerHTML = `<div class="result-label">${event.isError ? '错误输出' : '结果'}</div><pre>${escapeHtml(String(event.text || '').slice(0, 12_000))}</pre>`;
    } else {
      const chip = makeEl('div', `chip ${event.isError ? 'err' : ''}`, `<svg class="icon"><use href="#i-tool"/></svg>${escapeHtml(String(event.text || '').slice(0, 180))}`);
      appendMessage(chip);
    }
  } else if (event.event === 'status' || event.event === 'system') {
    const text = String(event.text || '');
    const important = /中断|停止|错误|失败|压缩|权限|超时|重试|速率|完成/.test(text);
    if (event.event === 'system' || important || event.level === 'warn') {
      const chip = makeEl('div', `msg system chip ${event.level === 'warn' ? 'warn' : ''}`, `<svg class="icon"><use href="#i-spark"/></svg>${escapeHtml(text)}`);
      appendMessage(chip);
      S.rendered.set(event.id, chip);
    }
    if (text) $('#composer-status').textContent = text;
    if (/中断|停止/.test(text)) {
      if (S.session) S.session.status = 'idle';
      updateComposerState();
      renderSessionHeader();
    }
  } else if (event.event === 'result') {
    const parts = [];
    parts.push(event.isError ? `<span class="err">失败</span>` : '完成');
    if (event.durationMs) parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);
    if (event.costUsd) parts.push(`$${Number(event.costUsd).toFixed(3)}`);
    const el = makeEl('div', 'result-line', parts.join(' · '));
    appendMessage(el);
    if (S.session) {
      S.session.status = event.isError ? 'error' : 'idle';
      if (event.costUsd) S.session.costUsd = event.costUsd;
      updateComposerState();
      renderSessionHeader();
    }
    S.rendered.set(event.id, el);
  } else if (event.event === 'error') {
    const el = makeEl('div', 'msg system chip err', `<svg class="icon"><use href="#i-alert"/></svg>${escapeHtml(event.text || '错误')}`);
    appendMessage(el);
    if (S.session) S.session.status = 'error';
    updateComposerState();
    S.rendered.set(event.id, el);
  } else if (event.event === 'rate_limit') {
    appendMessage(makeEl('div', 'msg system chip warn', `<svg class="icon"><use href="#i-alert"/></svg>速率限制：${escapeHtml(event.status || '')}`));
  } else if (event.event === 'tool_progress') {
    const el = S.toolEls.get(event.toolUseId);
    if (el) {
      const status = el.querySelector('.tool-status');
      if (status && status.textContent === '运行中') status.textContent = `运行中 ${Math.round(event.elapsedSeconds || 0)}s`;
    }
  } else if (event.event === 'tool_summary') {
    const el = S.toolEls.get(event.toolUseId);
    if (el && event.summary) {
      const title = el.querySelector('.tool-title');
      if (title && event.summary) {
        title.textContent = event.summary;
        title.title = event.summary;
      }
    }
  }

  if (S.autoScroll && !initial) scrollBottom();
}

function scrollBottom(force = false) {
  const box = $('#messages');
  if (!box) return;
  if (force || S.autoScroll) {
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }
}

/* ---------------- Permission ---------------- */

function showPermission(permission) {
  if (!permission || $('#permission-dialog').open) return;
  S.currentPermission = permission;
  $('#permission-tool-name').textContent = permission.toolName || 'Tool';
  $('#permission-title').textContent = permission.title || 'Claude 想执行一个操作。';
  $('#permission-desc').textContent = permission.description || '';
  $('#permission-input').textContent = JSON.stringify(permission.input || {}, null, 2);
  $('#permission-always').hidden = !permission.canAlwaysAllow;
  $('#permission-dialog').showModal();
}

function hidePermissionDialog() {
  S.currentPermission = null;
  const dialog = $('#permission-dialog');
  if (dialog.open) dialog.close();
}

async function resolveCurrentPermission(decision, always = false) {
  const permission = S.currentPermission;
  if (!permission) return;
  try {
    await api(`/api/claude/sessions/${permission.sessionId}/permission`, {
      method: 'POST',
      body: { requestId: permission.requestId, decision, always },
    });
    S.permissions.delete(permission.requestId);
    hidePermissionDialog();
    renderPendingBar();
    toast(decision === 'allow' ? '已允许' : '已拒绝');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- AskUserQuestion ---------------- */

function showQuestion(question) {
  if (!question || $('#question-dialog').open || $('#permission-dialog').open) return;
  S.currentQuestion = question;
  $('#question-error').textContent = '';
  const list = $('#question-list');
  list.innerHTML = question.questions.map((item, questionIndex) => {
    const type = item.multiSelect ? 'checkbox' : 'radio';
    const name = `question-${question.requestId}-${questionIndex}`;
    const options = item.options.map((option, optionIndex) => `
      <label class="question-option">
        <input type="${type}" name="${escapeHtml(name)}" value="${escapeHtml(option.label)}" data-question-option="${questionIndex}">
        <span>${escapeHtml(option.label)}${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}</span>
      </label>`).join('');
    return `
      <div class="question-block" data-question-index="${questionIndex}">
        ${item.header ? `<div class="question-header">${escapeHtml(item.header)}</div>` : ''}
        <div class="question-title">${escapeHtml(item.question)}</div>
        <div class="question-options">
          ${options}
          <label class="question-option">
            <input type="${type}" name="${escapeHtml(name)}" value="__other__" data-question-option="${questionIndex}" data-other-option="${questionIndex}">
            <span>其他<small>输入自定义答案</small></span>
          </label>
        </div>
        <input class="question-other-input" data-other-input="${questionIndex}" placeholder="输入自定义答案…" autocomplete="off">
      </div>`;
  }).join('');
  list.querySelectorAll('[data-other-input]').forEach((input) => {
    input.addEventListener('input', () => {
      if (!input.value.trim()) return;
      const option = list.querySelector(`[data-other-option="${input.dataset.otherInput}"]`);
      if (option) option.checked = true;
    });
  });
  $('#question-dialog').showModal();
}

async function submitQuestion() {
  const question = S.currentQuestion;
  if (!question) return;
  const error = $('#question-error');
  error.textContent = '';
  const answers = {};
  for (let index = 0; index < question.questions.length; index += 1) {
    const item = question.questions[index];
    const block = $(`[data-question-index="${index}"]`, $('#question-list'));
    const checked = [...block.querySelectorAll('input[data-question-option]:checked')];
    if (!checked.length) {
      error.textContent = `请先回答：${item.header || item.question}`;
      return;
    }
    const values = [];
    for (const input of checked) {
      if (input.value === '__other__') {
        const custom = block.querySelector('[data-other-input]')?.value.trim();
        if (!custom) {
          error.textContent = `请填写「${item.header || item.question}」的自定义答案`;
          return;
        }
        values.push(custom);
      } else {
        values.push(input.value);
      }
    }
    answers[item.question] = values.join(', ');
  }
  const button = $('#question-submit');
  setButtonBusy(button, true, '提交中…');
  try {
    await api(`/api/claude/sessions/${question.sessionId}/question`, {
      method: 'POST',
      body: { requestId: question.requestId, answers },
    });
    S.questions.delete(question.requestId);
    S.currentQuestion = null;
    $('#question-dialog').close();
    renderPendingBar();
    toast('已提交选择');
  } catch (err) {
    error.textContent = err.message;
  } finally {
    setButtonBusy(button, false);
  }
}

async function skipQuestion() {
  const question = S.currentQuestion;
  if (!question) return;
  S.currentQuestion = null;
  $('#question-dialog').close();
  try {
    await api(`/api/claude/sessions/${question.sessionId}/question`, {
      method: 'POST',
      body: { requestId: question.requestId, cancel: true },
    });
    S.questions.delete(question.requestId);
    toast('已跳过问题');
  } catch (err) {
    toast(err.message, true);
  }
  renderPendingBar();
}

/* ---------------- Actions ---------------- */

async function startSession() {
  const customRow = $('#custom-workspace-row');
  let cwd = $('#workspace-select').value;
  if (!customRow.hidden) cwd = $('#custom-workspace').value.trim();
  if (!cwd) {
    toast('请选择或填写工作目录', true);
    return;
  }
  const button = $('#start-session-btn');
  setButtonBusy(button, true, '启动中…');
  try {
    const data = await api('/api/claude/sessions', {
      method: 'POST',
      body: {
        cwd,
        permissionMode: $('#permission-mode').value,
        model: $('#model-input').value.trim() || undefined,
      },
    });
    await loadSession(data.session.id);
    await refreshState({ silent: true });
  } catch (err) {
    toast(err.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function sendPrompt() {
  const input = $('#prompt-input');
  const text = input.value.trim();
  if (!text) return;
  if (S.pluginSessionId) {
    if (!S.pluginSession?.live) {
      toast('插件会话已结束，请先点“继续对话”恢复', true);
      return;
    }
    const mode = S.pluginMode === 'interrupt' ? 'interrupt' : 'nudge';
    try {
      await api(`/api/claude/plugin/sessions/${S.pluginSessionId}/message`, {
        method: 'POST',
        body: { text, mode },
      });
      input.value = '';
      input.style.height = 'auto';
      if (S.pluginSession) S.pluginSession.status = 'running';
      S.thinkingTokens = 0;
      S.currentActivity = 'thinking';
      updateThinkingIndicator();
      toast(mode === 'interrupt' ? '已请求打断并发送' : '已发送微调，Claude 会在下一个工具/回合读取');
      scrollBottom(true);
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  if (!S.activeSessionId) return;
  input.value = '';
  input.style.height = 'auto';
  try {
    await api(`/api/claude/sessions/${S.activeSessionId}/prompt`, { method: 'POST', body: { text } });
    if (S.session) S.session.status = 'running';
    S.thinkingTokens = 0;
    S.currentActivity = 'thinking';
    updateThinkingIndicator();
    updateComposerState();
    scrollBottom(true);
  } catch (err) {
    toast(err.message, true);
    input.value = text;
  }
}

async function interruptSession() {
  if (!S.activeSessionId) return;
  try {
    await api(`/api/claude/sessions/${S.activeSessionId}/interrupt`, { method: 'POST', body: {} });
    toast('已中断当前任务');
  } catch (err) { toast(err.message, true); }
}

async function stopSession() {
  if (!S.activeSessionId) return;
  if (!confirm('停止并关闭这个会话？当前正在运行的任务会被中断。')) return;
  try {
    await api(`/api/claude/sessions/${S.activeSessionId}/stop`, { method: 'POST', body: {} });
    toast('会话已停止');
    showEmptyChat();
    await refreshState({ silent: true });
  } catch (err) { toast(err.message, true); }
}

async function continueHistory(item, { fork = false } = {}) {
  if (!item) return;
  if (S.continueBusy) return;
  if (item.activeId) {
    await loadSession(item.activeId);
    return;
  }
  const livePlugin = (S.state?.plugin?.sessions || []).find((p) => p.id === item.sessionId && p.live);
  if (livePlugin) {
    await openPluginSession(livePlugin);
    toast('已进入插件对话，可以直接发送消息');
    return;
  }
  if (!fork && S.state?.vscode?.bridgeInstalled) {
    S.continueBusy = true;
    showLaunchOverlay('正在启动 VS Code…', '正在检查窗口并恢复会话，请稍候');
    try {
      const opened = await api('/api/vscode/open-session', {
        method: 'POST',
        body: { sessionId: item.sessionId, cwd: item.cwd },
      });
      stopHistoryPolling();
      showEmptyChat();
      updateLaunchOverlay(
        opened.alreadyRunning ? '正在定位到运行中的会话…' : '正在恢复会话…',
        opened.launched
          ? 'VS Code 已启动，正在等待 Claude Code 会话就绪'
          : '已找到 VS Code 窗口，正在打开对应会话',
      );
      const live = await waitForPluginSession(item.sessionId, 15);
      hideLaunchOverlay();
      S.continueBusy = false;
      if (live) toast('会话已在 VS Code 中恢复，可以继续发送');
      else toast('VS Code 已打开，会话可能仍在加载，稍后刷新即可', true);
      return;
    } catch (err) {
      hideLaunchOverlay();
      S.continueBusy = false;
      toast(`VS Code 自动恢复失败：${err.message}；改用 RemoteDeck 会话`, true);
    }
  }
  S.continueBusy = true;
  showLaunchOverlay(
    fork ? '正在创建副本…' : '正在启动会话…',
    fork ? '正在复制历史对话' : '正在通过 RemoteDeck 恢复原会话',
  );
  try {
    const data = await api(`/api/claude/history/${item.sessionId}/resume`, {
      method: 'POST',
      body: { cwd: item.cwd, forkSession: fork },
    });
    stopHistoryPolling();
    S.historyView = null;
    await loadSession(data.session.id);
    await refreshState({ silent: true });
    if (!fork && S.session?.sdkSessionId && S.session.sdkSessionId !== item.sessionId) {
      toast('原会话仍被其他进程占用，Claude Code 自动创建了副本', true);
    } else {
      toast(fork ? '已创建副本，可以继续对话' : '已继续原对话，可以发送消息');
    }
    if (!fork) {
      setTimeout(async () => {
        await refreshState({ silent: true });
        if (S.activeSessionId === data.session.id && S.session?.sdkSessionId && S.session.sdkSessionId !== item.sessionId) {
          toast('提示：该会话被其他进程占用，Claude Code 已改为副本', true);
        }
      }, 2500);
    }
  } finally {
    hideLaunchOverlay();
    S.continueBusy = false;
  }
}

async function resumeHistory() {
  if (!S.historyView) return;
  try {
    await continueHistory(S.historyView, { fork: false });
  } catch (err) { toast(err.message, true); }
}

async function forkHistory() {
  if (!S.historyView) return;
  try {
    await continueHistory(S.historyView, { fork: true });
  } catch (err) { toast(err.message, true); }
}

async function confirmPluginClose() {
  if (!S.pluginSessionId || !S.pluginSession?.live) return;
  const typed = $('#plugin-close-confirm-input').value.trim();
  if (typed !== '关闭') {
    $('#plugin-close-error').textContent = '请输入“关闭”以确认';
    return;
  }
  const button = $('#plugin-close-confirm-btn');
  setButtonBusy(button, true, '关闭中…');
  try {
    await api(`/api/claude/plugin/sessions/${S.pluginSessionId}/close`, {
      method: 'POST',
      body: { confirm: typed },
    });
    $('#plugin-close-dialog').close();
    showEmptyChat();
    toast('插件会话已关闭');
    await refreshState({ silent: true });
  } catch (err) {
    $('#plugin-close-error').textContent = err.message;
  } finally {
    setButtonBusy(button, false);
  }
}

async function openPowerDialog(action) {
  const info = POWER_LABELS[action];
  if (!info) return;
  S.powerAction = action;
  $('#power-dialog-title').textContent = info.title;
  $('#power-dialog-desc').textContent = info.desc;
  $('#power-confirm-word').textContent = info.word;
  $('#power-confirm-input').value = '';
  $('#power-error').textContent = '';
  $('#power-delay-row').hidden = ['lock', 'sleep', 'cancel'].includes(action);
  $('#power-confirm-btn').classList.toggle('danger', info.danger);
  $('#power-dialog').showModal();
  setTimeout(() => $('#power-confirm-input').focus(), 100);
}

async function confirmPower() {
  if (!S.powerAction) return;
  const word = POWER_LABELS[S.powerAction].word;
  const typed = $('#power-confirm-input').value.trim();
  if (typed !== word) {
    $('#power-error').textContent = `请输入“${word}”以确认`;
    return;
  }
  const button = $('#power-confirm-btn');
  setButtonBusy(button, true, '执行中…');
  try {
    await api('/api/power', {
      method: 'POST',
      body: {
        action: S.powerAction,
        confirm: typed,
        delaySeconds: Number($('#power-delay').value) || 0,
      },
    });
    $('#power-dialog').close();
    toast(`${POWER_LABELS[S.powerAction].title}指令已发送`);
  } catch (err) {
    $('#power-error').textContent = err.message;
  } finally {
    setButtonBusy(button, false);
    S.powerAction = null;
  }
}

async function toggleAutostart(enabled) {
  try {
    const data = await api('/api/autostart', { method: 'POST', body: { enabled } });
    S.state.power.autostart.enabled = data.enabled;
    renderPower();
    renderSettings();
    toast(data.enabled ? '已启用开机自启动' : '已关闭开机自启动');
  } catch (err) {
    toast(err.message, true);
    renderPower();
  }
}

async function saveSettings(patch, options = {}) {
  try {
    const data = await api('/api/settings', { method: 'POST', body: { ...patch, ...(options.confirm ? { confirm: options.confirm } : {}) } });
    S.state.settings = data.settings;
    renderChatEmpty();
    renderSettings();
    toast('设置已保存');
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

async function startTunnel() {
  const mode = $('#tunnel-mode').value;
  if (mode === 'off') {
    toast('请先选择 Cloudflare 或 Tailscale，再启动隧道', true);
    return;
  }
  const button = $('#tunnel-start-btn');
  setButtonBusy(button, true, '启动中…');
  try {
    const data = await api('/api/tunnel/start', { method: 'POST', body: { mode }, timeout: 260_000 });
    S.state.tunnel = data.tunnel;
    S.qrUrl = null;
    renderTunnel();
    renderRemotePill();
    if (data.tunnel.status === 'running') {
      if (data.tunnel.direct) toast('已启用 Tailscale 直连（Serve 未启用，仅 tailnet 内 HTTP）');
      else toast('远程访问已启动');
    } else {
      toast(data.tunnel.error || '隧道未启动', true);
    }
  } catch (err) {
    toast(err.message, true);
    await refreshState({ silent: true });
  } finally {
    setButtonBusy(button, false);
  }
}

async function stopTunnel() {
  const button = $('#tunnel-stop-btn');
  setButtonBusy(button, true, '停止中…');
  try {
    const data = await api('/api/tunnel/stop', { method: 'POST', body: {} });
    S.state.tunnel = data.tunnel;
    S.qrUrl = null;
    renderTunnel();
    renderRemotePill();
    toast('隧道已停止');
  } catch (err) { toast(err.message, true); }
  finally { setButtonBusy(button, false); }
}

async function setOfficialRemote(enabled) {
  try {
    const status = await api('/api/claude/official', { method: 'POST', body: { enabled } });
    S.state.claude.official = status;
    $('#official-rc-toggle').checked = Boolean(status.enabled);
    $('#official-rc-toggle-settings').checked = Boolean(status.enabled);
    toast(status.enabled ? '官方 Remote Control 已自动开启' : '已关闭官方 Remote Control');
  } catch (err) {
    toast(err.message, true);
    await refreshState({ silent: true });
  }
}

/* ---------------- Events ---------------- */

function bindEvents() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.tab)));
  $$('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = document.getElementById(button.dataset.closeDialog);
      if (dialog?.open) dialog.close();
    });
  });
  $$('dialog.sheet').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  $$('.reveal').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.target);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.innerHTML = `<svg class="icon"><use href="#${show ? 'i-eye-off' : 'i-eye'}"/></svg>`;
    });
  });

  $('#login-form').addEventListener('submit', onLogin);
  $('#setup-form').addEventListener('submit', onSetup);
  $('#setup-password').addEventListener('input', updateStrength);
  $('#refresh-btn').addEventListener('click', async () => {
    await refreshState();
    toast('已刷新');
  });

  $('#workspace-select').addEventListener('change', () => {
    $('#custom-workspace-row').hidden = true;
  });
  $('#custom-workspace-btn').addEventListener('click', () => {
    const row = $('#custom-workspace-row');
    row.hidden = !row.hidden;
    if (!row.hidden) $('#custom-workspace').focus();
  });
  $('#model-input').addEventListener('input', () => { $('#model-input').dataset.touched = '1'; });
  $('#start-session-btn').addEventListener('click', startSession);
  $('#show-all-history-btn').addEventListener('click', () => {
    toggleAllHistory().catch((err) => toast(err.message, true));
  });
  $('#refresh-history-btn').addEventListener('click', async () => {
    if (S.historyShowAll) {
      S.historyShowAll = false;
      await toggleAllHistory(true);
      toast('全部记录已刷新');
      return;
    }
    await refreshState();
    toast('历史已刷新');
  });
  $('#back-to-sessions').addEventListener('click', showEmptyChat);
  $('#chat-menu-btn').addEventListener('click', () => $('#session-menu-dialog').showModal());

  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    sendPrompt();
  });
  $('#prompt-input').addEventListener('input', (event) => {
    const el = event.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  });
  $('#prompt-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendPrompt();
    }
  });
  $('#stop-btn').addEventListener('click', interruptSession);
  $('#quick-interrupt').addEventListener('click', interruptSession);
  $('#menu-interrupt').addEventListener('click', () => { $('#session-menu-dialog').close(); interruptSession(); });
  $('#menu-refresh').addEventListener('click', async () => {
    $('#session-menu-dialog').close();
    if (S.activeSessionId) await loadSession(S.activeSessionId);
    toast('已同步');
  });
  $('#menu-stop').addEventListener('click', () => { $('#session-menu-dialog').close(); stopSession(); });
  $('#resume-history-btn').addEventListener('click', resumeHistory);
  $('#fork-history-btn').addEventListener('click', forkHistory);
  $('#plugin-open-vscode-inline').addEventListener('click', () => openClaudePanel('panel'));
  $('#plugin-resume-inline').addEventListener('click', () => {
    if (!S.pluginSession) return;
    continueHistory({
      sessionId: S.pluginSession.id,
      cwd: S.pluginSession.cwd,
      summary: S.pluginSession.title,
    }, { fork: false }).catch((err) => toast(err.message, true));
  });
  $('#plugin-close-inline').addEventListener('click', () => {
    if (!S.pluginSession?.live) return;
    $('#plugin-close-confirm-input').value = '';
    $('#plugin-close-error').textContent = '';
    $('#plugin-close-dialog').showModal();
    setTimeout(() => $('#plugin-close-confirm-input').focus(), 100);
  });
  $('#plugin-close-confirm-btn').addEventListener('click', confirmPluginClose);
  $$('#plugin-send-mode [data-plugin-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      S.pluginMode = button.dataset.pluginMode === 'interrupt' ? 'interrupt' : 'nudge';
      $$('#plugin-send-mode [data-plugin-mode]').forEach((b) => b.classList.toggle('active', b === button));
      updateComposerState();
    });
  });

  $('#messages').addEventListener('scroll', () => {
    const box = $('#messages');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    S.autoScroll = near;
    $('#jump-bottom').hidden = near;
  });
  $('#jump-bottom').addEventListener('click', () => { S.autoScroll = true; scrollBottom(true); $('#jump-bottom').hidden = true; });

  $('#permission-allow').addEventListener('click', () => resolveCurrentPermission('allow', false));
  $('#permission-always').addEventListener('click', () => resolveCurrentPermission('allow', true));
  $('#permission-deny').addEventListener('click', () => resolveCurrentPermission('deny', false));
  $('#question-submit').addEventListener('click', () => submitQuestion().catch((err) => toast(err.message, true)));
  $('#question-cancel').addEventListener('click', () => skipQuestion().catch((err) => toast(err.message, true)));
  $('#question-dialog').addEventListener('close', () => {
    if (!S.currentQuestion) return;
    const question = S.currentQuestion;
    S.currentQuestion = null;
    void api(`/api/claude/sessions/${question.sessionId}/question`, {
      method: 'POST',
      body: { requestId: question.requestId, cancel: true },
    }).catch(() => {});
    S.questions.delete(question.requestId);
    renderPendingBar();
  });
  $('#review-permission-btn').addEventListener('click', () => {
    const question = [...S.questions.values()].find((q) => q.sessionId === S.activeSessionId);
    if (question) {
      showQuestion(question);
      return;
    }
    const first = [...S.permissions.values()].find((p) => p.sessionId === S.activeSessionId);
    if (first) showPermission(first);
  });

  $$('[data-power]').forEach((button) => button.addEventListener('click', () => openPowerDialog(button.dataset.power)));
  $('#power-confirm-btn').addEventListener('click', confirmPower);
  $('#autostart-toggle').addEventListener('change', (event) => toggleAutostart(event.target.checked));
  $('#wake-lock-toggle').addEventListener('change', (event) => setWakeLock(event.target.checked));

  $('#open-claude-panel-btn').addEventListener('click', () => openClaudePanel('panel'));
  $('#open-claude-terminal-btn').addEventListener('click', () => openClaudePanel('terminal'));
  $('#refresh-vscode-windows').addEventListener('click', () => loadVSCodeWindows());
  $('#vscode-prompt-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('#vscode-prompt').value.trim();
    if (!text) return;
    const button = $('#vscode-send-btn');
    setButtonBusy(button, true, '发送中…');
    try {
      await api('/api/vscode/prompt', { method: 'POST', body: { text } });
      $('#vscode-prompt').value = '';
      toast('已发送到 VS Code 的 Claude');
    } catch (err) { toast(err.message, true); }
    finally { setButtonBusy(button, false); }
  });
  $('#official-rc-toggle').addEventListener('change', (event) => setOfficialRemote(event.target.checked));
  $('#official-rc-toggle-settings').addEventListener('change', (event) => setOfficialRemote(event.target.checked));

  $('#tunnel-start-btn').addEventListener('click', startTunnel);
  $('#tunnel-stop-btn').addEventListener('click', stopTunnel);
  $('#tunnel-mode').addEventListener('change', (event) => saveSettings({ tunnelMode: event.target.value }));
  $('#tunnel-autostart-toggle').addEventListener('change', (event) => saveSettings({ autoStartTunnel: event.target.checked }));
  $('#copy-tunnel-btn').addEventListener('click', async () => {
    const url = S.state?.tunnel?.url;
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast('地址已复制'); }
    catch { toast(url); }
  });

  $('#default-permission-mode').addEventListener('change', (event) => saveSettings({ permissionMode: event.target.value }));
  $('#default-model').addEventListener('change', (event) => saveSettings({ model: event.target.value.trim() }));
  $('#save-roots-btn').addEventListener('click', async () => {
    const roots = $('#allowed-roots').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!roots.length) { toast('至少保留一个根目录', true); return; }
    await saveSettings({ allowedRoots: roots });
  });
  $('#allow-bypass-toggle').addEventListener('change', async (event) => {
    if (event.target.checked) {
      const ok = confirm('高风险：启用后 Claude 可以执行任意命令而不再请求批准。确定启用？');
      if (!ok) { event.target.checked = false; return; }
      const saved = await saveSettings({ allowBypassPermissions: true }, { confirm: '允许' });
      if (!saved) event.target.checked = false;
    } else {
      await saveSettings({ allowBypassPermissions: false });
    }
  });

  $('#change-password-btn').addEventListener('click', () => {
    $('#password-current').value = '';
    $('#password-new').value = '';
    $('#password-confirm').value = '';
    $('#password-error').textContent = '';
    $('#password-dialog').showModal();
  });
  $('#password-save-btn').addEventListener('click', changePassword);
  $('#logout-btn').addEventListener('click', logout);
  $('#install-autostart-btn').addEventListener('click', () => toggleAutostart(true));
  $('#remove-autostart-btn').addEventListener('click', () => toggleAutostart(false));
}

async function onLogin(event) {
  event.preventDefault();
  const button = $('#login-submit');
  const error = $('#login-error');
  error.textContent = '';
  setButtonBusy(button, true, '验证中…');
  try {
    const data = await api('/api/login', { method: 'POST', body: { password: $('#login-password').value } });
    S.csrf = data.csrf || '';
    const state = await fetchState();
    if (!state.authenticated) throw new Error('登录状态异常，请重试');
    $('#login-password').value = '';
    enterApp(state);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    setButtonBusy(button, false);
  }
}

async function onSetup(event) {
  event.preventDefault();
  const error = $('#setup-error');
  error.textContent = '';
  const password = $('#setup-password').value;
  const confirm = $('#setup-confirm').value;
  if (password.length < 10) { error.textContent = '密码至少需要 10 个字符'; return; }
  if (password !== confirm) { error.textContent = '两次输入的密码不一致'; return; }
  const button = $('#setup-submit');
  setButtonBusy(button, true, '创建中…');
  try {
    const data = await api('/api/setup', { method: 'POST', body: { password, confirm } });
    S.csrf = data.csrf || '';
    const state = await fetchState();
    enterApp(state);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    setButtonBusy(button, false);
  }
}

function updateStrength() {
  const value = $('#setup-password').value;
  let score = 0;
  if (value.length >= 10) score += 1;
  if (value.length >= 14) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/[0-9]/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;
  const bar = $('#strength-bar');
  const pct = Math.min(100, score * 20);
  bar.style.width = `${pct}%`;
  bar.style.background = pct < 40 ? 'var(--danger)' : pct < 70 ? 'var(--warn)' : 'var(--ok)';
}

async function changePassword() {
  const error = $('#password-error');
  error.textContent = '';
  const current = $('#password-current').value;
  const newPassword = $('#password-new').value;
  const confirm = $('#password-confirm').value;
  if (newPassword.length < 10) { error.textContent = '新密码至少需要 10 个字符'; return; }
  if (newPassword !== confirm) { error.textContent = '两次输入的新密码不一致'; return; }
  const button = $('#password-save-btn');
  setButtonBusy(button, true, '保存中…');
  try {
    const data = await api('/api/password', { method: 'POST', body: { current, newPassword, confirm } });
    S.csrf = data.csrf || '';
    $('#password-dialog').close();
    toast('密码已修改，请重新登录');
    showAuth('login');
  } catch (err) {
    error.textContent = err.message;
  } finally {
    setButtonBusy(button, false);
  }
}

async function logout() {
  if (!confirm('退出当前设备？')) return;
  try { await api('/api/logout', { method: 'POST', body: {} }); } catch {}
  S.state = null;
  S.csrf = '';
  showAuth('login');
}

async function openClaudePanel(mode) {
  try {
    await api('/api/vscode/claude', { method: 'POST', body: { mode } });
    toast('已在 VS Code 中打开 Claude');
  } catch (err) { toast(err.message, true); }
}

function switchView(name) {
  S.view = name;
  $$('.view').forEach((view) => { view.hidden = view.dataset.view !== name; });
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  if (name === 'settings') renderSettings();
  if (name === 'power') renderPower();
  if (name === 'vscode') {
    renderVSCode();
    startVSCodeWindowPolling();
  } else {
    stopVSCodeWindowPolling();
  }
  if (name !== 'chat') stopHistoryPolling();
  if (name === 'chat' && S.historyView) {
    // keep history view; restart polling if it was stopped
    clearInterval(S.historyTimer);
    S.historyTimer = setInterval(() => refreshHistoryView().catch(() => {}), 3000);
  }
  if (name === 'chat' && S.session) scrollBottom(true);
  if (name === 'chat') updateThinkingIndicator();
}
