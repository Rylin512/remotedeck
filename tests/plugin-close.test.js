import test from 'node:test';
import assert from 'node:assert/strict';
import { closePluginSession } from '../server/claude/plugin-close.js';

test('closing a plugin session requires the confirmation word', async () => {
  await assert.rejects(
    closePluginSession('00000000-0000-0000-0000-000000000000', { confirm: 'stop' }),
    /关闭/,
  );
});

test('closing a missing plugin session is reported without killing anything', async () => {
  await assert.rejects(
    closePluginSession('00000000-0000-0000-0000-000000000000', { confirm: '关闭' }),
    /找不到|已经结束/,
  );
});
