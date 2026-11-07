import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSdkMessage, normalizeHistoryMessage, toolTitle } from '../server/claude/normalize.js';

test('system init exposes session metadata', () => {
  const { events, meta } = normalizeSdkMessage({
    type: 'system', subtype: 'init', session_id: 's1', model: 'm', permissionMode: 'default',
    tools: ['Read'], slash_commands: ['/x'], cwd: 'C:\\work', claude_code_version: '2.0', uuid: 'u1',
  });
  assert.equal(meta.sdkSessionId, 's1');
  assert.equal(meta.model, 'm');
  assert.equal(meta.status, 'idle');
  assert.equal(events[0].event, 'status');
});

test('assistant blocks become text, thinking and tool events', () => {
  const { events } = normalizeSdkMessage({
    type: 'assistant', uuid: 'u1', session_id: 's1', timestamp: '2026-01-01T00:00:00Z',
    message: {
      id: 'msg1', model: 'm',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'echo hi' } },
      ],
    },
  });
  assert.deepEqual(events.map((e) => e.event), ['thinking', 'assistant', 'tool_use']);
  assert.equal(events[1].text, 'hello');
  assert.equal(events[2].toolUseId, 'tool1');
  assert.equal(events[2].title, 'echo hi');
  assert.ok(events[0].tokens >= 1);
  assert.equal(events[0].estimated, true);
});

test('thinking events use exact token details when available', () => {
  const { events } = normalizeSdkMessage({
    type: 'assistant', uuid: 'u-token', session_id: 's1', timestamp: '2026-01-01T00:00:00Z',
    message: {
      id: 'msg-token',
      content: [{ type: 'thinking', thinking: 'a longer thought' }],
      usage: { output_tokens_details: { thinking_tokens: 42 } },
    },
  });
  assert.equal(events[0].event, 'thinking');
  assert.equal(events[0].tokens, 42);
  assert.equal(events[0].estimated, false);
});

test('tool results are paired by tool_use_id', () => {
  const { events } = normalizeSdkMessage({
    type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:01Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'ok', is_error: false }] },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'tool_result');
  assert.equal(events[0].toolUseId, 'tool1');
  assert.equal(events[0].text, 'ok');
});

test('result message carries cost and error state', () => {
  const { events, meta } = normalizeSdkMessage({
    type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.1,
    duration_ms: 1234, num_turns: 2, session_id: 's1', permission_denials: [],
  });
  assert.equal(meta.status, 'idle');
  assert.equal(events[0].event, 'result');
  assert.equal(events[0].costUsd, 0.1);
  assert.equal(events[0].durationMs, 1234);
});

test('stream deltas use the current message id', () => {
  const state = { messageId: null };
  normalizeSdkMessage({
    type: 'stream_event', session_id: 's1',
    event: { type: 'message_start', message: { id: 'msg-live' } },
  }, state);
  assert.equal(state.messageId, 'msg-live');
  const { events } = normalizeSdkMessage({
    type: 'stream_event', session_id: 's1',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
  }, state);
  assert.equal(events[0].event, 'delta');
  assert.equal(events[0].messageId, 'msg-live');
  assert.equal(events[0].text, 'Hi');
});

test('history assistant and user messages normalize', () => {
  const assistant = normalizeHistoryMessage({
    type: 'assistant', uuid: 'h1', timestamp: '2026-01-01T00:00:00Z',
    message: { id: 'm1', content: [{ type: 'text', text: 'from history' }] },
  });
  assert.equal(assistant[0].event, 'assistant');
  assert.equal(assistant[0].text, 'from history');
  const user = normalizeHistoryMessage({
    type: 'user', uuid: 'h2', timestamp: '2026-01-01T00:00:01Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  });
  assert.equal(user[0].event, 'user');
  assert.equal(user[0].source, 'user');
});

test('phone-delivered peer messages render as phone bubbles with a stable id', () => {
  const events = normalizeHistoryMessage({
    type: 'user', uuid: 'h3', isMeta: true, timestamp: '2026-01-01T00:00:02Z',
    message: { role: 'user', content: 'Another Claude session sent a message: ...' },
    origin: {
      kind: 'peer', from: 'remotedeck-phone', msg_id: 'msg-42',
      name: 'RemoteDeck 手机', body: 'please run the focused test',
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'user');
  assert.equal(events[0].source, 'phone');
  assert.equal(events[0].id, 'phone:msg-42');
  assert.equal(events[0].text, 'please run the focused test');
});

test('non-phone peer messages do not masquerade as the local user', () => {
  const events = normalizeHistoryMessage({
    type: 'user', uuid: 'h4', isMeta: true, timestamp: '2026-01-01T00:00:03Z',
    message: { role: 'user', content: 'peer content' },
    origin: { kind: 'peer', from: 'other-agent', msg_id: 'msg-7', name: 'api-worker', body: 'schema migrated' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'system');
  assert.equal(events[0].source, 'peer');
});

test('tool title picks useful fields', () => {
  assert.equal(toolTitle('Read', { file_path: 'C:\\a.txt' }), 'C:\\a.txt');
  assert.equal(toolTitle('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(toolTitle('Bash', { command: 'long script', description: 'Find tables, scroll containers' }), 'Find tables, scroll containers');
  assert.equal(toolTitle('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  assert.equal(toolTitle('TodoWrite', { todos: [{ content: 'Check layout' }] }), 'Check layout');
  assert.equal(toolTitle('mcp__browser__click', {}), 'browser / click');
  assert.equal(toolTitle('Bash', { command: 'cd "C:\\project" && npm test' }), 'npm test');
});
