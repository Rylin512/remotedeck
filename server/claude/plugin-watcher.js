import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeHistoryMessage, clip } from './normalize.js';
import { readPeerRows, isPidAlive, PHONE_NAME } from './peer.js';

export const PROJECTS_DIR = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  'projects',
);

const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_HEAD_BYTES = 128 * 1024;
const MAX_EVENTS = 900;
const ACTIVE_MS = 8_000;
const RECENT_MS = 5 * 60_000;
const KEEP_MS = 6 * 60 * 60_000;

async function readRange(file, start, length) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, length));
    if (!length) return '';
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseJsonLines(text, { dropPartialFirst = false } = {}) {
  const lines = text.split('\n');
  if (dropPartialFirst) lines.shift();
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '\r') continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A line can be partially written; it will be picked up on the next poll.
    }
  }
  return out;
}

async function readHead(file, size) {
  const length = Math.min(size, MAX_HEAD_BYTES);
  const text = await readRange(file, 0, length);
  const entries = parseJsonLines(text);
  let cwd = '';
  let firstPrompt = '';
  for (const entry of entries) {
    if (entry.cwd && !cwd) cwd = entry.cwd;
    if (!firstPrompt && entry.type === 'user' && !entry.isSidechain) {
      const content = entry.message?.content;
      if (typeof content === 'string') firstPrompt = content;
      else if (Array.isArray(content)) {
        const textBlock = content.find((b) => b?.type === 'text' && b.text);
        if (textBlock) firstPrompt = textBlock.text;
      }
    }
    if (cwd && firstPrompt) break;
  }
  return { cwd, firstPrompt: clip(firstPrompt, 300) };
}

async function readTail(file, size, maxBytes = MAX_TAIL_BYTES) {
  const start = Math.max(0, size - maxBytes);
  const text = await readRange(file, start, size - start);
  return parseJsonLines(text, { dropPartialFirst: start > 0 });
}

function phoneEventKey(event) {
  return String(event?.text || '').replace(/\s+/g, ' ').trim();
}

function takeMatchingLocalPhone(state, event) {
  const text = phoneEventKey(event);
  const ts = Date.parse(event.ts || '') || Date.now();
  const index = state.localEvents.findIndex((local) => {
    if (local.id === event.id) return true;
    if (phoneEventKey(local) !== text) return false;
    const localTs = Date.parse(local.ts || '') || ts;
    return Math.abs(localTs - ts) < 15 * 60_000;
  });
  if (index < 0) return null;
  return state.localEvents.splice(index, 1)[0] || null;
}

function normalizeLine(entry, state) {
  if (!entry || typeof entry !== 'object' || entry.isSidechain === true) return [];
  if (entry.type === 'ai-title' && entry.aiTitle) {
    state.title = clip(String(entry.aiTitle), 120);
    return [];
  }
  if (entry.type === 'last-prompt' && entry.lastPrompt) {
    state.lastPrompt = clip(String(entry.lastPrompt), 300);
    if (!state.title) state.title = state.lastPrompt.slice(0, 80);
    return [];
  }
  if (entry.type === 'api-request') {
    state.lastType = 'api-request';
    if (entry.timestamp) state.lastTimestamp = entry.timestamp;
    return [];
  }
  if (entry.cwd) state.cwd = entry.cwd;
  if (entry.sessionId) state.id = entry.sessionId;
  if (entry.type === 'assistant') {
    state.lastType = 'assistant';
    state.lastStopReason = entry.message?.stop_reason || state.lastStopReason;
    for (const block of entry.message?.content || []) {
      if (block?.type === 'tool_use' && block.id) state.pendingTools.add(block.id);
    }
  } else if (entry.type === 'user') {
    state.lastType = 'user';
    for (const block of entry.message?.content || []) {
      if (block?.type === 'tool_result' && block.tool_use_id) state.pendingTools.delete(block.tool_use_id);
    }
  }
  if (entry.timestamp) state.lastTimestamp = entry.timestamp;
  const events = normalizeHistoryMessage(entry);
  return events.map((event) => ({ ...event, source: event.source || 'plugin', pluginSessionId: state.id }));
}

