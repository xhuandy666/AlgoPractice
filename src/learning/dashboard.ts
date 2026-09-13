import type { DatabaseSync } from 'node:sqlite';
import { archiveDateBoundary } from '../shared/archive-date.ts';
import type { LearningDashboard, LearningDay, LearningSettings, ReviewEvent, ReviewItem } from '../shared/learning.ts';
import { localDate } from './fsrs.ts';

type Row = Record<string, string | number | null>;
const DAY_MS = 86400000;
function shiftDay(date: string, amount: number): string { return new Date(Date.parse(`${date}T12:00:00.000Z`) + amount * DAY_MS).toISOString().slice(0, 10); }

/** Small daily aggregates only: no problem bodies, code, run output, or guessed historical time. */
export function learningDashboard(db: DatabaseSync, settings: LearningSettings, reviewItems: () => ReviewItem[], month: string | undefined, at: string): LearningDashboard {
  const date = localDate(at, settings.timeZone), from = shiftDay(date, -365), to = date;
  month ??= date.slice(0, 7);
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('复习月份无效。');
  const monthStart = archiveDateBoundary(`${month}-01`, settings.timeZone);
  const nextMonth = new Date(`${month}-01T12:00:00.000Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = archiveDateBoundary(nextMonth.toISOString().slice(0, 10), settings.timeZone);
  const days: LearningDay[] = Array.from({ length: 366 }, (_, i) => ({ date: shiftDay(from, i), activeMs: 0, completedAttempts: 0, completedProblems: 0, reviewCount: 0 }));
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
  const completed = db.prepare(`SELECT dashboard_day_index(ended_at) AS day_index, COUNT(*) AS attempts, COUNT(DISTINCT problem_id) AS problems
    FROM attempts WHERE ended_at >= ? AND ended_at <= ? GROUP BY day_index`).all(start, at) as Row[];
  for (const row of completed) if (days[Number(row.day_index)]) Object.assign(days[Number(row.day_index)], { completedAttempts: Number(row.attempts), completedProblems: Number(row.problems) });
  const completedProblems = Number(db.prepare('SELECT COUNT(DISTINCT problem_id) AS count FROM attempts WHERE ended_at >= ? AND ended_at <= ?').get(start, at)!.count);
  for (const row of db.prepare(`SELECT dashboard_day_index(reviewed_at) AS day_index, COUNT(*) AS count
    FROM review_events WHERE kind = 'review' AND reviewed_at >= ? AND reviewed_at <= ? GROUP BY day_index`).all(start, at) as Row[]) {
    if (days[Number(row.day_index)]) days[Number(row.day_index)].reviewCount = Number(row.count);
  }
  const reviewEvents = (db.prepare(`SELECT e.*, COALESCE((SELECT c.rating FROM review_events c
    WHERE c.kind = 'correction' AND c.corrects_event_id = e.id ORDER BY c.rowid DESC LIMIT 1), e.rating) AS effective_rating
    FROM review_events e WHERE e.kind = 'review' AND e.reviewed_at >= ? AND e.reviewed_at < ? AND e.reviewed_at <= ?
    ORDER BY e.reviewed_at, e.rowid`).all(monthStart, monthEnd, at) as Row[]).map(row => ({
      id: String(row.id), requestId: String(row.request_id), itemId: String(row.item_id), kind: 'review' as const,
      rating: Number(row.effective_rating) as ReviewEvent['rating'], reviewedAt: String(row.reviewed_at), createdAt: String(row.created_at),
      correctsEventId: null, algorithmVersion: String(row.algorithm_version), attemptId: row.attempt_id as string | null,
    }));
  return { date, timeZone: settings.timeZone, dailyPracticeGoal: settings.dailyPracticeGoal, from, to, days,
    totals: { activeMs: days.reduce((total, day) => total + day.activeMs, 0), completedAttempts: days.reduce((total, day) => total + day.completedAttempts, 0),
      completedProblems, activeDays: days.filter(day => day.activeMs > 0 || day.completedAttempts > 0 || day.reviewCount > 0).length },
    reviewItems: reviewItems(), reviewEvents };
}
