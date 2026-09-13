import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, dateKey, learningStreak, monthGrid, reviewPlan, shiftMonth } from '../../src/renderer/learning-calendar.ts';
import type { LearningDay, ReviewItem } from '../../src/shared/learning.ts';

function review(id: string, dueAt: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return { id, problemId: `problem-${id}`, target: 'rewrite', language: 'python', dueAt, scheduledAt: null, suspended: false,
    card: { due: dueAt, stability: 1, difficulty: 1, elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, state: 0, learning_steps: 0 },
    algorithmVersion: 'fixture', createdAt: dueAt, updatedAt: dueAt, ...overrides };
}
function day(date: string, values: Partial<LearningDay> = {}): LearningDay {
  return { date, activeMs: 0, completedAttempts: 0, completedProblems: 0, reviewCount: 0, ...values };
}

test('dateKey follows the chosen learning time zone across midnight and year boundaries', () => {
  const instant = '2025-12-31T16:30:00.000Z';
  assert.equal(dateKey(instant, 'Asia/Shanghai'), '2026-01-01');
  assert.equal(dateKey(instant, 'America/Los_Angeles'), '2025-12-31');
  assert.equal(dateKey('2026-01-01T00:30:00+08:00', 'UTC'), '2025-12-31');
  assert.equal(dateKey('2026-03-08T09:59:59.000Z', 'America/Los_Angeles'), '2026-03-08');
  assert.equal(dateKey('2026-03-08T10:00:00.000Z', 'America/Los_Angeles'), '2026-03-08');
});

test('addDays handles leap days, year changes, and DST dates as calendar dates', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(addDays('2025-02-28', 1), '2025-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
});

test('shiftMonth crosses years and accepts larger positive and negative offsets', () => {
  assert.equal(shiftMonth('2025-12', 1), '2026-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-01', 14), '2027-03');
  assert.equal(shiftMonth('2026-01', -14), '2024-11');
  assert.equal(shiftMonth('2024-02', 0), '2024-02');
});

test('monthGrid is six complete Monday-first weeks, including a leap February', () => {
  const grid = monthGrid('2024-02');
  assert.equal(grid.length, 42);
  assert.deepEqual(grid[0], { date: '2024-01-29', inMonth: false });
  assert.deepEqual(grid[3], { date: '2024-02-01', inMonth: true });
  assert.deepEqual(grid[31], { date: '2024-02-29', inMonth: true });
  assert.deepEqual(grid[41], { date: '2024-03-10', inMonth: false });
  assert.equal(grid.filter(value => value.inMonth).length, 29);
  assert.equal(new Set(grid.map(value => value.date)).size, 42);
});

test('monthGrid handles months starting on Monday or Sunday without dropping boundary dates', () => {
  const monday = monthGrid('2026-06'), sunday = monthGrid('2026-02');
  assert.deepEqual(monday[0], { date: '2026-06-01', inMonth: true });
  assert.deepEqual(monday[41], { date: '2026-07-12', inMonth: false });
  assert.deepEqual(sunday[0], { date: '2026-01-26', inMonth: false });
  assert.deepEqual(sunday[6], { date: '2026-02-01', inMonth: true });
  assert.equal(sunday.filter(value => value.inMonth).length, 28);
});

test('reviewPlan rolls overdue reviews onto today once, excludes suspended items, and honors postponement', () => {
  const items = [
    review('overdue', '2026-09-01T08:00:00Z'),
    review('today', '2026-09-13T08:00:00Z'),
    review('postponed', '2026-09-01T08:00:00Z', { scheduledAt: '2026-09-15T08:00:00Z' }),
    review('suspended', '2026-09-01T08:00:00Z', { suspended: true }),
    review('due-later', '2026-09-16T08:00:00Z', { scheduledAt: '2026-09-14T08:00:00Z' }),
    review('postponement-overdue', '2026-09-01T08:00:00Z', { scheduledAt: '2026-09-10T08:00:00Z' }),
  ];
  const before = structuredClone(items), plan = reviewPlan(items, '2026-09-13', 'Asia/Shanghai');
  assert.deepEqual([...plan].map(([date, values]) => [date, values.map(value => value.id)]), [
    ['2026-09-13', ['overdue', 'today', 'postponement-overdue']],
    ['2026-09-15', ['postponed']], ['2026-09-16', ['due-later']],
  ]);
  assert.equal([...plan.values()].flat().length, 5);
  assert.equal(plan.has('2026-09-01'), false);
  assert.deepEqual(items, before, 'planning must not mutate the review schedule');
});

test('reviewPlan chooses the latest instant before converting to the learning date', () => {
  const items = [review('offsets', '2026-01-01T23:30:00-08:00', { scheduledAt: '2026-01-02T00:30:00+08:00' })];
  assert.deepEqual([...reviewPlan(items, '2026-01-01', 'Asia/Shanghai').keys()], ['2026-01-02']);
  assert.deepEqual([...reviewPlan(items, '2026-01-01', 'America/Los_Angeles').keys()], ['2026-01-01']);
  assert.equal(reviewPlan([], '2026-01-01', 'UTC').size, 0);
});

test('learningStreak counts study time, completed attempts and reviews through month boundaries', () => {
  const days = [day('2024-02-28', { completedAttempts: 1 }), day('2024-02-29', { reviewCount: 1 }), day('2024-03-01', { activeMs: 1 })];
  assert.equal(learningStreak(days, '2024-03-01'), 3);
  assert.equal(learningStreak([...days, day('2024-03-02')], '2024-03-02'), 3, 'today can remain unfinished');
  assert.equal(learningStreak(days, '2024-03-03'), 0, 'a missed yesterday ends the streak');
});

test('learningStreak stops at gaps, ignores future and empty days, and counts duplicate dates once', () => {
  const days = [day('2025-12-30', { activeMs: 10 }), day('2025-12-31'), day('2026-01-01', { reviewCount: 1 }),
    day('2026-01-01', { completedAttempts: 1 }), day('2026-01-02', { activeMs: 10 }), day('2026-01-03', { completedProblems: 1 })];
  assert.equal(learningStreak(days, '2026-01-01'), 1);
  assert.equal(learningStreak(days, '2026-01-03'), 2);
  assert.equal(learningStreak([], '2026-01-01'), 0);
});
