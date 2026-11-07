import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { query, listSessions, getSessionMessages, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { normalizeSdkMessage, normalizeHistory, clip, toolTitle } from './normalize.js';
import { getState, audit, ROOT } from '../config.js';

const MAX_PROMPT = 20_000;
const MAX_MESSAGES = 1200;
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
const HISTORY_CACHE_MS = 10_000;

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function validateWorkspace(cwd, allowedRoots) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw Object.assign(new Error('缺少工作目录'), { status: 400 });
  const resolved = path.resolve(cwd.trim());
  let real;
  try {
    real = await fsp.realpath(resolved);
    const stat = await fsp.stat(real);
    if (!stat.isDirectory()) throw new Error('不是目录');
  } catch {
    throw Object.assign(new Error(`工作目录不存在或不可访问：${resolved}`), { status: 400 });
  }
  const roots = (allowedRoots || []).map((r) => path.resolve(r));
  if (roots.length && !roots.some((root) => isWithin(root, real))) {
    throw Object.assign(new Error('该目录不在允许的工作区范围内，请先在设置中添加允许的根目录'), { status: 403 });
  }
  return real;
}

function sessionTitle(cwd) {
  const base = path.basename(cwd) || cwd;
  return base.length > 48 ? `${base.slice(0, 47)}…` : base;
}

function sanitizeForUi(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return clip(value, 12_000);
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeForUi(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 40)) out[key] = sanitizeForUi(val, depth + 1);
    return out;
  }
  return String(value);
}

function makeQueue() {
  let items = [];
  let waiter = null;
  let closed = false;
  return {
    push(item) {
      if (closed) return false;
      items.push(item);
      if (waiter) { waiter(); waiter = null; }
      return true;
    },
    close() {
      closed = true;
      if (waiter) { waiter(); waiter = null; }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) {
          yield items.shift();
          continue;
        }
        if (closed) return;
        await new Promise((resolve) => { waiter = resolve; });
      }
    },
  };
}

export class ClaudeManager {
  constructor({ hub, onSessionChange } = {}) {
    this.hub = hub;
    this.onSessionChange = onSessionChange;
    this.sessions = new Map();
    this.historyCache = null;
    this.historyCacheAt = 0;
    this.historyPromise = null;
    this.historyAllCache = null;
    this.historyAllCacheAt = 0;
    this.historyAllPromise = null;
  }

