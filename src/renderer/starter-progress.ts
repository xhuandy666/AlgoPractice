import type { LibraryIndex } from '../shared/bridge.ts';
import { demoProblems } from '../shared/demo-problems.ts';
import type { RewardProfile } from './rewards.ts';

/** Keep the import step available after the first solved sample, until the whole path is complete. Level alone does
 * not complete a step; the durable learning and library facts work after a backup restore without another local flag. */
export function starterProgress(profile: Pick<RewardProfile, 'totals'>, library: Pick<LibraryIndex, 'lists' | 'totalProblems'>) {
  const ran = profile.totals.runs > 0, solved = profile.totals.solvedProblems > 0;
  const imported = library.lists.length > 0 || library.totalProblems > demoProblems.length;
  return { ran, solved, imported, complete: ran && solved && imported };
}
