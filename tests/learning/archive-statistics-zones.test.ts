import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { archiveDateBoundary } from '../../src/shared/archive-date.ts';
import { dayNumberDate, localDayAt, localDaySegments } from '../../src/learning/local-days.ts';
import type { RunStatus } from '../../src/runner/types.ts';
import { attemptCompletionsSql } from '../../src/learning/verdicts.ts';

type Totals = { activeMs: number; attempts: number; completedProblems: number; runs: number; passedRuns: number; practiceRuns: number };
const PRACTICE = `'completed', 'wrong_answer', 'compile_error', 'runtime_error', 'timeout', 'output_limit'`;

/** The previous implementation, kept as an oracle: per-row JavaScript callbacks over the formatter's local date. Completions use
 * the shared rule (its semantics are pinned in dashboard.test.ts); only their day bucketing is checked here. */
function reference(path: string, timeZone: string, attemptId?: string): Map<string, Totals> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const formatter = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    type DayRange = { date: string; start: number; end: number };
    const ranges = new Map<string, DayRange>(); let recent: DayRange | undefined;
    const rangeAt = (at: number): DayRange => {
      if (recent && at >= recent.start && at < recent.end) return recent;
      const parts = formatter.formatToParts(new Date(at));
      const date = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
      let range = ranges.get(date);
      if (!range) { range = { date, start: Date.parse(archiveDateBoundary(date, timeZone)), end: Date.parse(archiveDateBoundary(date, timeZone, true)) }; ranges.set(date, range); }
      recent = range; return range;
    };
    db.function('practice_local_date', { deterministic: true }, at => rangeAt(Date.parse(String(at))).date);
    db.function('practice_activity_part', { deterministic: true }, (value, durationValue, part) => {
      const end = Date.parse(String(value)), duration = Number(durationValue), start = end - duration;
      const first = rangeAt(start), last = rangeAt(duration > 0 ? end - 1 : end);
      const previous = first.date === last.date ? 0 : Math.max(0, last.start - start);
      return [last.date, duration - previous, first.date, previous][Number(part)];
    });
    const days = new Map<string, Totals>();
    const day = (date: string) => { if (!days.has(date)) days.set(date, { activeMs: 0, attempts: 0, completedProblems: 0, runs: 0, passedRuns: 0, practiceRuns: 0 }); return days.get(date)!; };
    const condition = attemptId ? ' AND attempt_id = ?' : '', args = attemptId ? ['', '9999', attemptId] : ['', '9999'];
    const activityWhere = `occurred_at >= ? AND occurred_at <= ?${condition}`;
    for (const row of db.prepare(`SELECT practice_activity_part(occurred_at, duration_ms, 0) AS date,
      SUM(practice_activity_part(occurred_at, duration_ms, 1)) AS duration FROM activity_samples WHERE ${activityWhere} GROUP BY date
      UNION ALL SELECT practice_activity_part(occurred_at, duration_ms, 2) AS date,
      SUM(practice_activity_part(occurred_at, duration_ms, 3)) AS duration FROM activity_samples
      WHERE ${activityWhere} AND practice_activity_part(occurred_at, duration_ms, 3) > 0 GROUP BY date`).all(...args, ...args) as Record<string, number | string>[]) {
      day(row.date as string).activeMs += row.duration as number;
    }
    for (const row of db.prepare(`SELECT practice_local_date(started_at) AS date, COUNT(*) AS count FROM attempts
      WHERE started_at >= ? AND started_at <= ?${attemptId ? ' AND id = ?' : ''} GROUP BY date`).all(...args) as Record<string, number | string>[]) day(row.date as string).attempts = row.count as number;
    for (const row of db.prepare(`SELECT practice_local_date(completed_at) AS date, COUNT(DISTINCT problem_id) AS count
      FROM (${attemptCompletionsSql(attemptId ? 'a.id = ?' : '')}) WHERE completed_at IS NOT NULL GROUP BY date`).all(...(attemptId ? [attemptId] : [])) as Record<string, number | string>[]) day(row.date as string).completedProblems = row.count as number;
    for (const row of db.prepare(`SELECT practice_local_date(created_at) AS date, COUNT(*) AS count, SUM(status = 'passed' AND expected_output_source = 'native-samples') AS passed, SUM(status IN (${PRACTICE})) AS practiced
      FROM runs WHERE created_at >= ? AND created_at <= ?${condition} GROUP BY date`).all(...args) as Record<string, number | string>[]) {
      Object.assign(day(row.date as string), { runs: row.count, passedRuns: row.passed, practiceRuns: row.practiced });
    }
    return days;
  } finally { db.close(); }
}

/** Deterministic PRNG so a failure reproduces exactly. */
function random(seed: number) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let value = Math.imul(seed ^ (seed >>> 15), 1 | seed); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}

