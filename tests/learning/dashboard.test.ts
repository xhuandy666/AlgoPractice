import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { restoreBackup } from '../restore-backup.ts';
import type { RunStatus } from '../../src/runner/types.ts';
import type { ExpectedOutputSource } from '../../src/shared/answer-format.ts';

function fixture(t: test.TestContext, at = '2026-09-13T08:00:00.000Z') {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(at) });
  const directory = mkdtempSync(join(tmpdir(), 'tilian-dashboard-')), path = join(directory, 'practice.sqlite');
  const store = new PracticeStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.updateLearningSettings({ timeZone: 'Asia/Shanghai' });
  const clock = (date: string) => t.mock.timers.setTime(new Date(date).getTime());
  const start = (problemId = 'p1', language: 'python' | 'java' = 'python') => store.startAttempt({ problemId, language, problemVersion: 'v1' });
  return { store, path, directory, clock, start };
}

test('a problem completes at its first solve, or when its practice ends after its final code ran without failing; once per problem and day', t => {
  const { store, start, clock } = fixture(t);
  const run = (attemptId: string, code: string, status: RunStatus, expectedOutputSource: ExpectedOutputSource = 'native-samples') =>
    store.saveRun({ attemptId, code, testSuiteVersion: 'local', expectedOutputSource, adapterVersion: '1', runtimeVersion: '1', status });
  const today = () => store.getLearningDashboard().days.at(-1)!;
  const solved = start('solved');
  run(solved.id, 'print(1)', 'wrong_answer');
  assert.equal(today().completedProblems, 0, 'a failing run completes nothing');
  run(solved.id, 'print(2)', 'passed'); run(solved.id, 'print(2)', 'passed');
  assert.equal(today().completedProblems, 1, 'passing the problem\'s own cases completes it without ending the practice');
  store.finishAttempt(start('solved', 'java').id, { code: 'unrun final draft' });
  assert.equal(today().completedProblems, 1, 'another language of the same problem counts once');
  const ran = start('ran-unjudged');
  run(ran.id, 'print(3)', 'completed', 'none');
  assert.equal(today().completedProblems, 1, 'output nothing can judge is not a solve');
  store.finishAttempt(ran.id, { code: 'print(3)' });
  assert.equal(today().completedProblems, 2, 'ending after the final code ran and nothing could judge it completes the practice');
  const selfChecked = start('self-checked');
  run(selfChecked.id, 'print(4)', 'passed', 'user');
  assert.equal(today().completedProblems, 2, 'passing cases the user typed in is not a solve');
  store.finishAttempt(selfChecked.id, { code: 'print(4)' });
  assert.equal(today().completedProblems, 3, 'ending after that self-check completes the practice');
  const unrun = start('never-run'); store.finishAttempt(unrun.id, { code: 'print(5)' });
  const edited = start('edited-after-run');
  run(edited.id, 'print(6)', 'completed', 'none'); store.finishAttempt(edited.id, { code: 'print(7)' });
  assert.equal(today().completedProblems, 3, 'ending without having run the final code completes nothing');
  const rejected = start('rejected');
  run(rejected.id, 'print(8)', 'wrong_answer'); store.finishAttempt(rejected.id, { code: 'print(8)' });
  const broken = start('compile-error');
  run(broken.id, 'print(', 'compile_error', 'none'); store.finishAttempt(broken.id, { code: 'print(' });
  const cancelled = start('failed-then-cancelled');
  run(cancelled.id, 'print(9)', 'wrong_answer'); run(cancelled.id, 'print(9)', 'cancelled'); store.finishAttempt(cancelled.id, { code: 'print(9)' });
  assert.equal(today().completedProblems, 3, 'ending when the final code last failed completes nothing; a cancelled rerun did not run it');
  assert.deepEqual([unrun, edited, rejected, broken, cancelled].map(attempt => store.attemptCompletion(attempt.id)),
    [...Array(2).fill({ completedAt: null, notCountedBecause: 'unrun' }), ...Array(3).fill({ completedAt: null, notCountedBecause: 'failed' })]);
  assert.deepEqual(store.attemptCompletion(ran.id), { completedAt: store.getAttempt(ran.id)!.endedAt, notCountedBecause: null });
  start('unfinished');
  let dashboard = store.getLearningDashboard();
  const archivedDay = store.getArchiveStatistics().days.find(day => day.date === dashboard.date)!;
  assert.deepEqual([archivedDay.attempts, archivedDay.completedProblems], [10, 3], 'archive days count completions like the dashboard');
  assert.equal(dashboard.totals.activeMs, 0, 'missing historical pulses do not become guessed study time');
  clock('2026-09-14T08:00:00.000Z');
  store.finishAttempt(solved.id, { code: 'print(2)' });
  assert.equal(today().completedProblems, 0, 'ending yesterday\'s solved practice today does not count it again');
  run(start('solved').id, 'print(2)', 'passed');
  dashboard = store.getLearningDashboard();
  assert.equal(dashboard.days.at(-1)!.completedProblems, 1, 'solving it again in a new practice counts today');
  assert.equal(dashboard.days.at(-2)!.completedProblems, 3);
  assert.equal(dashboard.totals.completedProblems, 3, 'the range total deduplicates across days and languages');
  assert.equal(dashboard.totals.activeDays, 2);
  assert.equal(dashboard.days.length, 366);
  assert.equal(dashboard.from, '2025-09-14');
  store.getAttempt = () => { throw new Error('dashboard must not read code or problem snapshots'); };
  store.getProblem = () => { throw new Error('dashboard must not read problem bodies'); };
  assert.equal(store.getLearningDashboard().totals.completedProblems, 3);
});

