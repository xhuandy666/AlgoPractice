import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import type { RunStatus } from '../../src/runner/types.ts';
import type { ExpectedOutputSource } from '../../src/shared/answer-format.ts';

const accepted = { status: 'accepted' as const, statusCode: 10, statusMessage: 'Accepted' };
const wrongAnswer = { status: 'wrong_answer' as const, statusMessage: 'Wrong Answer' };

function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-12T08:00:00.000Z') });
  const directory = mkdtempSync(join(tmpdir(), 'tilian-archive-statistics-'));
  const store = new PracticeStore(join(directory, 'practice.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.updateLearningSettings({ timeZone: 'UTC' });
  let submissions = 1000;
  const practice = (slug: string, sourceId: string) => {
    const problem = store.upsertProblem({ id: `leetcode:${slug}`, source: 'leetcode-cn', sourceUrl: `https://leetcode.cn/problems/${slug}/`, sourceId,
      title: slug, difficulty: '简单', tags: [], description: '测试题面', descriptionFormat: 'plain', constraints: [], mode: 'function', cases: [],
      starter: { python: 'class Solution:\n    pass' } });
    const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language: 'python', problemSnapshot: problem.content as never });
    const draft = store.saveDraft({ problemId: problem.id, language: 'python', code: problem.content.starter.python! });
    const run = (status: RunStatus, expectedOutputSource: ExpectedOutputSource = 'native-samples') =>
      store.saveRun({ attemptId: attempt.id, code: draft.code, testSuiteVersion: 'local', expectedOutputSource, adapterVersion: '1', runtimeVersion: '1', status });
    const official = (requestId: string, result: typeof accepted | typeof wrongAnswer) => {
      const record = store.beginOfficialSubmission({ requestId, attemptId: attempt.id, code: draft.code, expectedDraftRevision: draft.revision, slug, sourceId });
      store.updateOfficialSubmission(record.id, { status: 'judging', submissionId: String(++submissions) });
      return store.updateOfficialSubmission(record.id, { status: 'completed', result });
    };
    return { problem, attempt, draft, run, official };
  };
  return { store, practice };
}

test('archive statistics separate practice runs, count official Accepted per distinct problem, and solve problems locally or officially', t => {
  const { store, practice } = fixture(t);
  const local = practice('two-sum', '1');
  for (const status of ['passed', 'completed', 'wrong_answer', 'compile_error', 'cancelled', 'environment_error', 'internal_error'] as const) local.run(status);
  local.official('two-sum-wa', wrongAnswer);
  local.official('two-sum-ac', accepted);
  const official = practice('valid-anagram', '242');
  official.official('anagram-ac-1', accepted);
  official.official('anagram-ac-2', accepted);
  const unsolved = practice('climbing-stairs', '70');
  unsolved.run('completed');

  const all = store.getArchiveStatistics(), today = all.days.find(row => row.date === '2026-11-12')!;
  assert.deepEqual([today.runs, today.passedRuns, today.practiceRuns], [8, 1, 4], 'only completed, wrong-answer and compile-error outcomes count as practice runs here');
  // A pass against expected outputs the user typed in proves nothing about the problem, but it is practice: it must not earn less than a wrong answer.
  unsolved.run('passed', 'user');
  const withSelfTest = store.getArchiveStatistics(), selfTestDay = withSelfTest.days.find(row => row.date === '2026-11-12')!;
  assert.deepEqual([selfTestDay.runs, selfTestDay.passedRuns, selfTestDay.practiceRuns], [9, 1, 5]);
  assert.equal(withSelfTest.solvedProblems, all.solvedProblems, 'a self-made expectation still never solves a problem');
  assert.equal(today.officialAccepted, 2, 'two Accepted submissions of one problem on one day count once');
  assert.deepEqual([all.solvedProblems, all.officialSolvedProblems], [2, 2], 'a local pass and an official Accepted of one problem solve it once; output-only runs solve nothing');

  const scoped = store.getArchiveStatistics({ attemptId: official.attempt.id });
  assert.deepEqual([scoped.runs, scoped.solvedProblems, scoped.officialSolvedProblems, scoped.days[0].officialAccepted], [0, 1, 1, 1], 'the attempt filter applies to official results too');

  store.finishAttempt(official.attempt.id, { code: official.draft.code });
  assert.equal(store.deleteEndedAttempt(official.attempt.id), true);
  const afterDelete = store.getArchiveStatistics();
  assert.deepEqual([afterDelete.solvedProblems, afterDelete.officialSolvedProblems, afterDelete.days.find(row => row.date === '2026-11-12')!.officialAccepted], [1, 1, 1],
    'deleting an archive removes its official results from statistics like its local runs');
});

test('official verdicts decide completion: an Accepted completes at once, a rejected final code does not complete when ended', t => {
  const { store, practice } = fixture(t);
  const rejected = practice('rejected-final', '7');
  rejected.official('rejected-final-wa', wrongAnswer);
  store.finishAttempt(rejected.attempt.id, { code: rejected.draft.code });
  const open = practice('accepted-open', '8');
  open.official('accepted-open-ac', accepted);
  const late = practice('accepted-late', '9');
  const record = store.beginOfficialSubmission({ requestId: 'late-ac', attemptId: late.attempt.id, code: late.draft.code,
    expectedDraftRevision: late.draft.revision, slug: 'accepted-late', sourceId: '9' });
  store.updateOfficialSubmission(record.id, { status: 'judging', submissionId: '9901' });
  store.updateOfficialSubmission(record.id, { status: 'paused' });
  store.finishAttempt(late.attempt.id);
  const day = (date: string) => store.getArchiveStatistics().days.find(row => row.date === date)?.completedProblems ?? 0;
  assert.equal(day('2026-11-12'), 2, 'the open Accepted and the practice ended while its submission waited; not the rejected one');
  assert.deepEqual(store.attemptCompletion(rejected.attempt.id), { completedAt: null, notCountedBecause: 'failed' });
  assert.deepEqual(store.attemptCompletion(open.attempt.id), { completedAt: store.getOfficialSubmission('accepted-open-ac')!.finishedAt, notCountedBecause: null });
  assert.equal(store.attemptCompletion(late.attempt.id).completedAt, store.getAttempt(late.attempt.id)!.endedAt, 'a submission still waiting for its verdict counts as having submitted the final code');
  t.mock.timers.setTime(Date.parse('2026-11-13T08:00:00.000Z'));
  store.updateOfficialSubmission(record.id, { status: 'judging' });
  store.updateOfficialSubmission(record.id, { status: 'completed', result: accepted });
  assert.deepEqual([day('2026-11-12'), day('2026-11-13')], [2, 0], 'an Accepted that lands after the end keeps the earlier completion');
  assert.equal(store.getLearningDashboard().days.find(row => row.date === '2026-11-12')!.completedProblems, 2, 'the dashboard agrees');
});

test('a pass on cases the user typed in is a self-check: it neither solves the problem nor counts as a passed run', t => {
  const { store, practice } = fixture(t);
  const own = practice('fizz-buzz', '412');
  own.run('passed', 'user'); own.run('passed', 'user');
  const stats = store.getArchiveStatistics(), today = stats.days.find(row => row.date === '2026-11-12')!;
  assert.deepEqual([today.runs, today.passedRuns, stats.passedRuns, stats.solvedProblems], [2, 0, 0, 0]);
  own.run('passed');
  const after = store.getArchiveStatistics();
  assert.deepEqual([after.passedRuns, after.solvedProblems], [1, 1], 'a pass on the problem\'s own cases still solves it');
});
