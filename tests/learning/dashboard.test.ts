import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';

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

test('dashboard completion counts explicit ended attempts and unique problems, independent of repeated or passed local runs', t => {
  const { store, start, clock } = fixture(t), first = start();
  const run = { attemptId: first.id, code: 'print(1)', testSuiteVersion: 'local', adapterVersion: '1', runtimeVersion: '1', status: 'passed' as const };
  store.saveRun(run); store.saveRun(run);
  assert.equal(store.getLearningDashboard().days.at(-1)!.completedProblems, 0, 'running locally does not complete a problem');
  store.finishAttempt(first.id, { code: 'print(1)' });
  const repeat = start('p1', 'java'); store.finishAttempt(repeat.id, { code: 'unrun final draft' });
  const second = start('p2'); store.finishAttempt(second.id, { code: '' });
  start('unfinished');
  let dashboard = store.getLearningDashboard();
  assert.equal(dashboard.days.at(-1)!.completedAttempts, 3);
  assert.equal(dashboard.days.at(-1)!.completedProblems, 2);
  assert.equal(dashboard.totals.activeMs, 0, 'missing historical pulses do not become guessed study time');
  clock('2026-09-14T08:00:00.000Z');
  const tomorrow = start('p1'); store.finishAttempt(tomorrow.id, { code: '' });
  dashboard = store.getLearningDashboard();
  assert.equal(dashboard.days.at(-1)!.completedProblems, 1);
  assert.equal(dashboard.totals.completedAttempts, 4);
  assert.equal(dashboard.totals.completedProblems, 2, 'range total deduplicates across days and languages');
  assert.equal(dashboard.totals.activeDays, 2);
  assert.equal(dashboard.days.length, 366);
  assert.equal(dashboard.from, '2025-09-14');
  store.getAttempt = () => { throw new Error('dashboard must not read code or problem snapshots'); };
  store.getProblem = () => { throw new Error('dashboard must not read problem bodies'); };
  assert.equal(store.getLearningDashboard().totals.completedAttempts, 4);
});

test('measured pulse intervals split at the learning midnight and heatmap drilldown includes each recorded day once', t => {
  const { store, start, clock } = fixture(t, '2026-09-12T15:59:50.000Z'), attempt = start();
  clock('2026-09-12T16:00:04.000Z');
  const pulse = { requestId: 'cross-midnight', attemptId: attempt.id, durationMs: 10000, occurredAt: new Date().toISOString() };
  store.recordActivity(pulse); store.recordActivity(pulse);
  clock('2026-09-12T16:00:10.000Z');
  store.recordActivity({ ...pulse, requestId: 'after-midnight', durationMs: 6000, occurredAt: new Date().toISOString() });
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

test('calendar returns current suspension and rescheduling plus actual month completions with corrections counted once', t => {
  const { store, start, clock } = fixture(t, '2026-08-31T08:00:00.000Z'); start('p1'); start('p2'); start('p3');
  const first = store.addReviewItem({ problemId: 'p1', target: 'understanding', language: 'none' });
  const suspended = store.addReviewItem({ problemId: 'p2', target: 'rewrite', language: 'python' });
  const postponed = store.addReviewItem({ problemId: 'p3', target: 'rewrite', language: 'java' });
  store.recordReview({ itemId: first.id, requestId: 'august', rating: 3 });
  clock('2026-09-13T08:00:00.000Z');
  const result = store.recordReview({ itemId: first.id, requestId: 'september', rating: 2 });
  store.correctReview({ eventId: result.event.id, requestId: 'correction', rating: 4 });
  store.setReviewPlan(suspended.id, { suspended: true });
  store.setReviewPlan(postponed.id, { scheduledAt: '2026-09-20T08:00:00.000Z' });
  let dashboard = store.getLearningDashboard('2026-09');
  assert.equal(dashboard.reviewEvents.length, 1); assert.equal(dashboard.reviewEvents[0].id, result.event.id); assert.equal(dashboard.reviewEvents[0].rating, 4);
  assert.equal(dashboard.days.at(-1)!.reviewCount, 1);
  assert.equal(dashboard.reviewItems.find(item => item.id === suspended.id)!.suspended, true);
  assert.equal(dashboard.reviewItems.find(item => item.id === postponed.id)!.scheduledAt, '2026-09-20T08:00:00.000Z');
  assert.equal(store.getTodayQueue().suspendedCount, 1); assert.equal(store.getTodayQueue().deferredCount, 1);
  store.setReviewPlan(postponed.id, { scheduledAt: null });
  dashboard = store.getLearningDashboard('2026-08');
  assert.equal(dashboard.reviewEvents.length, 1); assert.equal(dashboard.reviewEvents[0].requestId, 'august');
  assert.equal(dashboard.reviewItems.find(item => item.id === postponed.id)!.scheduledAt, null);
  assert.equal(store.getTodayQueue().deferredCount, 0);
  assert.deepEqual(store.getLearningDashboard('2026-10').reviewEvents, []);
  for (const month of ['2026-13', '2026-1', '2026-00', 'bad']) assert.throws(() => store.getLearningDashboard(month));
});

test('the practice goal defaults over unchanged legacy JSON and survives update, snapshot and restore independently of review budget', async t => {
  const { store, path, directory } = fixture(t), old = { dailyReviewBudget: 7, timeZone: 'Asia/Shanghai', updatedAt: '2026-01-01T00:00:00.000Z' };
  const raw = new DatabaseSync(path); raw.prepare('UPDATE learning_settings SET value_json = ? WHERE id = 1').run(JSON.stringify(old));
  const before = raw.prepare('SELECT value_json FROM learning_settings').get()!.value_json;
  assert.deepEqual(store.getLearningSettings(), { ...old, dailyPracticeGoal: 3 });
  assert.equal(raw.prepare('SELECT value_json FROM learning_settings').get()!.value_json, before, 'read must not rewrite legacy settings');
  assert.equal(store.getLearningDashboard().dailyPracticeGoal, 3);
  store.updateLearningSettings({ dailyPracticeGoal: 8 });
  assert.equal(store.getLearningSettings().dailyReviewBudget, 7);
  const snapshot = join(directory, 'snapshot.sqlite'); await store.backupTo(snapshot);
  store.updateLearningSettings({ dailyPracticeGoal: 1 });
  const restored = join(directory, 'restored.sqlite'); PracticeStore.restoreBackup(snapshot, restored);
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
