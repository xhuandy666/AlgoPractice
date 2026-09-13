import type { LearningDay, ReviewItem } from '../shared/learning.ts';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Convert an instant to a local learning date, independent of the device time zone. */
export function dateKey(iso: string, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Date-only arithmetic must not inherit local daylight-saving transitions. */
export function addDays(date: string, n: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + n);
  return value.toISOString().slice(0, 10);
}

export function shiftMonth(month: string, n: number): string {
  const value = new Date(`${month}-01T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + n);
  return value.toISOString().slice(0, 7);
}

export function monthGrid(month: string): Array<{ date: string; inMonth: boolean }> {
  const first = `${month}-01`;
  const weekday = new Date(`${first}T00:00:00.000Z`).getUTCDay();
  const start = addDays(first, -((weekday + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(start, index);
    return { date, inMonth: date.slice(0, 7) === month };
  });
}

export function reviewPlan(items: ReviewItem[], today: string, timeZone: string): Map<string, ReviewItem[]> {
  const result = new Map<string, ReviewItem[]>();
  for (const item of items) {
    if (item.suspended) continue;
    const effective = Math.max(Date.parse(item.dueAt), Date.parse(item.scheduledAt ?? item.dueAt));
    const due = dateKey(new Date(effective).toISOString(), timeZone);
    const date = due < today ? today : due;
    const day = result.get(date);
    if (day) day.push(item); else result.set(date, [item]);
  }
  return result;
}

export function learningStreak(days: LearningDay[], today: string): number {
  const active = new Set(days.filter(day => day.activeMs > 0 || day.completedAttempts > 0 || day.reviewCount > 0).map(day => day.date));
  let date = active.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (active.has(date)) { streak++; date = addDays(date, -1); }
  return streak;
}
