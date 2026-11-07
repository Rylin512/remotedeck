import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapCrossSession, stripCrossSession } from '../server/claude/peer.js';

test('cross-session wrapper carries sender metadata', () => {
  const wrapped = wrapCrossSession('hello', { from: 'remotedeck-phone', fromName: 'RemoteDeck 手机' });
  assert.match(wrapped, /<cross-session-message/);
  assert.match(wrapped, /from="remotedeck-phone"/);
  assert.match(wrapped, /from-name="RemoteDeck 手机"/);
  assert.match(wrapped, /\nhello\n/);
});

test('stripCrossSession returns only the body', () => {
  const wrapped = wrapCrossSession('line one\nline two');
  assert.equal(stripCrossSession(wrapped), 'line one\nline two');
  assert.equal(stripCrossSession('plain text'), 'plain text');
});
