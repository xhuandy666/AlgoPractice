/** First instant of a calendar day in the selected learning time zone, including DST midnight gaps. */
export function archiveDateBoundary(day: string, timeZone: string, nextDay = false): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式无效。');
  const anchor = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(anchor.getTime()) || anchor.toISOString().slice(0, 10) !== day) throw new Error('日期无效。');
  if (nextDay) anchor.setUTCDate(anchor.getUTCDate() + 1);
  const target = anchor.toISOString().slice(0, 10);
  const formatter = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDay = (at: number) => {
    const parts = formatter.formatToParts(new Date(at));
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value.padStart(type === 'year' ? 4 : 2, '0')).join('-');
  };
  let low = anchor.getTime() - 2 * 86400000, high = anchor.getTime() + 2 * 86400000;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (localDay(middle) < target) low = middle + 1; else high = middle; }
  return new Date(low).toISOString();
}
