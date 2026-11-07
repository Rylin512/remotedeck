import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEditDiff } from '../public/diff.js';

test('Edit renders added and removed lines with stats', () => {
  const diff = buildEditDiff('Edit', {
    file_path: 'src/app.js',
    old_string: 'const a = 1;\nconst b = 2;\nconst c = 3;',
    new_string: 'const a = 1;\nconst b = 20;\nconst c = 3;',
  });
  assert.ok(diff);
  assert.equal(diff.adds, 1);
  assert.equal(diff.dels, 1);
  assert.ok(diff.lines.some((line) => line.type === 'add' && line.text === 'const b = 20;'));
  assert.ok(diff.lines.some((line) => line.type === 'del' && line.text === 'const b = 2;'));
  assert.ok(!JSON.stringify(diff).includes('file_path'));
});

test('MultiEdit produces multiple diff blocks', () => {
  const diff = buildEditDiff('MultiEdit', {
    file_path: 'src/app.js',
    edits: [
      { old_string: 'one\ntwo', new_string: 'one\nTWO' },
      { old_string: 'three', new_string: 'three\nfour' },
    ],
  });
  assert.ok(diff);
  assert.equal(diff.adds, 2);
  assert.equal(diff.dels, 1);
  assert.equal(diff.lines.filter((line) => line.type === 'sep').length, 1);
});

test('Edit with only an insertion shows green additions', () => {
  const diff = buildEditDiff('Edit', {
    old_string: 'line 1\nline 3',
    new_string: 'line 1\nline 2\nline 3',
  });
  assert.equal(diff.adds, 1);
  assert.equal(diff.dels, 0);
  assert.equal(diff.lines.find((line) => line.type === 'add').text, 'line 2');
});
