import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { validateWorkspace } from '../server/claude/manager.js';

test('workspace validation accepts a directory inside an allowed root', async () => {
  const dir = await fs.mkdtemp(path.join(ROOT, '.tmp-workspace-'));
  try {
    const real = await validateWorkspace(dir, [ROOT]);
    assert.equal(real, await fs.realpath(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('workspace validation rejects missing and outside directories', async () => {
  await assert.rejects(validateWorkspace(path.join(ROOT, 'missing-nope'), [ROOT]), /不存在/);
  await assert.rejects(validateWorkspace('C:\\Windows', [path.join(ROOT)]), /允许/);
});