  settings() {
    return getState().settings;
  }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => {
        if (a.status === 'stopped' && b.status !== 'stopped') return 1;
        if (b.status === 'stopped' && a.status !== 'stopped') return -1;
        return b.createdAt - a.createdAt;
      })
      .map((s) => this.snapshot(s));
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  snapshot(session, { includeMessages = false } = {}) {
    if (!session) return null;
    const data = {
      id: session.id,
      sdkSessionId: session.sdkSessionId,
      title: session.title,
      cwd: session.cwd,
      status: session.status,
      model: session.model,
      permissionMode: session.permissionMode,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      costUsd: session.costUsd,
      turns: session.turns,
      lastError: session.lastError,
      claudeCodeVersion: session.claudeCodeVersion,
      pendingPermissions: [...session.pendingPermissions.values()].map((p) => this.permissionSnapshot(p)),
      pendingQuestions: [...(session.pendingQuestions || new Map()).values()].map((q) => this.questionSnapshot(q)),
      messageCount: session.messages.length,
      resumedFrom: session.resumedFrom || null,
    };
    if (includeMessages) {
      data.messages = session.messages;
      data.streaming = session.streaming;
    }
    return data;
  }

  permissionSnapshot(p) {
    return {
      requestId: p.requestId,
      toolName: p.toolName,
      input: sanitizeForUi(p.input),
      title: p.title || toolTitle(p.toolName, p.input),
      description: p.description || '',
      createdAt: p.createdAt,
      defaultToNo: Boolean(p.defaultToNo),
      canAlwaysAllow: !p.suppressAlwaysAllowRule && Array.isArray(p.suggestions) && p.suggestions.length > 0,
      agentId: p.agentId || null,
    };
  }

  questionSnapshot(q) {
    return {
      requestId: q.requestId,
      questions: q.questions,
      createdAt: q.createdAt,
    };
  }

  normalizeQuestions(input) {
    const source = Array.isArray(input?.questions) ? input.questions : [];
    return source.slice(0, 10).map((question, index) => ({
      question: clip(String(question?.question || `问题 ${index + 1}`), 1200),
      header: clip(String(question?.header || ''), 120),
      multiSelect: Boolean(question?.multiSelect),
      options: (Array.isArray(question?.options) ? question.options : []).slice(0, 20).map((option) => ({
        label: clip(String(option?.label || option?.value || ''), 300),
        description: clip(String(option?.description || ''), 600),
      })).filter((option) => option.label),
    })).filter((question) => question.question && question.options.length > 0);
  }

  askUserQuestion(session, input, opts) {
    if (!(session.pendingQuestions instanceof Map)) session.pendingQuestions = new Map();
    const questions = this.normalizeQuestions(input);
    if (!questions.length) {
      return Promise.resolve({ behavior: 'allow', updatedInput: { ...input, answers: {} } });
    }
    const requestId = opts?.requestId || crypto.randomUUID();
    const pending = {
      requestId,
      questions,
      input,
      createdAt: Date.now(),
      resolve: null,
      timer: null,
    };
    const promise = new Promise((resolve) => { pending.resolve = resolve; });
    pending.timer = setTimeout(() => {
      if (!session.pendingQuestions.has(requestId)) return;
      this.finishQuestion(session, pending, { behavior: 'deny', message: '手机端回答超时（10 分钟）' });
    }, PERMISSION_TIMEOUT_MS);
    pending.timer.unref?.();
    session.pendingQuestions.set(requestId, pending);
    session.status = 'waiting_permission';
    session.streaming = true;
    this.hub?.broadcast('question', {
      sessionId: session.id,
      sessionTitle: session.title,
      question: this.questionSnapshot(pending),
    });
    this.broadcastSession(session);
    audit('claude.question', `${session.title}: ${questions.length} 个问题`);
    return promise;
  }

  finishQuestion(session, pending, result) {
    if (!session.pendingQuestions.has(pending.requestId)) return false;
    clearTimeout(pending.timer);
    session.pendingQuestions.delete(pending.requestId);
    try { pending.resolve(result); } catch {}
    if (session.status === 'waiting_permission'
      && session.pendingPermissions.size === 0
      && session.pendingQuestions.size === 0
      && !session.closed) {
      session.status = 'running';
    }
    this.hub?.broadcast('question_resolved', {
      sessionId: session.id,
      requestId: pending.requestId,
      behavior: result.behavior,
    });
    this.broadcastSession(session);
    return true;
  }

  resolveQuestion(id, requestId, answers = {}) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('会话不存在'), { status: 404 });
    const pending = session.pendingQuestions.get(requestId);
    if (!pending) throw Object.assign(new Error('问题不存在或已回答'), { status: 404 });
    const normalized = {};
    for (const question of pending.questions) {
      const raw = answers?.[question.question] ?? answers?.[question.header] ?? '';
      const value = Array.isArray(raw) ? raw.map(String).filter(Boolean).join(', ') : String(raw || '').trim();
      if (!value) throw Object.assign(new Error(`请先回答：${question.header || question.question}`), { status: 400 });
      normalized[question.question] = clip(value, 2000);
    }
    const ok = this.finishQuestion(session, pending, {
      behavior: 'allow',
      updatedInput: { ...pending.input, answers: normalized },
    });
    if (ok) audit('claude.question.resolve', `${session.title}: ${Object.keys(normalized).length} 个问题`);
    return { ok };
  }

  cancelQuestion(id, requestId) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('会话不存在'), { status: 404 });
    const pending = session.pendingQuestions.get(requestId);
    if (!pending) throw Object.assign(new Error('问题不存在或已回答'), { status: 404 });
    this.finishQuestion(session, pending, { behavior: 'deny', message: '用户未回答选择问题' });
    return { ok: true };
  }

  async create({ cwd, permissionMode, model, resume, forkSession = true, title } = {}) {
    const settings = this.settings();
    const active = [...this.sessions.values()].filter((s) => s.status !== 'stopped' && s.status !== 'error');
    if (active.length >= Math.max(1, Number(settings.maxSessions) || 3)) {
      throw Object.assign(new Error(`最多同时运行 ${settings.maxSessions || 3} 个会话，请先停止一个`), { status: 409 });
    }
    const realCwd = await validateWorkspace(cwd, settings.allowedRoots);
    let mode = permissionMode || settings.permissionMode || 'default';
    const allowedModes = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions']);
    if (!allowedModes.has(mode)) throw Object.assign(new Error('无效的权限模式'), { status: 400 });
    if (mode === 'bypassPermissions' && !settings.allowBypassPermissions) {
      throw Object.assign(new Error('“完全跳过权限”未在设置中启用'), { status: 403 });
    }

    const id = crypto.randomUUID();
    const queue = makeQueue();
    const abortController = new AbortController();
    const session = {
      id,
      sdkSessionId: null,
      title: (title || sessionTitle(realCwd)).slice(0, 80),
      cwd: realCwd,
      status: 'starting',
      model: model || settings.model || '',
      permissionMode: mode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      costUsd: 0,
      turns: 0,
      lastError: null,
      claudeCodeVersion: null,
      messages: [],
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      streamState: { messageId: null },
      streaming: false,
      queue,
      abortController,
      resumedFrom: resume || null,
      closed: false,
    };
    this.sessions.set(id, session);

    const options = {
      cwd: realCwd,
      permissionMode: mode,
      includePartialMessages: true,
      maxTurns: 200,
      abortController,
      canUseTool: (toolName, input, opts) => this.handleCanUseTool(session, toolName, input, opts),
      permissionPrompts: 'host',
    };
    if (session.model) options.model = session.model;
    if (settings.claudePath) options.pathToClaudeCodeExecutable = settings.claudePath;
    if (mode === 'bypassPermissions' && settings.allowBypassPermissions) options.allowDangerouslySkipPermissions = true;
    if (resume) {
      options.resume = resume;
      options.forkSession = forkSession !== false;
    }

    try {
      session.query = query({ prompt: queue, options });
    } catch (err) {
      this.sessions.delete(id);
      throw Object.assign(new Error(`无法启动 Claude Code：${err.message}`), { status: 500 });
    }

    this.broadcastSession(session);
    this.invalidateHistory();
    this.emit(session, { event: 'status', id: crypto.randomUUID(), text: '正在启动 Claude Code…', ts: new Date().toISOString() });
    void this.run(session);
    audit('claude.start', `${session.title} (${realCwd})`);
    return this.snapshot(session, { includeMessages: true });
  }

  async run(session) {
    try {
      for await (const msg of session.query) {
        if (session.closed) break;
        const { events, meta } = normalizeSdkMessage(msg, session.streamState);
        this.applyMeta(session, meta);
        for (const event of events) this.emit(session, event);
      }
    } catch (err) {
      if (!session.closed) {
        session.status = 'error';
        session.lastError = String(err?.message || err).slice(0, 500);
        this.emit(session, {
          event: 'error',
          id: crypto.randomUUID(),
          text: `Claude Code 进程异常：${session.lastError}`,
          ts: new Date().toISOString(),
        });
      }
    } finally {
      session.queryClosed = true;
      if (!session.closed && session.status !== 'stopped' && session.status !== 'error') {
        session.status = 'idle';
      }
      this.broadcastSession(session);
    }
  }

  applyMeta(session, meta) {
    if (!meta || typeof meta !== 'object') return;
    let changed = false;
    if (meta.sdkSessionId && meta.sdkSessionId !== session.sdkSessionId) {
      session.sdkSessionId = meta.sdkSessionId;
      changed = true;
    }
    if (meta.model && meta.model !== session.model) { session.model = meta.model; changed = true; }
    if (meta.permissionMode && meta.permissionMode !== session.permissionMode) { session.permissionMode = meta.permissionMode; changed = true; }
    if (meta.claudeCodeVersion) session.claudeCodeVersion = meta.claudeCodeVersion;
    if (Number.isFinite(meta.costUsd)) session.costUsd = meta.costUsd;
    if (Number.isFinite(meta.turns) && meta.turns > 0) session.turns = meta.turns;
    if (meta.status && session.status !== 'stopped' && session.status !== 'error') {
      session.status = meta.status;
      changed = true;
    }
    if (changed) {
      session.updatedAt = Date.now();
      this.broadcastSession(session);
    }
  }

  emit(session, event) {
    if (!event) return;
    const enriched = { ...event, sessionId: session.id, seq: ++session.eventSeq };
    if (event.event !== 'delta' && event.event !== 'message_start') {
      session.messages.push(enriched);
      if (session.messages.length > MAX_MESSAGES) session.messages.splice(0, session.messages.length - MAX_MESSAGES);
      session.updatedAt = Date.now();
    }
    if (session.status === 'starting' && event.event !== 'status') session.status = 'running';
    this.hub?.broadcast('claude', { sessionId: session.id, event: enriched });
    if (event.event === 'result') {
      this.broadcastSession(session);
    }
  }

  broadcastSession(session) {
    this.hub?.broadcast('session', { session: this.snapshot(session) });
    this.onSessionChange?.(session);
  }

  async prompt(id, text) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('会话不存在'), { status: 404 });
    if (session.status === 'stopped' || session.closed) throw Object.assign(new Error('会话已停止'), { status: 409 });
    if (session.status === 'error') throw Object.assign(new Error('会话处于错误状态，请停止后重新开始或从历史恢复'), { status: 409 });
    const prompt = typeof text === 'string' ? text.trim() : '';
    if (!prompt) throw Object.assign(new Error('指令不能为空'), { status: 400 });
    if (prompt.length > MAX_PROMPT) throw Object.assign(new Error(`指令不能超过 ${MAX_PROMPT} 字`), { status: 400 });

    const event = {
      event: 'user',
      id: crypto.randomUUID(),
      text: prompt,
      ts: new Date().toISOString(),
    };
    this.emit(session, event);
    session.status = 'running';
    session.streaming = true;
    session.updatedAt = Date.now();
    const ok = session.queue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
      timestamp: event.ts,
    });
    if (!ok) throw Object.assign(new Error('会话输入通道已关闭'), { status: 409 });
    this.broadcastSession(session);
    audit('claude.prompt', `${session.title}: ${prompt.slice(0, 120)}`);
    return { ok: true };
  }

  async interrupt(id) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('会话不存在'), { status: 404 });
    for (const pending of [...session.pendingPermissions.values()]) {
      this.finishPermission(session, pending, { behavior: 'deny', message: '用户中断了当前任务' });
    }
    for (const pending of [...session.pendingQuestions.values()]) {
      this.finishQuestion(session, pending, { behavior: 'deny', message: '用户中断了当前任务' });
    }
    try {
      const receipt = await session.query?.interrupt();
      session.status = 'idle';
      session.streaming = false;
      this.emit(session, {
        event: 'status',
        id: crypto.randomUUID(),
        text: receipt?.still_queued?.length ? `已中断，${receipt.still_queued.length} 条排队消息待处理` : '已中断当前任务',
        ts: new Date().toISOString(),
      });
      this.broadcastSession(session);
      audit('claude.interrupt', session.title);
      return { ok: true, receipt };
    } catch (err) {
      throw Object.assign(new Error(`中断失败：${err.message}`), { status: 500 });
    }
  }

  async stop(id) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('会话不存在'), { status: 404 });
    session.closed = true;
    session.status = 'stopped';
    session.streaming = false;
    for (const pending of [...session.pendingPermissions.values()]) {
      this.finishPermission(session, pending, { behavior: 'deny', message: '会话已停止' });
    }
    for (const pending of [...session.pendingQuestions.values()]) {
      this.finishQuestion(session, pending, { behavior: 'deny', message: '会话已停止' });
    }
    session.queue.close();
    try { session.query?.close(); } catch {}
    try { session.abortController?.abort(); } catch {}
    this.emit(session, { event: 'status', id: crypto.randomUUID(), text: '会话已停止', ts: new Date().toISOString() });
    this.broadcastSession(session);
    this.invalidateHistory();
    audit('claude.stop', session.title);
    return { ok: true };
  }

  async setPermissionMode(id, mode) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('会话不存在'), { status: 404 });
    const allowed = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']);
    if (!allowed.has(mode) && !(mode === 'bypassPermissions' && this.settings().allowBypassPermissions)) {
      throw Object.assign(new Error('无效的权限模式'), { status: 400 });
    }
    await session.query?.setPermissionMode(mode);
    session.permissionMode = mode;
    this.broadcastSession(session);
    this.emit(session, { event: 'status', id: crypto.randomUUID(), text: `权限模式已切换为 ${mode}`, ts: new Date().toISOString() });
    return { ok: true };
  }

  async handleCanUseTool(session, toolName, input, opts) {
    if (session.closed) return { behavior: 'deny', message: '会话已停止' };
    if (toolName === 'AskUserQuestion') {
      return this.askUserQuestion(session, input, opts);
    }
    const requestId = opts.requestId || crypto.randomUUID();
    const pending = {
      requestId,
      toolName,
      input,
      title: opts.title || toolTitle(toolName, input),
      description: opts.description || '',
      suggestions: opts.suggestions || [],
      defaultToNo: Boolean(opts.defaultToNo),
      suppressAlwaysAllowRule: Boolean(opts.suppressAlwaysAllowRule),
      agentId: opts.agentID || null,
      createdAt: Date.now(),
      resolve: null,
      timer: null,
    };
    const promise = new Promise((resolve) => { pending.resolve = resolve; });
    pending.timer = setTimeout(() => {
      if (!session.pendingPermissions.has(requestId)) return;
      this.finishPermission(session, pending, { behavior: 'deny', message: '手机端审批超时（10 分钟）' });
    }, PERMISSION_TIMEOUT_MS);
    pending.timer.unref?.();
    session.pendingPermissions.set(requestId, pending);
    session.status = 'waiting_permission';
    session.streaming = true;
    this.hub?.broadcast('permission', {
      sessionId: session.id,
      sessionTitle: session.title,
      permission: this.permissionSnapshot(pending),
    });
    this.broadcastSession(session);
    audit('claude.permission', `${session.title}: ${toolName}`);
    return promise;
  }

  finishPermission(session, pending, result) {
    if (!session.pendingPermissions.has(pending.requestId)) return false;
    clearTimeout(pending.timer);
    session.pendingPermissions.delete(pending.requestId);
    try { pending.resolve(result); } catch {}
    if (session.status === 'waiting_permission' && session.pendingPermissions.size === 0 && !session.closed) {
      session.status = 'running';
    }
    this.hub?.broadcast('permission_resolved', {
      sessionId: session.id,
      requestId: pending.requestId,
      behavior: result.behavior,
    });
    this.broadcastSession(session);
    return true;
  }

  resolvePermission(id, requestId, decision, { always = false } = {}) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('会话不存在'), { status: 404 });
    const pending = session.pendingPermissions.get(requestId);
    if (!pending) throw Object.assign(new Error('审批请求不存在或已处理'), { status: 404 });
    const action = String(decision || '').toLowerCase();
    if (action === 'allow' || action === 'deny') {
      let result;
      if (action === 'allow') {
        result = { behavior: 'allow', updatedInput: pending.input };
        if (always && Array.isArray(pending.suggestions) && pending.suggestions.length) {
          const sessionSuggestions = pending.suggestions.filter((s) => s && s.destination === 'session');
          if (sessionSuggestions.length) result.updatedPermissions = sessionSuggestions;
        }
      } else {
        result = { behavior: 'deny', message: '用户在手机上拒绝了此操作' };
      }
      const ok = this.finishPermission(session, pending, result);
      if (ok) audit('claude.permission.resolve', `${session.title}: ${pending.toolName} -> ${action}${always ? ' always' : ''}`);
      return { ok };
    }
    throw Object.assign(new Error('无效的审批决定'), { status: 400 });
  }

  async scanTranscriptSessions() {
    const root = process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
      : path.join(os.homedir(), '.claude', 'projects');
    const out = [];
    let dirs = [];
    try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const folder = path.join(root, dir.name);
      let files = [];
      try { files = await fsp.readdir(folder, { withFileTypes: true }); } catch { continue; }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const id = file.name.slice(0, -6);
        if (!/^[0-9a-f-]{20,}$/i.test(id)) continue;
        const full = path.join(folder, file.name);
        try {
          const stat = await fsp.stat(full);
          const handle = await fsp.open(full, 'r');
          const buffer = Buffer.alloc(256 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          await handle.close();
          const text = buffer.subarray(0, bytesRead).toString('utf8');
          let cwd = '';
          let summary = '';
          let firstPrompt = '';
          let createdAt = null;
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (!cwd && typeof msg.cwd === 'string') cwd = msg.cwd;
            if (!createdAt && msg.timestamp) createdAt = msg.timestamp;
            const content = msg.message?.content;
            const texts = typeof content === 'string'
              ? [content]
              : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text) : [];
            const userText = msg.type === 'user' ? texts.join(' ').trim() : '';
            if (userText && !userText.startsWith('<') && !firstPrompt) {
              firstPrompt = clip(userText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 300);
            }
            if (!summary && msg.type === 'summary' && typeof msg.summary === 'string') summary = msg.summary;
          }
          if (!cwd) continue;
          out.push({
            sessionId: id,
            summary: clip(summary || firstPrompt || '未命名会话', 160),
            firstPrompt,
            cwd,
            createdAt,
            lastModified: stat.mtimeMs,
            gitBranch: '',
            tag: '',
          });
        } catch {}
      }
    }
    return out;
  }

  shapeHistory(raw) {
    const activeBySdk = new Map();
    for (const s of this.sessions.values()) if (s.sdkSessionId) activeBySdk.set(s.sdkSessionId, s);
    return raw.map((s) => {
      const active = activeBySdk.get(s.sessionId);
      return {
        sessionId: s.sessionId,
        summary: clip(s.customTitle || s.summary || s.firstPrompt || '未命名会话', 160),
        firstPrompt: s.firstPrompt ? clip(s.firstPrompt, 300) : '',
        cwd: s.cwd || '',
        gitBranch: s.gitBranch || '',
        createdAt: s.createdAt || null,
        lastModified: s.lastModified || null,
        tag: s.tag || '',
        active: Boolean(active),
        activeId: active?.id || null,
      };
    }).filter((s) => s.cwd);
  }

  async listHistory({ limit = 30, cwd } = {}) {
    const now = Date.now();
    if (!cwd && this.historyCache && now - this.historyCacheAt < HISTORY_CACHE_MS) return this.historyCache;
    if (!cwd && this.historyPromise) return this.historyPromise;
    const run = (async () => {
      try {
        const raw = await listSessions({ limit: Math.min(Math.max(Number(limit) || 30, 1), 100), includeProgrammatic: true });
        const result = this.shapeHistory(raw);
        if (!cwd) {
          this.historyCache = result;
          this.historyCacheAt = Date.now();
        }
        return result;
      } catch (err) {
        return { error: String(err?.message || err), sessions: [] };
      } finally {
        if (!cwd) this.historyPromise = null;
      }
    })();
    if (!cwd) this.historyPromise = run;
    return run;
  }

  async listAllHistory() {
    const now = Date.now();
    if (this.historyAllCache && now - this.historyAllCacheAt < HISTORY_CACHE_MS) return this.historyAllCache;
    if (this.historyAllPromise) return this.historyAllPromise;
    const run = (async () => {
      try {
        const byId = new Map();
        const pageSize = 100;
        for (let offset = 0; offset < 5000; offset += pageSize) {
          const page = await listSessions({ limit: pageSize, offset, includeProgrammatic: true });
          for (const item of page) byId.set(item.sessionId, item);
          if (page.length < pageSize) break;
        }
        const local = await this.scanTranscriptSessions();
        for (const item of local) {
          if (!byId.has(item.sessionId)) byId.set(item.sessionId, item);
        }
        const result = this.shapeHistory([...byId.values()])
          .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
        this.historyAllCache = result;
        this.historyAllCacheAt = Date.now();
        return result;
      } catch (err) {
        return { error: String(err?.message || err), sessions: [] };
      } finally {
        this.historyAllPromise = null;
      }
    })();
    this.historyAllPromise = run;
    return run;
  }

  invalidateHistory() {
    this.historyCache = null;
    this.historyCacheAt = 0;
    this.historyAllCache = null;
    this.historyAllCacheAt = 0;
  }

  async getHistory(id, { cwd, limit = 300 } = {}) {
    if (!id || !/^[0-9a-f-]{20,}$/i.test(id)) throw Object.assign(new Error('无效的会话 ID'), { status: 400 });
    const info = await getSessionInfo(id, cwd ? { dir: cwd } : undefined).catch(() => null);
    const messages = await getSessionMessages(id, {
      ...(cwd ? { dir: cwd } : {}),
      limit: Math.min(Math.max(Number(limit) || 300, 1), 500),
    }).catch((err) => {
      throw Object.assign(new Error(`读取历史失败：${err.message}`), { status: 500 });
    });
    return {
      sessionId: id,
      cwd: info?.cwd || cwd || '',
      summary: info?.summary || '',
      customTitle: info?.customTitle || '',
      lastModified: info?.lastModified || null,
      messages: normalizeHistory(messages),
    };
  }

  async resumeHistory(id, { cwd, title, forkSession = false } = {}) {
    if (!id) throw Object.assign(new Error('缺少会话 ID'), { status: 400 });
    const info = await getSessionInfo(id, cwd ? { dir: cwd } : undefined).catch(() => null);
    const workdir = info?.cwd || cwd;
    if (!workdir) throw Object.assign(new Error('找不到该会话的工作目录'), { status: 400 });
    return this.create({
      cwd: workdir,
      resume: id,
      forkSession: Boolean(forkSession),
      title: title || `${forkSession ? '副本' : '继续'} · ${info?.summary || sessionTitle(workdir)}`,
    });
  }

  closeAll() {
    for (const session of this.sessions.values()) {
      session.closed = true;
      session.queue.close();
      for (const pending of [...session.pendingPermissions.values()]) {
        this.finishPermission(session, pending, { behavior: 'deny', message: '服务正在关闭' });
      }
      try { session.query?.close(); } catch {}
      try { session.abortController?.abort(); } catch {}
    }
  }
}

export function isClaudeInstalled() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8'));
    return { sdk: pkg.version, claudeCode: pkg.claudeCodeVersion || null };
  } catch {
    return null;
  }
}