test('measured pulse intervals split at the learning midnight and heatmap drilldown includes each recorded day once', t => {
  const { store, start, clock } = fixture(t, '2026-09-12T15:59:50.000Z'), attempt = start();
  clock('2026-09-12T16:00:04.000Z');
  const pulse = { requestId: 'cross-midnight', attemptId: attempt.id, durationMs: 10000, occurredAt: new Date().toISOString() };
  store.recordActivity(pulse); store.recordActivity(pulse);
  clock('2026-09-12T16:00:10.000Z');
  store.recordActivity({ ...pulse, requestId: 'after-midnight', durationMs: 6000, occurredAt: new Date().toISOString() });
  store.saveRun({ attemptId: attempt.id, code: '', testSuiteVersion: 'local', expectedOutputSource: 'none', adapterVersion: '1', runtimeVersion: '1', status: 'completed' });
  store.finishAttempt(attempt.id, { code: '' });
  const dashboard = store.getLearningDashboard(), previous = dashboard.days.at(-2)!, today = dashboard.days.at(-1)!;
  assert.equal(previous.date, '2026-09-12'); assert.equal(previous.activeMs, 6000); assert.equal(previous.completedProblems, 0);
  assert.equal(today.date, '2026-09-13'); assert.equal(today.activeMs, 10000); assert.equal(today.completedProblems, 1);
  assert.equal(dashboard.totals.activeMs, 16000);
  const archived = store.getArchiveStatistics({ attemptId: attempt.id });
  assert.equal(archived.activeMs, 16000);
  assert.equal(archived.days.find(day => day.date === '2026-09-12')!.activeMs, previous.activeMs);
  assert.equal(archived.days.find(day => day.date === '2026-09-13')!.activeMs, today.activeMs);
  for (const learningDate of ['2026-09-12', '2026-09-13']) {
    const page = store.listAttemptPage({ learningDate }); assert.equal(page.total, 1); assert.equal(page.items[0].attempt.id, attempt.id);
  }
  assert.equal(store.listAttemptPage({ learningDate: '2026-09-11' }).total, 0);
  assert.equal(store.listAttemptPage({ learningDate: '2026-09-13', timeZone: 'UTC' }).total, 0);
  assert.throws(() => store.listAttemptPage({ learningDate: '2026-02-30' }));
  assert.throws(() => store.listAttemptPage({ timeZone: 'UTC' }), /requires a learning date/);
});

