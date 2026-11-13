// Statistics, the dashboard and archive filters ask for the same day boundaries again and again (two per
// local day of history, on every refresh). Building a time-zone formatter and binary-searching each time
// blocked the main process for about a second per year of history, so both are memoized. The result for a
// given zone and date is fixed for the life of the process, which uses one ICU time-zone database.
const FORMATTER_LIMIT = 32, BOUNDARY_LIMIT = 16384;
const formatters = new Map<string, Intl.DateTimeFormat>();
const boundaries = new Map<string, string>();
function remember<V>(cache: Map<string, V>, limit: number, key: string, value: V): V {
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, value); return value;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return formatters.get(timeZone)
    ?? remember(formatters, FORMATTER_LIMIT, timeZone, new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
}
function formatDay(formatter: Intl.DateTimeFormat, at: number): string {
  const parts = formatter.formatToParts(new Date(at));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value.padStart(type === 'year' ? 4 : 2, '0')).join('-');
}
/** Calendar date (YYYY-MM-DD) of an instant in the selected learning time zone. */
export function localDateOf(at: number, timeZone: string): string {
  if (!Number.isFinite(at)) throw new Error('时间无效。');
  return formatDay(formatterFor(timeZone), at);
}

/** First instant of a calendar day in the selected learning time zone, including DST midnight gaps. */
export function archiveDateBoundary(day: string, timeZone: string, nextDay = false): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式无效。');
  const anchor = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(anchor.getTime()) || anchor.toISOString().slice(0, 10) !== day) throw new Error('日期无效。');
  if (nextDay) anchor.setUTCDate(anchor.getUTCDate() + 1);
  const target = anchor.toISOString().slice(0, 10), key = `${timeZone}\0${target}`;
  const cached = boundaries.get(key); if (cached !== undefined) return cached;
  // An invalid zone throws here on every call and is never cached.
  const formatter = formatterFor(timeZone), localDay = (at: number) => formatDay(formatter, at);
  let low = anchor.getTime() - 2 * 86400000, high = anchor.getTime() + 2 * 86400000;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (localDay(middle) < target) low = middle + 1; else high = middle; }
  return remember(boundaries, BOUNDARY_LIMIT, key, new Date(low).toISOString());
}
