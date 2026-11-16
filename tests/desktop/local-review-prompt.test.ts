import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localPassMayPrompt, reviewDraftKey, shouldOfferLocalReview } from '../../src/renderer/local-review-prompt.ts';
import type { ReviewAssessmentDraft } from '../../src/shared/review-plan.ts';

test('only a pass on the problem\'s own cases in ordinary practice may offer self-rating', () => {
  const pass = { status: 'passed', expectedOutputSource: 'native-samples' as const };
  assert.equal(localPassMayPrompt(pass, 'practice'), true);
  assert.equal(localPassMayPrompt({ ...pass, expectedOutputSource: 'user' }, 'practice'), false, 'self-written cases are a self-check');
  assert.equal(localPassMayPrompt({ ...pass, expectedOutputSource: 'none' }, 'practice'), false, 'output without expectations is not judged');
  assert.equal(localPassMayPrompt({ status: 'passed' }, 'practice'), false, 'a run that does not say where its expectations came from');
  for (const status of ['completed', 'wrong_answer', 'compile_error', 'interrupted']) assert.equal(localPassMayPrompt({ ...pass, status }, 'practice'), false, status);
  for (const scope of ['review:session-1', 'redo:abc', 'restore:request-1']) assert.equal(localPassMayPrompt(pass, scope), false, `${scope} rates through its own controls`);
});

test('the offer appears only with nothing already rated, put off or drafted today, and edits not frozen', () => {
  const clear = { frozen: false, dismissedToday: false, draft: null, conflictEventId: null };
  assert.equal(shouldOfferLocalReview(clear), true);
  assert.equal(shouldOfferLocalReview({ ...clear, frozen: true }), false);
  assert.equal(shouldOfferLocalReview({ ...clear, dismissedToday: true }), false);
  assert.equal(shouldOfferLocalReview({ ...clear, conflictEventId: 'review-1' }), false, 'today already has a rating');
  assert.equal(shouldOfferLocalReview({ ...clear, draft: { key: reviewDraftKey('manual', 'p1') } as ReviewAssessmentDraft }), false,
    'an earlier manual draft keeps its own day and must not be reopened by a prompt');
  assert.equal(reviewDraftKey('manual', 'p1'), 'problem-review:manual:p1');
});
