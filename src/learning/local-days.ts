import { archiveDateBoundary, localDateOf } from '../shared/archive-date.ts';

const DAY_MS = 86400000;
/** A run of whole 24-hour local days sharing one UTC offset (date = floor((t + offset) / day)),
 * or one irregular day (DST change, skipped or shifted midnight) that maps to a fixed date. */
export type LocalDaySegment = { from: number; to: number } & ({ offset: number } | { day: number; start: number });

const dateDay = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / DAY_MS;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** Day number (days since 1970-01-01) to YYYY-MM-DD. */
export const dayNumberDate = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Partition the local days around [fromMs, toMs] (one spare day each side) so SQLite can bucket timestamps by
 * arithmetic instead of calling back into JavaScript for every row. Every boundary is either checked against the
 * time-zone formatter or found by archiveDateBoundary, so each instant maps to the date the formatter gives.
 * tests/learning/archive-statistics-zones.test.ts compares the result with the per-row formatter implementation. */
export function localDaySegments(fromMs: number, toMs: number, timeZone: string): LocalDaySegment[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) throw new Error('统计时间范围无效。');
  const last = addDays(localDateOf(toMs, timeZone), 2), segments: LocalDaySegment[] = [];
  let date = addDays(localDateOf(fromMs, timeZone), -1), start = Date.parse(archiveDateBoundary(date, timeZone));
  while (date < last) {
    // Most days end exactly 24 h after they start. Local dates only move forward, so a guess whose instant is on
    // the next date while the millisecond before is still earlier is that date's first instant; only days where
    // the offset changes need the full boundary search. This keeps long histories (or a stray old timestamp) cheap.
    const next = addDays(date, 1), guess = start + DAY_MS;
    const end = localDateOf(guess, timeZone) === next && localDateOf(guess - 1, timeZone) < next ? guess : Date.parse(archiveDateBoundary(next, timeZone));
    if (end > start) {
      const day = dateDay(date), previous = segments.at(-1);
      if (end - start === DAY_MS) {
        // A 24-hour day starting at start maps [start, start + day) to its own date with this offset.
        const offset = day * DAY_MS - start;
        if (previous && 'offset' in previous && previous.offset === offset && previous.to === start) previous.to = end;
        else segments.push({ from: start, to: end, offset });
      } else segments.push({ from: start, to: end, day, start });
    }
    date = next; start = end;
  }
  return segments;
}

/** Local day number of an epoch-ms instant, using the same segments as the SQL; null outside them. */
export function localDayAt(at: number, segments: readonly LocalDaySegment[]): number | null {
  const segment = segments.find(item => at >= item.from && at < item.to);
  if (!segment) return null;
  return 'offset' in segment ? Math.floor((at + segment.offset) / DAY_MS) : segment.day;
}

const integer = (value: number) => { if (!Number.isSafeInteger(value)) throw new Error('统计日期边界无效。'); return String(value); };
/** Epoch milliseconds of a canonical ISO timestamp column. */
export const isoMsSql = (column: string) => `CAST(round((julianday(${column}) - 2440587.5) * 86400000.0) AS INTEGER)`;
/** SQL for the local day number and that day's first instant of an epoch-ms expression; NULL outside the segments.
 * Only integers computed here are inlined, never user input. Most recent segments come first. */
export function localDaySql(ms: string, segments: readonly LocalDaySegment[]): { day: string; dayStart: string } {
  if (!segments.length) return { day: 'NULL', dayStart: 'NULL' };
  const cases = [...segments].reverse().map(segment => {
    const when = `WHEN ${ms} >= ${integer(segment.from)} AND ${ms} < ${integer(segment.to)} THEN`;
    if ('offset' in segment) {
      const day = `((${ms} + ${integer(segment.offset)}) / ${DAY_MS})`;
      return { day: `${when} ${day}`, dayStart: `${when} ${day} * ${DAY_MS} - ${integer(segment.offset)}` };
    }
    return { day: `${when} ${integer(segment.day)}`, dayStart: `${when} ${integer(segment.start)}` };
  });
  return { day: `(CASE ${cases.map(item => item.day).join(' ')} END)`, dayStart: `(CASE ${cases.map(item => item.dayStart).join(' ')} END)` };
}
