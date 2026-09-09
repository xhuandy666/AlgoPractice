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
