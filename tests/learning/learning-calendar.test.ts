import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, dateKey, learningStreak, monthGrid, shiftMonth } from '../../src/renderer/learning-calendar.ts';
import type { LearningDay } from '../../src/shared/learning.ts';

function day(date: string, values: Partial<LearningDay> = {}): LearningDay {
  return { date, activeMs: 0, completedProblems: 0, reviewCount: 0, ...values };
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

test('learningStreak counts study time, completed problems and reviews through month boundaries', () => {
  const days = [day('2024-02-28', { completedProblems: 1 }), day('2024-02-29', { reviewCount: 1 }), day('2024-03-01', { activeMs: 1 })];
  assert.equal(learningStreak(days, '2024-03-01'), 3);
  assert.equal(learningStreak([...days, day('2024-03-02')], '2024-03-02'), 3, 'today can remain unfinished');
  assert.equal(learningStreak(days, '2024-03-03'), 0, 'a missed yesterday ends the streak');
});

test('learningStreak stops at gaps, ignores future and empty days, and counts duplicate dates once', () => {
  const days = [day('2025-12-30', { activeMs: 10 }), day('2025-12-31'), day('2026-01-01', { reviewCount: 1 }),
    day('2026-01-01', { completedProblems: 1 }), day('2026-01-02', { activeMs: 10 }), day('2026-01-03', { completedProblems: 1 })];
  assert.equal(learningStreak(days, '2026-01-01'), 1);
  assert.equal(learningStreak(days, '2026-01-03'), 3, 'a problem completed today makes today a study day');
  assert.equal(learningStreak([], '2026-01-01'), 0);
});
