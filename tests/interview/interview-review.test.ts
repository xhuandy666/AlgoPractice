import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InterviewView } from '../../src/shared/interview.ts';
import { addInterviewReviews, unpassedInterviewProblems } from '../../src/renderer/interview-review.ts';

const answer = (codeHash: string) => ({ code: '', codeHash, revision: 1, savedAt: '2026-11-12T08:00:00.000Z', reasoning: '' });
const row = (id: string, final: string, runs: [codeHash: string, status: string][]) => ({
  item: { problem: { id, content: { title: id.toUpperCase() } }, attemptId: `attempt-${id}`, scopeId: `scope-${id}`, accepted: answer('accepted'), final: answer(final) },
  runs: runs.map(([codeHash, status], index) => ({ id: `${id}-${index}`, codeHash, status })),
});
const view = (...items: ReturnType<typeof row>[]) => ({ session: { endedAt: '2026-11-12T09:00:00.000Z' }, items, remainingMs: 0 }) as unknown as InterviewView;

test('only problems whose frozen answer passed locally stay out of the review batch', () => {
  const report = view(
    row('passed', 'final', [['final', 'wrong_answer'], ['final', 'passed']]),
    row('regressed', 'final', [['final', 'passed'], ['final', 'wrong_answer']]),
    row('passed-earlier-code', 'final', [['draft', 'passed']]),
    row('never-run', 'final', []),
    row('not-judged', 'final', [['final', 'completed']]),
    row('waiting', 'final', [['final', 'passed'], ['final', 'queued']]),
  );
  assert.deepEqual(unpassedInterviewProblems(report).map(problem => problem.id), ['regressed', 'passed-earlier-code', 'never-run', 'not-judged'],
    'judged on the latest finished run of the frozen code; a pass on other code or a still-queued run does not change it');
  assert.deepEqual(unpassedInterviewProblems(report)[0], { id: 'regressed', title: 'REGRESSED' });
});

test('adding stops at the first failure and reports how many were added', async () => {
  const added: string[] = [];
  assert.deepEqual(await addInterviewReviews(async id => { added.push(id); }, ['a', 'b']), { added: 2 });
  const failure = new Error('请先结束本场，再加入复习。');
  const result = await addInterviewReviews(async id => { if (id === 'c') throw failure; added.push(id); }, ['b', 'c', 'd']);
  assert.deepEqual(result, { added: 1, error: failure });
  assert.deepEqual(added, ['a', 'b', 'b'], 'd is never attempted after c fails');
});
