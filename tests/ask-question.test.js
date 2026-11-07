import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeManager } from '../server/claude/manager.js';

test('AskUserQuestion answers are returned through updatedInput.answers', async () => {
  const events = [];
  const hub = { broadcast: (type, payload) => events.push({ type, payload }) };
  const manager = new ClaudeManager({ hub });
  const session = {
    id: 'question-test',
    title: 'Question test',
    status: 'running',
    closed: false,
    messages: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
  };
  manager.sessions.set(session.id, session);

  const promise = manager.askUserQuestion(session, {
    questions: [
      {
        header: 'PR',
        question: '是否创建 PR？',
        multiSelect: false,
        options: [{ label: '创建' }, { label: '暂不' }],
      },
      {
        header: '目标',
        question: '合并到哪个分支？',
        multiSelect: true,
        options: [{ label: 'main' }, { label: 'release' }],
      },
    ],
  }, { requestId: 'question-request' });

  const question = events.find((item) => item.type === 'question')?.payload?.question;
  assert.equal(question.questions.length, 2);
  assert.equal(question.questions[1].multiSelect, true);

  manager.resolveQuestion(session.id, 'question-request', {
    '是否创建 PR？': '创建',
    '合并到哪个分支？': ['main', 'release'],
  });
  const result = await promise;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedInput.answers, {
    '是否创建 PR？': '创建',
    '合并到哪个分支？': 'main, release',
  });
  assert.equal(session.pendingQuestions.size, 0);
});