test('a midnight-ending pulse belongs only to the prior day, and long idle gaps add no time or empty archive dates', t => {
  const { store, start, clock } = fixture(t, '2026-09-10T15:59:00.000Z'), attempt = start();
  clock('2026-09-10T16:00:00.000Z');
  store.recordActivity({ requestId: 'ends-at-midnight', attemptId: attempt.id, durationMs: 10000, occurredAt: new Date().toISOString() });
  clock('2026-09-13T08:00:00.000Z'); store.finishAttempt(attempt.id, { code: '' });
  const dashboard = store.getLearningDashboard();
  assert.equal(dashboard.days.find(day => day.date === '2026-09-10')!.activeMs, 10000);
  assert.equal(dashboard.days.find(day => day.date === '2026-09-11')!.activeMs, 0);
  assert.equal(dashboard.days.at(-1)!.activeMs, 0);
  assert.equal(dashboard.totals.activeMs, 10000);
  const archived = store.getArchiveStatistics({ attemptId: attempt.id });
  assert.equal(archived.activeMs, 10000);
  assert.equal(archived.days.find(day => day.date === '2026-09-10')!.activeMs, 10000);
  assert.equal(archived.days.find(day => day.date === '2026-09-11')?.activeMs ?? 0, 0);
  assert.equal(store.listAttemptPage({ learningDate: '2026-09-11' }).total, 0, 'merely spanning an idle day is not recorded study');
  assert.equal(store.listAttemptPage({ learningDate: '2026-09-13' }).total, 1);
});

for (const [name, startAt, pulseAt, expectedDate] of [
  ['spring DST', '2026-03-09T06:59:50.000Z', '2026-03-09T07:00:04.000Z', '2026-03-09'],
  ['autumn DST', '2026-11-02T07:59:50.000Z', '2026-11-02T08:00:04.000Z', '2026-11-02'],
] as const) test(`local activity boundaries respect ${name} day lengths`, t => {
  const { store, start, clock } = fixture(t, startAt); store.updateLearningSettings({ timeZone: 'America/Los_Angeles' });
  const attempt = start(); clock(pulseAt);
  store.recordActivity({ requestId: 'dst', attemptId: attempt.id, durationMs: 10000, occurredAt: pulseAt });
  const dashboard = store.getLearningDashboard();
  assert.equal(dashboard.date, expectedDate); assert.equal(dashboard.days.at(-2)!.activeMs, 6000); assert.equal(dashboard.days.at(-1)!.activeMs, 4000);
  const archived = store.getArchiveStatistics({ attemptId: attempt.id });
  assert.equal(archived.days.at(-2)!.activeMs, 6000); assert.equal(archived.days.at(-1)!.activeMs, 4000);
  assert.equal(archived.activeMs, 10000);
  assert.equal(store.listAttemptPage({ learningDate: expectedDate }).items[0].attempt.id, attempt.id);
});

