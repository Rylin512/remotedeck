import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginWatcher } from '../server/claude/plugin-watcher.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('marking a plugin session closed removes it from the live list', async () => {
  const root = await fs.mkdtemp(path.join(here, '..', '.tmp-plugin-close-'));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'c--Users-demo-project');
  await fs.mkdir(project, { recursive: true });
  const id = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const file = path.join(project, `${id}.jsonl`);
  await fs.writeFile(file, `${JSON.stringify({
    type: 'user', uuid: 'u1', cwd: 'C:\\Users\\demo\\project', sessionId: id,
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' },
  })}\n`);

  const hub = { broadcast: () => {} };
  const watcher = new PluginWatcher({ hub, projectsDir: projects, liveResolver: () => true });
  watcher.start();
  try {
    await sleep(1400);
    assert.equal(watcher.list().length, 1);
    watcher.markClosed(id);
    assert.equal(watcher.list().length, 0);
  } finally {
    watcher.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('sessions without a live process are not shown in the live list', async () => {
  const root = await fs.mkdtemp(path.join(here, '..', '.tmp-plugin-offline-'));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'c--Users-demo-project');
  await fs.mkdir(project, { recursive: true });
  const id = 'cccccccc-dddd-eeee-ffff-000000000000';
  const file = path.join(project, `${id}.jsonl`);
  await fs.writeFile(file, `${JSON.stringify({
    type: 'user', uuid: 'u1', cwd: 'C:\\Users\\demo\\project', sessionId: id,
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'ended session' },
  })}\n`);

  const watcher = new PluginWatcher({ hub: { broadcast: () => {} }, projectsDir: projects });
  watcher.start();
  try {
    await sleep(1400);
    assert.equal(watcher.list().length, 0);
    const data = await watcher.getSession(id);
    assert.ok(data.messages.some((m) => m.text === 'ended session'));
  } finally {
    watcher.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('outgoing phone messages are not duplicated when the transcript catches up', async () => {
  const root = await fs.mkdtemp(path.join(here, '..', '.tmp-plugin-phone-'));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'c--Users-demo-project');
  await fs.mkdir(project, { recursive: true });
  const id = 'dddddddd-eeee-ffff-0000-111111111111';
  const file = path.join(project, `${id}.jsonl`);
  const base = { cwd: 'C:\\Users\\demo\\project', sessionId: id, timestamp: new Date().toISOString() };
  await fs.writeFile(file, `${JSON.stringify({
    ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' },
  })}\n`);

  const watcher = new PluginWatcher({ hub: { broadcast: () => {} }, projectsDir: projects, liveResolver: () => true });
  watcher.start();
  try {
    await sleep(1300);
    watcher.noteOutgoing(id, { msgId: 'phone-msg-1', text: '请创建 PR' });
    await fs.appendFile(file, `${JSON.stringify({
      ...base,
      type: 'user',
      uuid: 'u-phone-transcript',
      origin: { kind: 'peer', from: 'remote-uuid', name: 'RemoteDeck', msg_id: 'different-id', body: '请创建 PR' },
      message: { role: 'user', content: '请创建 PR' },
    })}\n`);
    await sleep(1600);
    const data = await watcher.getSession(id);
    const phoneMessages = data.messages.filter((m) => m.source === 'phone' && m.text === '请创建 PR');
    assert.equal(phoneMessages.length, 1);
  } finally {
    watcher.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pendingPrompt captures an unanswered AskUserQuestion', async () => {
  const root = await fs.mkdtemp(path.join(here, '..', '.tmp-plugin-pending-'));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'c--Users-demo-project');
  await fs.mkdir(project, { recursive: true });
  const id = '11111111-2222-3333-4444-555555555555';
  const file = path.join(project, `${id}.jsonl`);
  const base = { cwd: 'C:\\Users\\demo\\project', sessionId: id, timestamp: new Date().toISOString() };
  await fs.writeFile(file, `${JSON.stringify({
    ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: 'ask me' },
  })}\n${JSON.stringify({
    ...base, type: 'assistant', uuid: 'a1',
    message: {
      id: 'm1',
      content: [{
        type: 'tool_use',
        id: 'question-1',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] },
      }],
    },
  })}\n`);
  const watcher = new PluginWatcher({ hub: { broadcast: () => {} }, projectsDir: projects, liveResolver: () => true });
  watcher.start();
  try {
    await sleep(1400);
    const pending = await watcher.pendingPrompt(id);
    assert.equal(pending.kind, 'question');
    assert.equal(pending.questions[0].question, 'Which one?');
  } finally {
    watcher.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('plugin watcher discovers and streams appended transcript lines', async () => {
  const root = await fs.mkdtemp(path.join(here, '..', '.tmp-plugin-'));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'c--Users-demo-project');
  await fs.mkdir(project, { recursive: true });
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const file = path.join(project, `${id}.jsonl`);
  const base = { cwd: 'C:\\Users\\demo\\project', sessionId: id, timestamp: new Date().toISOString() };
  await fs.writeFile(file, `${JSON.stringify({
    ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello from plugin' },
  })}\n`);

  const messages = [];
  const hub = { broadcast: (type, payload) => messages.push({ type, payload }) };
  const watcher = new PluginWatcher({ hub, projectsDir: projects, liveResolver: () => true });
  watcher.start();
  try {
    await sleep(1400);
    const list = watcher.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    assert.equal(list[0].cwd, 'C:\\Users\\demo\\project');

    await fs.appendFile(file, `${JSON.stringify({
      ...base, type: 'assistant', uuid: 'a1',
      message: { id: 'm1', content: [{ type: 'text', text: 'live answer' }] },
    })}\n`);
    await sleep(1600);
    const pluginEvents = messages.filter((m) => m.type === 'plugin_event');
    assert.ok(pluginEvents.some((m) => m.payload.event.event === 'assistant' && m.payload.event.text === 'live answer'));

    const data = await watcher.getSession(id);
    assert.ok(data.messages.some((m) => m.text === 'hello from plugin'));
    assert.ok(data.messages.some((m) => m.text === 'live answer'));
  } finally {
    watcher.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
