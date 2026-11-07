import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, validatePassword, hashToken, safeEqual,
  LoginLimiter, parseCookies, isLoopbackAddress,
} from '../server/auth.js';

test('password policy requires a reasonable password', () => {
  assert.ok(validatePassword('short'));
  assert.ok(validatePassword('aaaaaaaaaaaa'));
  assert.equal(validatePassword('RemoteDeck-2026'), null);
  assert.equal(validatePassword('a-long-passphrase'), null);
});

test('scrypt passwords verify and reject wrong input', async () => {
  const hash = await hashPassword('RemoteDeck-2026');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('RemoteDeck-2026', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
  assert.equal(await verifyPassword('RemoteDeck-2026', 'garbage'), false);
});

test('token hashes and constant-time comparison', () => {
  const token = 'abc123';
  assert.equal(hashToken(token).length, 64);
  assert.equal(safeEqual(token, token), true);
  assert.equal(safeEqual(token, 'abc124'), false);
  assert.equal(safeEqual(token, 'abc12'), false);
});

test('cookie parser handles encoded values', () => {
  assert.deepEqual(parseCookies('a=1; rd_session=x%20y; b=2'), { a: '1', rd_session: 'x y', b: '2' });
  assert.deepEqual(parseCookies(''), {});
});

test('loopback detection handles IPv4-mapped IPv6', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.2'), false);
});

test('login limiter blocks after repeated failures and resets on success', () => {
  const limiter = new LoginLimiter({ maxFailures: 2, baseDelayMs: 1000, maxDelayMs: 5000 });
  assert.equal(limiter.get('ip').blocked, false);
  limiter.fail('ip');
  assert.equal(limiter.get('ip').blocked, false);
  limiter.fail('ip');
  const blocked = limiter.get('ip');
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterMs > 0);
  limiter.success('ip');
  assert.equal(limiter.get('ip').blocked, false);
});