test('a review day counts each problem once with its correction, and suspension or rescheduling shows in the plan', t => {
  const { store, start, clock } = fixture(t, '2026-08-31T08:00:00.000Z'); start('p1'); start('p2'); start('p3');
  for (const problemId of ['p1', 'p2', 'p3']) store.addProblemReview(problemId);
  store.recordProblemReview({ problemId: 'p1', requestId: 'august', rating: 3 });
  clock('2026-09-13T08:00:00.000Z');
  const result = store.recordProblemReview({ problemId: 'p1', requestId: 'september', rating: 2 });
  store.correctProblemReview({ eventId: result.event.id, requestId: 'correction', rating: 4 });
  store.updateProblemReviews({ problemIds: ['p2'], suspended: true });
  store.updateProblemReviews({ problemIds: ['p3'], scheduledAt: '2026-09-20T08:00:00.000Z' });
  assert.equal(store.getLearningDashboard().days.at(-1)!.reviewCount, 1);
  assert.equal(store.getProblemReview('p2')!.suspended, true); assert.equal(store.getProblemReview('p3')!.scheduledAt, '2026-09-20T08:00:00.000Z');
  const summary = () => store.getReviewPlanSnapshot({ view: 'today', limit: 1 }).summary;
  assert.equal(summary().suspendedCount, 1); assert.equal(summary().deferredCount, 0, 'unassessed enrollment has no invented due date');
  store.updateProblemReviews({ problemIds: ['p3'], scheduledAt: null });
  assert.equal(store.getProblemReview('p3')!.scheduledAt, null); assert.equal(summary().deferredCount, 0);
});

test('a setting missing from the stored JSON reads as its default without a rewrite, and the practice goal survives update, snapshot and restore independently of review budget', async t => {
  const { store, path, directory } = fixture(t), old = { dailyReviewBudget: 7, timeZone: 'Asia/Shanghai', updatedAt: '2026-01-01T00:00:00.000Z' };
  const raw = new DatabaseSync(path); raw.prepare('UPDATE learning_settings SET value_json = ? WHERE id = 1').run(JSON.stringify(old));
  const before = raw.prepare('SELECT value_json FROM learning_settings').get()!.value_json;
  assert.deepEqual(store.getLearningSettings(), { ...old, dailyPracticeGoal: 3, aiAutoAnalyzeOfficial: false });
  assert.equal(raw.prepare('SELECT value_json FROM learning_settings').get()!.value_json, before, 'reading never rewrites the stored settings');
  assert.equal(store.getLearningDashboard().dailyPracticeGoal, 3);
  store.updateLearningSettings({ dailyPracticeGoal: 8 });
  assert.equal(store.getLearningSettings().dailyReviewBudget, 7);
  const snapshot = join(directory, 'snapshot.sqlite'); await store.backupTo(snapshot);
  store.updateLearningSettings({ dailyPracticeGoal: 1 });
  const restored = join(directory, 'restored.sqlite'); restoreBackup(snapshot, restored);
  const copy = new PracticeStore(restored);
  try { assert.equal(copy.getLearningSettings().dailyPracticeGoal, 8); assert.equal(copy.getLearningSettings().dailyReviewBudget, 7); copy.integrityCheck(); }
  finally { copy.close(); raw.close(); }
  for (const dailyPracticeGoal of [0, -1, 1.2, 1001, NaN, null]) assert.throws(() => store.updateLearningSettings({ dailyPracticeGoal: dailyPracticeGoal as number }));
});


test('archive activity retains all-time history beyond the dashboard year without losing midnight contributions', t => {
  const { store, start, clock } = fixture(t, '2024-01-01T15:59:50.000Z'), old = start('older-than-one-year');
  clock('2024-01-01T16:00:04.000Z');
  store.recordActivity({ requestId: 'old-midnight', attemptId: old.id, durationMs: 10000, occurredAt: new Date().toISOString() });
  store.finishAttempt(old.id, { code: '' });
  clock('2026-09-13T08:00:00.000Z');
  assert.equal(store.getLearningDashboard().totals.activeMs, 0);
  const archived = store.getArchiveStatistics();
  assert.equal(archived.activeMs, 10000);
  assert.equal(archived.days.find(day => day.date === '2024-01-01')!.activeMs, 6000);
  assert.equal(archived.days.find(day => day.date === '2024-01-02')!.activeMs, 4000);
  assert.equal(store.getArchiveStatistics({ timeZone: 'UTC' }).days.find(day => day.date === '2024-01-01')!.activeMs, 10000);
});
