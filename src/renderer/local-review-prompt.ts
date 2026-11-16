import type { ExpectedOutputSource } from '../shared/answer-format';
import type { ReviewAssessmentDraft } from '../shared/review-plan';

/** The rating dialog's persisted draft key: one per source, so all manual ratings of a problem share one draft. */
export const reviewDraftKey = (kind: 'manual' | 'official' | 'correction', sourceId: string) => `problem-review:${kind}:${sourceId}`;

/** A run may offer self-rating, as an official Accepted does, when it passed the problem's own cases in ordinary practice.
 * Review sessions and redo practice rate through their own controls; a pass on self-written cases is only a self-check. */
export function localPassMayPrompt(run: { status: string; expectedOutputSource?: ExpectedOutputSource }, scope: string): boolean {
  return run.status === 'passed' && run.expectedOutputSource === 'native-samples' && scope === 'practice';
}

/** Offer it only while edits are not frozen, today has no rating yet, the offer was not already put off today, and no earlier
 * manual rating draft is waiting: a draft keeps the day it was written for. Unlike an official Accepted, which ends a solving
 * session and asks at once, a local pass is often a step before submitting, so it offers a button beside the result. */
export function shouldOfferLocalReview(state: { frozen: boolean; dismissedToday: boolean;
  draft: ReviewAssessmentDraft | null; conflictEventId: string | null }): boolean {
  return !state.frozen && !state.dismissedToday && state.draft === null && state.conflictEventId === null;
}
