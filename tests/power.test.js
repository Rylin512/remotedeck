import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePowerRequest, actionRequirements } from '../server/system/power.js';

test('power action requires the exact confirmation word', () => {
  assert.throws(() => validatePowerRequest({ action: 'shutdown', confirm: 'shutdown' }), /关机/);
  assert.throws(() => validatePowerRequest({ action: 'nope', confirm: '关机' }), /无效/);
  const req = validatePowerRequest({ action: 'shutdown', confirm: '关机', delaySeconds: 10 });
  assert.equal(req.action, 'shutdown');
  assert.equal(req.delaySeconds, 10);
});

test('power delay is clamped', () => {
  assert.equal(validatePowerRequest({ action: 'restart', confirm: '重启', delaySeconds: -5 }).delaySeconds, 0);
  assert.equal(validatePowerRequest({ action: 'restart', confirm: '重启', delaySeconds: 999999 }).delaySeconds, 3600);
});

test('confirmation words are localized', () => {
  assert.equal(actionRequirements('shutdown').confirm, '关机');
  assert.equal(actionRequirements('cancel').confirm, '取消');
});
