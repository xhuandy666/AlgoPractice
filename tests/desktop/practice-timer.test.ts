import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, tickElapsed } from '../../src/renderer/practice-timer.ts';

test('the practice timer formats like a stopwatch', () => {
  assert.equal(formatDuration(0), '0:00'); assert.equal(formatDuration(59_999), '0:59'); assert.equal(formatDuration(61_000), '1:01');
  assert.equal(formatDuration(3_600_000), '1:00:00'); assert.equal(formatDuration(3_725_000), '1:02:05'); assert.equal(formatDuration(-5), '0:00');
});

test('the local count only advances while active and never jumps after a long gap', () => {
  assert.equal(tickElapsed(10_000, 1_000, true), 11_000);
  assert.equal(tickElapsed(10_000, 1_000, false), 10_000, 'idle, hidden or unfocused time is not practice time');
  assert.equal(tickElapsed(10_000, 3_600_000, true), 12_000, 'waking from sleep adds at most two seconds');
  assert.equal(tickElapsed(10_000, -50, true), 10_000);
});

test('the timer starts from the attempt\'s own recorded activity', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { PracticeStore } = await import('../../src/storage/practice-store.ts');
  const directory = mkdtempSync(join(tmpdir(), 'tilian-timer-')), store = new PracticeStore(join(directory, 'practice.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const problem = store.upsertProblem({ id: 'local:sum', title: 'sum', difficulty: '简单', tags: [], description: '题面', descriptionFormat: 'plain', constraints: [], mode: 'function',
    adapter: { method: 'f', params: ['int'], returns: 'int' }, cases: [{ args: [1] }], starter: { python: 'class Solution: pass' }, source: 'file' } as never);
  const start = () => store.startAttempt({ problemId: problem.id, language: 'python', problemVersion: problem.version, problemSnapshot: problem.content as never, draftScopeId: `redo:${Math.random()}` });
  const mine = start(), other = start();
  for (const [attemptId, durationMs] of [[mine.id, 10_000], [mine.id, 9_500], [other.id, 15_000]] as const) store.recordActivity({ requestId: `${attemptId}-${durationMs}`, attemptId, durationMs, occurredAt: new Date().toISOString() });
  assert.equal(store.attemptActiveMs(mine.id), 19_500); assert.equal(store.attemptActiveMs(other.id), 15_000); assert.equal(store.attemptActiveMs('missing'), 0);
});