// Each zone's interesting days: DST changes, a midnight that is skipped or repeated, a 30-minute shift, a skipped date.
const ZONES: Record<string, string[]> = {
  'Asia/Shanghai': ['2026-09-13', '2026-12-31'],
  'UTC': ['2024-02-29', '2026-01-01'],
  'America/Los_Angeles': ['2026-03-08', '2026-11-01'],
  'Europe/London': ['2026-03-29', '2026-10-25'],
  'America/Sao_Paulo': ['2018-11-04', '2019-02-16'],
  'America/Santiago': ['2026-04-05', '2026-09-06'],
  'Australia/Lord_Howe': ['2026-04-05', '2026-10-04'],
  'Asia/Kathmandu': ['2026-06-01'],
  'Pacific/Apia': ['2011-12-29', '2011-12-31'],
};

test('day segments merge whole days per offset and isolate irregular days', () => {
  const year = (zone: string) => localDaySegments(Date.parse('2026-01-01T12:00:00Z'), Date.parse('2026-12-30T12:00:00Z'), zone);
  assert.deepEqual(year('Asia/Shanghai').map(segment => 'offset' in segment), [true], 'a zone without DST is one arithmetic segment');
  assert.deepEqual(year('America/Los_Angeles').map(segment => 'offset' in segment ? 'run' : dayNumberDate(segment.day)), ['run', '2026-03-08', 'run', '2026-11-01', 'run']);
  const apia = localDaySegments(Date.parse('2011-12-29T12:00:00Z'), Date.parse('2011-12-31T12:00:00Z'), 'Pacific/Apia');
  const days = (at: string) => dayNumberDate(localDayAt(Date.parse(at), apia)!);
  assert.equal(days('2011-12-30T09:59:59.999Z'), '2011-12-29');
  assert.equal(days('2011-12-30T10:00:00.000Z'), '2011-12-31', 'the skipped 30 December never owns an instant');
  assert.equal(localDayAt(Date.parse('2000-01-01T00:00:00Z'), apia), null, 'instants outside the segments are reported, not guessed');
});

test('SQL day bucketing matches the formatter-based implementation across DST, skipped and shifted midnights', t => {
  const next = random(20261112), pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
  const instants: number[] = [];
  for (const [zone, dates] of Object.entries(ZONES)) for (const date of dates) for (const offset of [0, 1, 2]) {
    const boundary = Date.parse(archiveDateBoundary(date, zone)) + offset * 86400000;
    for (const delta of [0, 1, -1, 30000, -30000]) instants.push(boundary + delta);
    for (let index = 0; index < 12; index++) instants.push(boundary + Math.round((next() * 2 - 1) * 45000));
    for (let index = 0; index < 4; index++) instants.push(boundary + Math.round((next() * 2 - 1) * 86400000));
  }
  instants.sort((a, b) => a - b);
  t.mock.timers.enable({ apis: ['Date'], now: new Date(instants[0] - 86400000) });
  const directory = mkdtempSync(join(tmpdir(), 'tilian-archive-zones-')), path = join(directory, 'practice.sqlite');
  const store = new PracticeStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const long = store.startAttempt({ problemId: 'zones-long', language: 'python', problemVersion: 'v1' });
  const statuses: RunStatus[] = ['passed', 'completed', 'wrong_answer', 'compile_error', 'runtime_error', 'timeout', 'output_limit', 'cancelled', 'environment_error', 'internal_error'];
  let problem = 0;
  for (const at of instants) if (next() < 0.15) {
    t.mock.timers.setTime(at);
    const attempt = store.startAttempt({ problemId: `zones-${++problem}`, language: 'python', problemVersion: 'v1' });
    t.mock.timers.setTime(at + Math.round(next() * 60000));
    store.finishAttempt(attempt.id, { code: '' });
  }
  // Bulk rows go in one transaction on a second connection; per-call FULL-sync commits would take tens of seconds.
  // Values stay within what recordActivity and saveRun accept (0-30 s pulses inside the attempt, terminal runs).
  const writer = new DatabaseSync(path);
  try {
    writer.exec('BEGIN');
    const sample = writer.prepare('INSERT INTO activity_samples VALUES (?, ?, ?, ?, ?, ?)');
    const run = writer.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    instants.forEach((at, index) => {
      const iso = new Date(at).toISOString();
      sample.run(`sample-${index}`, `activity-${index}`, long.id, pick([0, 1, 999, 1000, 10000, 15000, 29999, 30000]), iso, iso);
      run.run(`run-${index}`, long.id, 'pass', 'hash', 'local', '{}', 'native-samples', '1', '1', pick(statuses), '{}', iso, iso);
    });
    writer.exec('COMMIT');
  } finally { writer.close(); }
  for (const zone of Object.keys(ZONES)) {
    for (const filter of [undefined, long.id]) {
      const actual = store.getArchiveStatistics({ timeZone: zone, ...(filter ? { attemptId: filter } : {}) });
      const expected = reference(path, zone, filter);
      const comparable = new Map(actual.days.map(row => [row.date, { activeMs: row.activeMs, attempts: row.attempts, completedProblems: row.completedProblems, runs: row.runs, passedRuns: row.passedRuns, practiceRuns: row.practiceRuns }]));
      assert.deepEqual(Object.fromEntries([...comparable].sort()), Object.fromEntries([...expected].sort()), `${zone}${filter ? ' (attempt filter)' : ''}`);
      assert.equal(actual.activeMs, [...expected.values()].reduce((sum, row) => sum + row.activeMs, 0));
    }
  }
});
