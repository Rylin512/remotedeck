import crypto from 'node:crypto';
import { stripCrossSession } from './peer.js';

const MAX_TEXT = 60_000;
const MAX_TOOL_TEXT = 30_000;

function uid() {
  return crypto.randomUUID();
}

export function clip(value, max = MAX_TEXT) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字符）` : text;
}

export function toolTitle(name, input = {}) {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = { text: input }; }
  }
  if (!input || typeof input !== 'object') input = {};

  const clean = (value, max = 180) => {
    if (value === undefined || value === null) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.replace(/\s+/g, ' ').trim().slice(0, max);
  };
  const firstLine = (value, max = 180) => clean(String(value || '').split(/\r?\n/).find((line) => line.trim()) || '', max);
  const commandTitle = (value) => {
    const line = firstLine(value, 240);
    // Strip a leading `cd "..." &&` so the useful command is visible first.
    return line.replace(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*/i, '').slice(0, 180);
  };
  const pathTitle = (value) => clean(value, 220);
  const listTitle = (value) => {
    if (!Array.isArray(value)) return clean(value, 120);
    if (!value.length) return '空列表';
    const first = value[0]?.content || value[0]?.subject || value[0]?.task || value[0]?.description || '';
    return clean(value.length === 1 ? first : `${first}（共 ${value.length} 项）`, 180);
  };

  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return clean(input.description, 180) || commandTitle(input.command) || name;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return pathTitle(input.file_path || input.path || input.notebook_path) || name;
    case 'Glob':
      return clean(input.pattern, 140) || name;
    case 'Grep':
      return clean(input.pattern, 140) || name;
    case 'WebFetch':
      return clean(input.url, 220) || name;
    case 'WebSearch':
      return clean(input.query, 180) || name;
    case 'Task':
    case 'Agent':
      return clean(input.description || input.prompt, 180) || name;
    case 'AskUserQuestion':
      return clean(input.questions?.[0]?.question || input.question, 180) || name;
    case 'TodoWrite':
      return listTitle(input.todos) || '更新待办列表';
    case 'TaskCreate':
      return clean(input.subject || input.description, 180) || '创建任务';
    case 'TaskUpdate':
      return clean(input.taskId ? `任务 ${input.taskId}${input.status ? ` → ${input.status}` : ''}` : input.description, 180) || '更新任务';
    case 'TaskGet':
      return clean(input.taskId ? `任务 ${input.taskId}` : '', 120) || '查看任务';
    case 'TaskList':
      return '查看任务列表';
    case 'TaskOutput':
      return clean(input.task_id ? `任务 ${input.task_id} 输出` : '', 120) || '读取任务输出';
    case 'TaskStop':
      return clean(input.task_id ? `停止任务 ${input.task_id}` : '', 120) || '停止任务';
    case 'BashOutput':
      return clean(input.bash_id ? `Shell ${input.bash_id}` : '', 120) || '读取后台输出';
    case 'KillShell':
      return clean(input.shell_id || input.bash_id ? `关闭 Shell ${input.shell_id || input.bash_id}` : '', 120) || '关闭后台 Shell';
    case 'Skill':
      return clean(input.skill || input.name, 140) || '调用技能';
    case 'EnterPlanMode':
      return '进入计划模式';
    case 'ExitPlanMode':
      return '提交计划';
    case 'ListMcpResources':
      return '列出 MCP 资源';
    case 'ReadMcpResource':
      return clean(input.uri, 200) || '读取 MCP 资源';
    default: {
      const candidate = input.description || input.summary || input.query
        || input.file_path || input.path || input.command || input.prompt
        || input.subject || input.task || input.text || input.url;
      if (candidate) return clean(candidate, 180);
      if (String(name || '').startsWith('mcp__')) {
        const parts = String(name).split('__');
        return parts.length >= 3 ? `${parts[1]} / ${parts.slice(2).join(' / ')}` : name;
      }
      return name;
    }
  }
}

export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block.type === 'image') parts.push('[图片]');
      else if (block.type === 'document') parts.push('[文档]');
      else if (block.type === 'tool_result') parts.push(contentToText(block.content));
      else if (typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }
  if (content && typeof content === 'object') return clip(content, MAX_TOOL_TEXT);
  return '';
}

function toolResultEvents(message, ts) {
  const events = [];
  const content = message?.message?.content;
  if (!Array.isArray(content)) return events;
  for (const block of content) {
    if (!block || block.type !== 'tool_result') continue;
    const text = contentToText(block.content);
    events.push({
      event: 'tool_result',
      id: `tool:${block.tool_use_id}:result`,
      toolUseId: block.tool_use_id,
      text: clip(text, MAX_TOOL_TEXT),
      isError: Boolean(block.is_error),
      ts,
    });
  }
  return events;
}

function estimateTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.max(1, Math.ceil(cjk + (value.length - cjk) / 4));
}

function assistantEvents(msg) {
  const ts = msg.timestamp || new Date().toISOString();
  const message = msg.message;
  const messageId = message?.id || msg.uuid || uid();
  const events = [];
  const usageThinking = Number(message?.usage?.output_tokens_details?.thinking_tokens) || 0;
  let thinkingBlocks = 0;
  if (Array.isArray(message?.content)) {
    message.content.forEach((block, index) => {
      if (!block || typeof block !== 'object') return;
      if (block.type === 'text' && block.text) {
        events.push({
          event: 'assistant',
          id: `${messageId}:text:${index}`,
          messageId,
          text: clip(block.text),
          ts,
        });
      } else if (block.type === 'thinking' && block.thinking) {
        const estimated = estimateTokens(block.thinking);
        const exact = usageThinking > 0 && thinkingBlocks === 0 ? usageThinking : 0;
        thinkingBlocks += 1;
        events.push({
          event: 'thinking',
          id: `${messageId}:thinking:${index}`,
          messageId,
          text: clip(block.thinking),
          tokens: exact || estimated,
          estimated: !exact,
          ts,
        });
      } else if (block.type === 'redacted_thinking') {
        events.push({
          event: 'thinking',
          id: `${messageId}:redacted:${index}`,
          messageId,
          text: '',
          tokens: 0,
          redacted: true,
          ts,
        });
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        events.push({
          event: 'tool_use',
          id: `tool:${block.id || `${messageId}:${index}`}`,
          toolUseId: block.id || `${messageId}:${index}`,
          name: block.name || 'Tool',
          input: block.input ?? {},
          title: toolTitle(block.name, block.input),
          ts,
        });
      } else if (block.type === 'web_search_tool_result' && block.content) {
        events.push({
          event: 'tool_result',
          id: `tool:${block.tool_use_id}:result`,
          toolUseId: block.tool_use_id,
          text: clip(contentToText(block.content), MAX_TOOL_TEXT),
          isError: Boolean(block.is_error),
          ts,
        });
      }
    });
  } else if (typeof message?.content === 'string' && message.content) {
    events.push({
      event: 'assistant',
      id: `${messageId}:0`,
      messageId,
      text: clip(message.content),
      ts,
    });
  }
  if (msg.error) {
    events.push({ event: 'error', id: uid(), text: `Claude 返回错误：${msg.error}`, ts });
  }
  return events;
}

function resultEvent(msg) {
  const isError = Boolean(msg.is_error);
  const text = typeof msg.result === 'string' ? msg.result : '';
  return {
    event: 'result',
    id: uid(),
    subtype: msg.subtype || (isError ? 'error' : 'success'),
    text: clip(text),
    isError,
    costUsd: Number(msg.total_cost_usd || 0),
    durationMs: Number(msg.duration_ms || 0),
    apiDurationMs: Number(msg.duration_api_ms || 0),
    turns: Number(msg.num_turns || 0),
    denials: Array.isArray(msg.permission_denials) ? msg.permission_denials : [],
    ts: new Date().toISOString(),
  };
}

/**
 * Convert a Claude Agent SDK message into small, UI-friendly events.
 * Returns { events, meta } where meta is partial session metadata.
 */
export function normalizeSdkMessage(msg, streamState = null) {
  const events = [];
  const meta = {};
  if (!msg || typeof msg !== 'object') return { events, meta };
  const ts = msg.timestamp || new Date().toISOString();

  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        meta.sdkSessionId = msg.session_id;
        meta.model = msg.model;
        meta.permissionMode = msg.permissionMode;
        meta.tools = Array.isArray(msg.tools) ? msg.tools : [];
        meta.slashCommands = Array.isArray(msg.slash_commands) ? msg.slash_commands : [];
        meta.cwd = msg.cwd;
        meta.claudeCodeVersion = msg.claude_code_version;
        meta.status = 'idle';
        events.push({
          event: 'status',
          id: uid(),
          text: `已连接 Claude Code ${msg.claude_code_version || ''} · ${msg.model || ''}`.trim(),
          model: msg.model,
          permissionMode: msg.permissionMode,
          ts,
        });
      } else if (msg.subtype === 'status') {
        const text = msg.status || msg.message || '';
        if (text) events.push({ event: 'status', id: uid(), text: String(text), ts });
      } else if (msg.subtype === 'thinking_tokens') {
        meta.thinkingTokens = msg.tokens ?? msg.count ?? null;
      } else if (msg.subtype === 'permission_denied') {
        events.push({
          event: 'tool_result',
          id: uid(),
          toolUseId: msg.tool_use_id,
          text: msg.message || msg.decision_reason || '权限被拒绝',
          isError: true,
          ts,
        });
      } else if (msg.subtype === 'session_state_changed') {
        meta.state = msg.state;
        if (msg.state === 'requires_action') meta.status = 'waiting';
        else if (msg.state === 'running') meta.status = 'running';
        else if (msg.state === 'idle') meta.status = 'idle';
      } else if (msg.subtype === 'api_retry') {
        events.push({
          event: 'status',
          id: uid(),
          text: `API 重试中（第 ${msg.attempt || 1} 次）`,
          level: 'warn',
          ts,
        });
      } else if (msg.subtype === 'compact_boundary') {
        events.push({ event: 'system', id: uid(), text: '上下文已压缩', ts });
      } else if (msg.subtype === 'rate_limit_event') {
        events.push({
          event: 'rate_limit',
          id: uid(),
          status: msg.rate_limit_info?.status || msg.status || 'unknown',
          resetsAt: msg.rate_limit_info?.resetsAt || msg.resetsAt || null,
          ts,
        });
      } else if (msg.subtype === 'notification' || msg.subtype === 'informational') {
        const text = msg.text || msg.message || msg.title;
        if (text) events.push({ event: 'system', id: uid(), text: String(text), ts });
      } else if (msg.subtype === 'tool_progress') {
        events.push({
          event: 'tool_progress',
          id: uid(),
          toolUseId: msg.tool_use_id,
          elapsedSeconds: msg.elapsed_seconds,
          ts,
        });
      } else if (msg.subtype === 'auth_status' && msg.error) {
        events.push({ event: 'error', id: uid(), text: `认证错误：${msg.error}`, ts });
      }
      break;
    }
    case 'assistant': {
      meta.sdkSessionId = msg.session_id;
      if (msg.message?.model) meta.model = msg.message.model;
      events.push(...assistantEvents(msg));
      break;
    }
    case 'user': {
      if (msg.isReplay) break;
      const toolEvents = toolResultEvents(msg, ts);
      if (toolEvents.length) {
        events.push(...toolEvents);
      } else {
        const text = contentToText(msg.message?.content);
        if (text) {
          events.push({
            event: 'user',
            id: msg.uuid || uid(),
            text: clip(text),
            ts,
            synthetic: Boolean(msg.isSynthetic),
          });
        }
      }
      break;
    }
    case 'result': {
      meta.status = 'idle';
      meta.costUsd = Number(msg.total_cost_usd || 0);
      meta.turns = Number(msg.num_turns || 0);
      meta.sdkSessionId = msg.session_id;
      meta.lastResult = msg.subtype;
      events.push(resultEvent(msg));
      break;
    }
    case 'stream_event': {
      const ev = msg.event;
      if (!ev) break;
      if (ev.type === 'message_start' && ev.message?.id) {
        if (streamState) streamState.messageId = ev.message.id;
        events.push({ event: 'message_start', id: uid(), messageId: ev.message.id, ts });
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        events.push({
          event: 'delta',
          id: uid(),
          messageId: streamState?.messageId || ev.message_id || msg.uuid,
          blockIndex: ev.index ?? 0,
          text: ev.delta.text,
          ts,
        });
      }
      break;
    }
    case 'tool_progress': {
      events.push({
        event: 'tool_progress',
        id: uid(),
        toolUseId: msg.tool_use_id,
        elapsedSeconds: msg.elapsed_seconds,
        ts,
      });
      break;
    }
    case 'tool_use_summary': {
      events.push({
        event: 'tool_summary',
        id: uid(),
        toolUseId: msg.tool_use_id,
        summary: msg.summary || '',
        ts,
      });
      break;
    }
    case 'auth_status': {
      if (msg.error) events.push({ event: 'error', id: uid(), text: `认证错误：${msg.error}`, ts });
      break;
    }
    default:
      break;
  }
  return { events, meta };
}

/**
 * Normalize a historical SessionMessage returned by getSessionMessages().
 */
export function normalizeHistoryMessage(sm) {
  if (!sm || typeof sm !== 'object') return [];
  if (sm.isSidechain === true) return [];
  const ts = sm.timestamp || sm.message?.timestamp || new Date().toISOString();
  const origin = sm.origin || (sm.turnOrigin === 'peer' ? { kind: 'peer' } : null);
  if (origin?.kind === 'peer') {
    const sourceText = origin.body || contentToText(sm.message?.content);
    const body = origin.body ? String(origin.body) : stripCrossSession(sourceText);
    const fromName = origin.name || origin.from || '另一个会话';
    const isPhone = origin.from === 'remotedeck-phone' || /RemoteDeck/i.test(fromName);
    if (isPhone) {
      const cleanBody = body.replace(/^【用户从手机打断】[^\n]*\n?/, '');
      return [{
        event: 'user',
        id: origin.msg_id ? `phone:${origin.msg_id}` : sm.uuid,
        text: clip(cleanBody),
        source: 'phone',
        peerName: fromName,
        ts,
      }];
    }
    return [{
      event: 'system',
      id: sm.uuid,
      text: `来自 ${fromName} 的会话消息：${clip(body, 3000)}`,
      source: 'peer',
      peerName: fromName,
      ts,
    }];
  }
  if (sm.isMeta === true) return [];
  if (sm.type === 'assistant') {
    return assistantEvents({ message: sm.message, uuid: sm.uuid, timestamp: ts });
  }
  if (sm.type === 'user') {
    const events = toolResultEvents({ message: sm.message }, ts);
    if (events.length) return events;
    const text = contentToText(sm.message?.content);
    if (!text) return [];
    return [{ event: 'user', id: sm.uuid, text: clip(text), source: 'user', ts }];
  }
  if (sm.type === 'system') {
    const text = contentToText(sm.message?.content);
    if (!text) return [];
    return [{ event: 'system', id: sm.uuid, text: clip(text), ts }];
  }
  return [];
}

export function normalizeHistory(messages) {
  const out = [];
  for (const message of messages || []) {
    out.push(...normalizeHistoryMessage(message));
  }
  return out;
}
