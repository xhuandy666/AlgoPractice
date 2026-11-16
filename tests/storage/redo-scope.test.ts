import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { redoScope } from '../../src/renderer/redo-scope.ts';

test('a rewrite gets a blank scope beside the practice draft and is resumed until it is finished', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-redo-scope-'));
  const store = new PracticeStore(join(directory, 'practice.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const problem = store.upsertProblem({ id: 'leetcode:two-sum', source: 'leetcode-cn', sourceUrl: 'https://leetcode.cn/problems/two-sum/', sourceId: '1',
    title: '两数之和', difficulty: '简单', tags: ['数组'], description: '题面', descriptionFormat: 'plain', constraints: [], mode: 'function',
    adapter: { method: 'f', params: ['int'], returns: 'int' }, cases: [{ args: [1] }], starter: { python: 'class Solution:\n    def f(self, n: int) -> int:\n        ' } });
  const begin = (scope: string) => store.startAttempt({ problemId: problem.id, language: 'python', problemVersion: problem.version, problemSnapshot: problem.content as never, draftScopeId: scope });
  const api = { attemptPage: async (filter: Parameters<PracticeStore['listAttemptPage']>[0]) => store.listAttemptPage(filter) };
  const ids = ['first', 'second'], next = () => ids.shift()!;

  const practice = begin('practice');
  const solved = store.saveDraft({ problemId: problem.id, language: 'python', code: 'class Solution:\n    def f(self, n): return n\n' });
  const scope = await redoScope(api, problem.id, 'python', next);
  assert.equal(scope, 'redo:first', 'no rewrite is open yet, and the practice attempt is not one');
  const redo = begin(scope);
  assert.equal(store.getDraft(problem.id, 'python', scope), undefined, 'the rewrite starts from the template, not from the practice code');
  assert.deepEqual(store.getDraft(problem.id, 'python'), solved, 'the practice draft is untouched');
  assert.deepEqual(store.listAttemptPage({ problemId: problem.id, state: 'active' }).items.map(item => item.attempt.id).sort(), [practice.id, redo.id].sort());

  store.saveDraft({ problemId: problem.id, language: 'python', code: 'class Solution:\n    def f(self, n):\n        # 重写中\n', scopeId: scope });
  assert.equal(await redoScope(api, problem.id, 'python', next), 'redo:first', 'an unfinished rewrite is resumed instead of starting another attempt');
  assert.equal(await redoScope(api, problem.id, 'java', () => 'java'), 'redo:java', 'rewrites are per language');

  store.finishAttempt(redo.id);
  assert.equal(await redoScope(api, problem.id, 'python', next), 'redo:second', 'after finishing, the next rewrite is blank again');
  assert.equal(store.getActiveAttempt(problem.id, 'python')?.id, practice.id, 'the practice attempt stays active throughout');
});
