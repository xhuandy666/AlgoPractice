import assert from 'node:assert/strict';
import { test } from 'node:test';
import { starterProgress } from '../../src/renderer/starter-progress.ts';
import { rewardProfile } from '../../src/renderer/rewards.ts';
import type { ArchiveStatistics } from '../../src/shared/learning.ts';

const profile = (values: Partial<ArchiveStatistics>) => rewardProfile({ activeMs: 0, attempts: 0, runs: 0, passedRuns: 0, reviewedItems: 0, solvedProblems: 0, officialSolvedProblems: 0, days: [], ...values }, '2026-11-20');

test('the first solved sample leaves the import step available until all three starter facts exist', () => {
  const fresh = { lists: [], totalProblems: 3 };
  assert.deepEqual(starterProgress(profile({}), fresh), { ran: false, solved: false, imported: false, complete: false });
  const solved = profile({ runs: 1, passedRuns: 1, solvedProblems: 1 });
  assert.deepEqual(starterProgress(solved, fresh), { ran: true, solved: true, imported: false, complete: false });
  const advanced = { ...solved, level: 30 };
  assert.equal(starterProgress(advanced, fresh).complete, false, 'level never hides an unfinished import step');
  assert.equal(starterProgress(solved, { lists: [], totalProblems: 4 }).complete, true, 'a direct problem import also completes the third step');
  const list = { id: 'hot100' } as never;
  assert.equal(starterProgress(solved, { lists: [list], totalProblems: 3 }).complete, true);
  assert.equal(starterProgress(profile({ runs: 0, solvedProblems: 1 }), { lists: [list], totalProblems: 3 }).complete, false, 'an official solve without a local run still leaves the run step available');
});