function decodeProjectFolder(name) {
  const match = name.match(/^([a-zA-Z])--(.*)$/);
  if (!match) return '';
  return `${match[1]}:\\${match[2].replace(/-/g, '\\')}`;
}

export class PluginWatcher {
  constructor({ hub, projectsDir = PROJECTS_DIR, liveResolver = null } = {}) {
    this.hub = hub;
    this.projectsDir = projectsDir;
    this.liveResolver = liveResolver;
    this.files = new Map();
    this.byId = new Map();
    this.peerRows = new Map();
    this.timer = null;
    this.scanning = false;
    this.lastListSignature = '';
    this.lastBroadcastAt = 0;
  }

  start() {
    if (this.timer) return;
    this.scan().catch(() => {});
    this.timer = setInterval(() => this.scan().catch(() => {}), 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async listProjectDirs() {
    try {
      const entries = await fsp.readdir(this.projectsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => path.join(this.projectsDir, e.name));
    } catch {
      return [];
    }
  }

  async createState(file, stat) {
    const id = path.basename(file, '.jsonl');
    const projectFolder = path.basename(path.dirname(file));
    const head = await readHead(file, stat.size).catch(() => ({ cwd: '', firstPrompt: '' }));
    const state = {
      id,
      file,
      cwd: head.cwd || decodeProjectFolder(projectFolder),
      title: head.firstPrompt ? clip(head.firstPrompt, 80) : '',
      lastPrompt: head.firstPrompt || '',
      offset: stat.size > 1_000_000 ? stat.size : 0,
      lastModified: stat.mtimeMs,
      createdAt: stat.birthtimeMs || stat.mtimeMs,
      lastType: '',
      lastStopReason: '',
      lastTimestamp: null,
      pendingTools: new Set(),
      events: [],
      localEvents: [],
      messageCount: 0,
      closed: false,
      error: null,
    };
    // Analyze the tail so an already-running session shows its tool state and title.
    if (stat.size > 1_000_000) {
      const tail = await readTail(file, stat.size, 512 * 1024).catch(() => []);
      for (const entry of tail) {
        for (const event of normalizeLine(entry, state)) {
          state.events.push(event);
          state.messageCount += 1;
        }
      }
      state.offset = stat.size;
      state.events = state.events.slice(-MAX_EVENTS);
    } else {
      // New/small sessions are replayed from the beginning on the first read so
      // the live stream sees the opening prompt as well.
      state.offset = 0;
    }
    this.byId.set(id, state);
    return state;
  }

  async readNew(state, size) {
    if (size <= state.offset) return [];
    const start = state.offset;
    const length = Math.min(size - start, MAX_TAIL_BYTES);
    const text = await readRange(state.file, start, length);
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) {
      // A single line larger than the read window: skip it rather than
      // retrying the same bytes forever. Huge tool outputs are not useful on
      // a phone anyway.
      if (length >= MAX_TAIL_BYTES) state.offset = start + length;
      return [];
    }
    const complete = text.slice(0, lastNewline + 1);
    state.offset = start + Buffer.byteLength(complete, 'utf8');
    const entries = parseJsonLines(complete);
    const allEvents = [];
    for (const entry of entries) {
      const events = normalizeLine(entry, state);
      for (const event of events) {
        if (event.event === 'user' && event.source === 'phone' && takeMatchingLocalPhone(state, event)) {
          // The immediate phone bubble was already broadcast and is now also
          // present in the transcript. Keep only one copy.
          continue;
        }
        state.events.push(event);
        state.messageCount += 1;
        allEvents.push(event);
        this.hub?.broadcast('plugin_event', { sessionId: state.id, event });
      }
    }
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    return allEvents;
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = Date.now();
      const dirs = await this.listProjectDirs();
      try {
        const rows = await readPeerRows();
        this.peerRows = new Map(rows
          .filter((row) => row.messagingSocketPath && isPidAlive(row.pid))
          .map((row) => [row.sessionId, row]));
      } catch {
        this.peerRows = new Map();
      }
      let changed = false;
      const seenFiles = new Set();
      for (const dir of dirs) {
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const file = path.join(dir, entry.name);
          let stat;
          try { stat = await fsp.stat(file); } catch { continue; }
          seenFiles.add(file);
          if (now - stat.mtimeMs > KEEP_MS && !this.files.has(file)) continue;
          let state = this.files.get(file);
          if (!state) {
            state = await this.createState(file, stat);
            this.files.set(file, state);
            changed = true;
          }
          if (stat.size < state.offset) state.offset = 0;
          if (stat.size > state.offset) {
            const events = await this.readNew(state, stat.size);
            if (events.length) changed = true;
          }
          state.lastModified = stat.mtimeMs;
          if (this.peerRows.has(state.id) && state.closed) {
            state.closed = false;
            changed = true;
          }
        }
      }
      // prune old inactive and deleted files
      for (const [file, state] of this.files) {
        const deleted = !seenFiles.has(file);
        if ((deleted || now - state.lastModified > KEEP_MS) && (deleted || state.pendingTools.size === 0)) {
          this.files.delete(file);
          this.byId.delete(state.id);
          changed = true;
        }
      }
      if (changed) this.broadcastList(true);
      else this.broadcastList(false);
    } finally {
      this.scanning = false;
    }
  }

  statusOf(state) {
    const age = Date.now() - state.lastModified;
    if (state.pendingTools.size > 0) return 'running';
    if (state.lastType === 'api-request' && age < 10 * 60_000) return 'running';
    if (age < ACTIVE_MS) return 'running';
    if (state.lastType === 'assistant' && state.lastStopReason === 'end_turn' && age > ACTIVE_MS) return 'idle';
    if (age < RECENT_MS) return 'recent';
    return 'idle';
  }

  isLive(id) {
    return this.liveResolver ? Boolean(this.liveResolver(id)) : this.peerRows.has(id);
  }

  list() {
    return [...this.byId.values()]
      .filter((state) => !state.closed && this.isLive(state.id) && state.lastModified > Date.now() - 24 * 60 * 60_000)
      .sort((a, b) => {
        const aliveA = this.peerRows.has(a.id) ? 1 : 0;
        const aliveB = this.peerRows.has(b.id) ? 1 : 0;
        if (aliveA !== aliveB) return aliveB - aliveA;
        const ar = this.statusOf(a) === 'running' ? 1 : 0;
        const br = this.statusOf(b) === 'running' ? 1 : 0;
        if (ar !== br) return br - ar;
        return b.lastModified - a.lastModified;
      })
      .slice(0, 12)
      .map((state) => ({
        id: state.id,
        source: 'vscode-plugin',
        title: state.title || state.lastPrompt || path.basename(state.cwd || '') || 'Claude Code 会话',
        cwd: state.cwd,
        lastModified: state.lastModified,
        status: this.statusOf(state),
        pendingTools: state.pendingTools.size,
        messageCount: state.messageCount,
        live: this.isLive(state.id),
        peerName: this.peerRows.get(state.id)?.name || '',
        preview: state.events.filter((e) => e.event === 'assistant').at(-1)?.text?.slice(0, 180) || '',
      }));
  }

  broadcastList(force = false) {
    const now = Date.now();
    if (!force && now - this.lastBroadcastAt < 1200) return;
    const sessions = this.list();
    const signature = sessions.map((s) => `${s.id}:${s.status}:${s.lastModified}:${s.title}`).join('|');
    if (!force && signature === this.lastListSignature) return;
    this.lastListSignature = signature;
    this.lastBroadcastAt = now;
    this.hub?.broadcast('plugin_sessions', { sessions });
  }

  markClosed(sessionId) {
    this.peerRows.delete(sessionId);
    const state = this.byId.get(sessionId);
    if (state) {
      state.pendingTools.clear();
      state.closed = true;
      state.lastType = 'closed';
      state.lastModified = Date.now();
    }
    this.broadcastList(true);
  }

  noteOutgoing(sessionId, { msgId, text, mode = 'nudge', peerName = PHONE_NAME }) {    const state = this.byId.get(sessionId);
    if (!state) return null;
    const event = {
      event: 'user',
      id: `phone:${msgId}`,
      text: String(text || ''),
      source: 'phone',
      peerName,
      mode,
      ts: new Date().toISOString(),
    };
    state.localEvents.push(event);
    if (state.localEvents.length > 50) state.localEvents.shift();
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    this.hub?.broadcast('plugin_event', { sessionId, event });
    this.broadcastList(true);
    return event;
  }

  async findState(id) {
    if (this.byId.has(id)) return this.byId.get(id);
    const dirs = await this.listProjectDirs();
    for (const dir of dirs) {
      const file = path.join(dir, `${id}.jsonl`);
      try {
        const stat = await fsp.stat(file);
        const state = await this.createState(file, stat);
        this.files.set(file, state);
        return state;
      } catch {}
    }
    return null;
  }

  async getSession(id, { limit = 120 } = {}) {
    const maxMessages = Math.max(20, Math.min(1000, Number(limit) || 120));
    if (!/^[0-9a-f-]{20,}$/i.test(String(id))) {
      throw Object.assign(new Error('无效的会话 ID'), { status: 400 });
    }
    const state = await this.findState(id);
    if (!state) throw Object.assign(new Error('找不到该 Claude Code 会话文件'), { status: 404 });
    const stat = await fsp.stat(state.file).catch(() => null);
    const entries = stat ? await readTail(state.file, stat.size, MAX_TAIL_BYTES) : [];
    const fresh = {
      id: state.id,
      cwd: state.cwd,
      title: state.title,
      lastPrompt: state.lastPrompt,
      pendingTools: new Set(),
      lastType: '',
      lastStopReason: '',
      lastTimestamp: null,
      events: [],
      messageCount: 0,
    };
    const seen = new Set();
    for (const entry of entries) {
      const events = normalizeLine(entry, fresh);
      for (const event of events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        fresh.events.push(event);
      }
    }
    for (const event of state.localEvents || []) {
      if (seen.has(event.id)) continue;
      const localText = phoneEventKey(event);
      const localTs = Date.parse(event.ts || '') || 0;
      const alreadyInTranscript = fresh.events.some((item) => {
        if (item.event !== 'user' || item.source !== 'phone') return false;
        if (item.id === event.id) return true;
        if (phoneEventKey(item) !== localText) return false;
        const itemTs = Date.parse(item.ts || '') || 0;
        return Math.abs(itemTs - localTs) < 15 * 60_000;
      });
      if (alreadyInTranscript) continue;
      seen.add(event.id);
      fresh.events.push(event);
    }
    if (stat) {
      fresh.lastModified = stat.mtimeMs;
      state.lastModified = stat.mtimeMs;
    }
    fresh.events.sort((a, b) => (Date.parse(a.ts || '') || 0) - (Date.parse(b.ts || '') || 0));
    fresh.title = state.title || fresh.title;
    fresh.pendingTools = state.pendingTools;
    const total = fresh.events.length;
    const messages = total > maxMessages ? fresh.events.slice(-maxMessages) : fresh.events;
    return {
      session: {
        id: state.id,
        source: 'vscode-plugin',
        title: state.title || state.lastPrompt || 'Claude Code 会话',
        cwd: state.cwd,
        lastModified: state.lastModified,
        status: this.statusOf(state),
        pendingTools: state.pendingTools.size,
        messageCount: total,
        hasMore: messages.length < total,
        live: this.isLive(state.id),
        peerName: this.peerRows.get(state.id)?.name || '',
      },
      messages,
    };
  }
}
