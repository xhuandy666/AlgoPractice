import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveDateBoundary } from '../../src/shared/archive-date.ts';

const boundaries = [
  ['Shanghai start is midnight in the selected learning zone', '2026-09-09', 'Asia/Shanghai', false, '2026-09-08T16:00:00.000Z'],
  ['Shanghai end is the following local midnight, exclusive', '2026-09-09', 'Asia/Shanghai', true, '2026-09-09T16:00:00.000Z'],
  ['Los Angeles spring DST day starts with the old offset', '2026-03-08', 'America/Los_Angeles', false, '2026-03-08T08:00:00.000Z'],
  ['Los Angeles spring DST end makes a 23-hour local day', '2026-03-08', 'America/Los_Angeles', true, '2026-03-09T07:00:00.000Z'],
  ['Los Angeles autumn DST day starts with the daylight offset', '2026-11-01', 'America/Los_Angeles', false, '2026-11-01T07:00:00.000Z'],
  ['Los Angeles autumn DST end makes a 25-hour local day', '2026-11-01', 'America/Los_Angeles', true, '2026-11-02T08:00:00.000Z'],
  ['Sao Paulo midnight gap uses the first existing instant of the day', '2018-11-04', 'America/Sao_Paulo', false, '2018-11-04T03:00:00.000Z'],
  ['Apia skipped calendar day advances to its first subsequent instant', '2011-12-30', 'Pacific/Apia', false, '2011-12-30T10:00:00.000Z'],
  ['Leap-day inclusive end advances to March in UTC', '2024-02-29', 'UTC', true, '2024-03-01T00:00:00.000Z'],
] as const;

for (const [name, date, timeZone, nextDay, expected] of boundaries) test(name, () => {
  assert.equal(archiveDateBoundary(date, timeZone, nextDay), expected);
});
for (const date of ['2026-02-30', '2026-1-1', 'bad']) test(`Invalid archive date is rejected: ${date}`, () => {
  assert.throws(() => archiveDateBoundary(date, 'UTC'));
});
test('memoized boundaries stay exact per zone and date, and an end boundary equals the next day start', () => {
  for (let round = 0; round < 2; round++) {
    assert.equal(archiveDateBoundary('2026-09-09', 'Asia/Shanghai'), '2026-09-08T16:00:00.000Z');
    assert.equal(archiveDateBoundary('2026-09-09', 'UTC'), '2026-09-09T00:00:00.000Z', 'zones never share a cached day');
    assert.equal(archiveDateBoundary('2026-03-08', 'America/Los_Angeles', true), archiveDateBoundary('2026-03-09', 'America/Los_Angeles'));
  }
  for (let round = 0; round < 2; round++) assert.throws(() => archiveDateBoundary('2026-09-09', 'Not/AZone'), RangeError, 'an invalid zone is rejected every time');
});
test('each zone builds one formatter and each day boundary is searched once', () => {
  const Original = Intl.DateTimeFormat, originalParts = Original.prototype.formatToParts;
  let built = 0, searched = 0;
  class Counting extends Original { constructor(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) { super(...args); built++; } }
  Object.defineProperty(Intl, 'DateTimeFormat', { value: Counting, configurable: true, writable: true });
  Original.prototype.formatToParts = function (this: Intl.DateTimeFormat, ...args: Parameters<Intl.DateTimeFormat['formatToParts']>) { searched++; return originalParts.apply(this, args); };
  try {
    const days = Array.from({ length: 30 }, (_, index) => new Date(Date.UTC(2026, 0, 1) + index * 86400000).toISOString().slice(0, 10));
    for (const day of days) { archiveDateBoundary(day, 'Asia/Kolkata'); archiveDateBoundary(day, 'Asia/Kolkata', true); }
    assert.equal(built, 1, 'one formatter for the zone, not one per call');
    const firstPass = searched;
    assert.ok(firstPass > 0);
    for (let round = 0; round < 5; round++) for (const day of days) { archiveDateBoundary(day, 'Asia/Kolkata'); archiveDateBoundary(day, 'Asia/Kolkata', true); }
    assert.equal(searched, firstPass, 'repeated refreshes reuse every boundary instead of searching again');
    assert.equal(archiveDateBoundary('2026-01-02', 'Asia/Kolkata'), '2026-01-01T18:30:00.000Z');
  } finally {
    Object.defineProperty(Intl, 'DateTimeFormat', { value: Original, configurable: true, writable: true });
    Original.prototype.formatToParts = originalParts;
  }
});
