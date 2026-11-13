import type { DatabaseSync } from 'node:sqlite';
import { archiveDateBoundary } from '../shared/archive-date.ts';
import type { LearningDashboard, LearningDay, LearningSettings } from '../shared/learning.ts';
import { localDate } from './fsrs.ts';
import { attemptCompletionsSql } from './verdicts.ts';

type Row = Record<string, string | number | null>;
const DAY_MS = 86400000;
function shiftDay(date: string, amount: number): string { return new Date(Date.parse(`${date}T12:00:00.000Z`) + amount * DAY_MS).toISOString().slice(0, 10); }

/** Small daily aggregates only: no problem bodies, code, run output, or guessed historical time. */
export function learningDashboard(db: DatabaseSync, settings: LearningSettings, at: string): LearningDashboard {
  const date = localDate(at, settings.timeZone), from = shiftDay(date, -365), to = date;
  const days: LearningDay[] = Array.from({ length: 366 }, (_, i) => ({ date: shiftDay(from, i), activeMs: 0, completedProblems: 0, reviewCount: 0 }));
  // Precompute 367 boundaries once. The SQL callback then performs only a binary search, not an Intl
  // format for every activity pulse. Local day lengths can be 23/25 hours or even zero after a zone jump.
  const boundaries = [...days.map(day => Date.parse(archiveDateBoundary(day.date, settings.timeZone))), Date.parse(archiveDateBoundary(date, settings.timeZone, true))];
  const start = new Date(boundaries[0]).toISOString(), endMs = Date.parse(at);
  const index = (atMs: number) => {
    let lo = 0, hi = boundaries.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (boundaries[mid] <= atMs) lo = mid + 1; else hi = mid; }
    return lo - 1;
  };
  db.function('dashboard_day_index', { deterministic: true }, value => index(typeof value === 'number' ? value : Date.parse(String(value))));
  db.function('dashboard_boundary', { deterministic: true }, value => boundaries[Number(value)] ?? endMs);
  db.function('dashboard_millis', { deterministic: true }, value => Date.parse(String(value)));
  // Pulse duration is the measured interval immediately preceding its timestamp. Split the rare
  // midnight-spanning sample; never replace missing pulses with the wall-clock attempt lifetime.
  const activity = db.prepare(`WITH intervals AS MATERIALIZED (
      SELECT MAX(dashboard_millis(occurred_at) - duration_ms, ?) AS start_ms,
        MIN(dashboard_millis(occurred_at), ?) AS end_ms
      FROM activity_samples WHERE occurred_at >= ? AND occurred_at <= ? AND duration_ms > 0
    ), parts AS MATERIALIZED (
      SELECT start_ms, end_ms, dashboard_day_index(start_ms) AS first_day, dashboard_day_index(end_ms - 1) AS last_day
      FROM intervals WHERE end_ms > start_ms
    ) SELECT first_day AS day_index, SUM(MIN(end_ms, dashboard_boundary(first_day + 1)) - start_ms) AS duration
      FROM parts GROUP BY first_day
    UNION ALL SELECT last_day AS day_index, SUM(end_ms - dashboard_boundary(last_day)) AS duration
      FROM parts WHERE first_day <> last_day GROUP BY last_day`).all(boundaries[0], endMs, start, at) as Row[];
  for (const row of activity) if (days[Number(row.day_index)]) days[Number(row.day_index)].activeMs += Number(row.duration);
  // One pass over the completions: per-day distinct problems and the window's distinct total.
  const perDay = new Map<number, Set<string>>(), everyProblem = new Set<string>();
  for (const row of db.prepare(`SELECT dashboard_day_index(completed_at) AS day_index, problem_id
    FROM (${attemptCompletionsSql()}) WHERE completed_at >= ? AND completed_at <= ?`).all(start, at) as Row[]) {
    const problem = String(row.problem_id), dayIndex = Number(row.day_index);
    everyProblem.add(problem); if (!perDay.has(dayIndex)) perDay.set(dayIndex, new Set()); perDay.get(dayIndex)!.add(problem);
  }
  for (const [dayIndex, problems] of perDay) if (days[dayIndex]) days[dayIndex].completedProblems = problems.size;
  const completedProblems = everyProblem.size;
  const dates = new Map(days.map(day => [day.date, day]));
  for (const row of db.prepare(`SELECT learning_date AS date, COUNT(DISTINCT problem_id) AS count
    FROM problem_review_effective_events WHERE is_initial=0 AND learning_date>=? AND learning_date<=? AND observed_at<=?
    GROUP BY learning_date`).all(from, to, at) as Row[]) {
    const day = dates.get(String(row.date)); if (day) day.reviewCount = Number(row.count);
  }
  return { date, timeZone: settings.timeZone, dailyPracticeGoal: settings.dailyPracticeGoal, from, to, days,
    totals: { activeMs: days.reduce((total, day) => total + day.activeMs, 0),
      completedProblems, activeDays: days.filter(day => day.activeMs > 0 || day.completedProblems > 0 || day.reviewCount > 0).length } };
}
