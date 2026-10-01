import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewAssessmentDraft, ReviewAssessmentDraftInput } from '../../src/shared/review-plan.ts';
import { canDiscardConflictedReviewDraft, equivalentCommittedReviewDraft, type ReviewDraftRecoveryExpectation } from '../../src/renderer/review-draft-recovery.ts';

const observedAt = '2026-10-01T09:00:00.100Z';
const input = (patch: Partial<ReviewAssessmentDraftInput> = {}): ReviewAssessmentDraftInput => ({
  key: 'problem-review:manual:one', problemId: 'one', source: 'manual', rating: 3, requestId: 'request-one', ...patch,
});
const draft = (patch: Partial<ReviewAssessmentDraft> = {}): ReviewAssessmentDraft => ({
  ...input(), opportunityId: null, eventId: null, learningDate: '2026-10-01', timeZone: 'Asia/Shanghai', observedAt,
  submittedAt: null, revision: 1, resolvedEventId: null, conflictEventId: null, updatedAt: observedAt, ...patch,
});
const expectation = (patch: Partial<ReviewDraftRecoveryExpectation> = {}): ReviewDraftRecoveryExpectation => ({
  input: input(), startedAt: Date.parse('2026-10-01T09:00:00.000Z'), finishedAt: Date.parse('2026-10-01T09:00:00.300Z'), ...patch,
});

test('a first manual save with a lost ACK adopts only the equivalent server-stamped draft', () => {
  assert.equal(equivalentCommittedReviewDraft(draft(), expectation()), true);
  assert.equal(equivalentCommittedReviewDraft(null, expectation()), false);
  assert.equal(equivalentCommittedReviewDraft(draft({ revision: 0 }), expectation()), false);
});

test('an existing unsent edit and a submitted-freeze lost ACK recover their fresh revisions', () => {
  const update = expectation({ input: input({ expectedRevision: 7 }) });
  assert.equal(equivalentCommittedReviewDraft(draft({ revision: 8 }), update), true);
  assert.equal(equivalentCommittedReviewDraft(draft({ revision: 7 }), update), false);
  const freeze = expectation({ input: input({ expectedRevision: 7, submitted: true }) });
  assert.equal(equivalentCommittedReviewDraft(draft({ revision: 8, submittedAt: observedAt }), freeze), true);
  assert.equal(equivalentCommittedReviewDraft(draft({ revision: 8 }), freeze), false);
  assert.equal(equivalentCommittedReviewDraft(draft({ revision: 8, submittedAt: observedAt }), update), false);
});

test('a frozen manual retry is identified by its original date, instant, zone and submitted time', () => {
  const previous = draft({ submittedAt: observedAt, revision: 8 });
  const retry = expectation({ input: input({ expectedRevision: 8, submitted: true }), priorSubmittedAt: observedAt,
    observation: previous, startedAt: Date.parse('2026-10-02T09:00:00Z'), finishedAt: Date.parse('2026-10-02T09:00:01Z') });
  assert.equal(equivalentCommittedReviewDraft(previous, retry), true);
  for (const patch of [{ learningDate: '2026-10-02' }, { timeZone: 'UTC' }, { observedAt: '2026-10-01T09:00:00.200Z' },
    { submittedAt: '2026-10-02T09:00:00.100Z' }]) assert.equal(equivalentCommittedReviewDraft(draft({ ...previous, ...patch }), retry), false);
});

test('different keys, requests, problems, sources, opportunity or event identities and ratings are real conflicts', () => {
  for (const patch of [{ key: 'another-key' }, { requestId: 'another-request' }, { problemId: 'two' }, { source: 'official' as const },
    { opportunityId: 'another-opportunity' }, { eventId: 'another-event' }, { rating: 4 as const }]) {
    assert.equal(equivalentCommittedReviewDraft(draft(patch), expectation()), false);
  }
});

test('unfrozen manual recovery rejects another observation window and inconsistent or invalid local dates', () => {
  for (const patch of [{ observedAt: '2026-10-01T08:59:59Z' }, { observedAt: '2026-10-01T09:00:02Z' },
    { learningDate: '2026-10-02' }, { timeZone: 'Not/AZone' }, { observedAt: 'not-a-date' }]) {
    assert.equal(equivalentCommittedReviewDraft(draft(patch), expectation()), false);
  }
  assert.equal(equivalentCommittedReviewDraft(draft({ submittedAt: '2026-10-01T09:00:02Z' }), expectation({ input: input({ submitted: true }) })), false);
});

test('official and correction lost ACKs require the exact bound source observation, not a manual time window', () => {
  for (const source of ['official', 'correction'] as const) {
    const sourceInput = input({ source, ...(source === 'official' ? { opportunityId: 'ac-one' } : { eventId: 'event-one' }) });
    const sourceDraft = draft({ ...sourceInput, opportunityId: sourceInput.opportunityId ?? null, eventId: sourceInput.eventId ?? null });
    const expected = expectation({ input: sourceInput, observation: sourceDraft });
    assert.equal(equivalentCommittedReviewDraft(sourceDraft, expected), true);
    assert.equal(equivalentCommittedReviewDraft(sourceDraft, expectation({ input: sourceInput })), false);
    assert.equal(equivalentCommittedReviewDraft({ ...sourceDraft, observedAt: '2026-10-01T09:00:00.200Z' }, expected), false);
  }
});

test('invalid or reversed main-clock bounds reject recovery even with a frozen exact observation', () => {
  const frozen = draft({ submittedAt: observedAt });
  const expected = expectation({ input: input({ submitted: true }), observation: frozen, priorSubmittedAt: observedAt });
  for (const patch of [{ startedAt: NaN }, { finishedAt: Infinity }, { startedAt: -1 }, { startedAt: 1.5 },
    { finishedAt: Number.MAX_SAFE_INTEGER + 1 }, { finishedAt: expected.startedAt - 1 }]) {
    assert.equal(equivalentCommittedReviewDraft(frozen, { ...expected, ...patch }), false);
  }
});

test('freezing an official or correction draft requires submittedAt in the main call, not its historical source time', () => {
  for (const source of ['official', 'correction'] as const) {
    const sourceInput = input({ source, submitted: true, ...(source === 'official' ? { opportunityId: 'ac-one' } : { eventId: 'event-one' }) });
    const historical = draft({ ...sourceInput, opportunityId: sourceInput.opportunityId ?? null, eventId: sourceInput.eventId ?? null,
      observedAt: '2026-09-30T09:00:00.100Z', learningDate: '2026-09-30', submittedAt: observedAt });
    const expected = expectation({ input: sourceInput, observation: historical });
    assert.equal(equivalentCommittedReviewDraft(historical, expected), true);
    assert.equal(equivalentCommittedReviewDraft({ ...historical, submittedAt: historical.observedAt }, expected), false);
  }
});

test('explicit close may discard only the same frozen, unresolved, permanently occupied date slot', () => {
  const original = draft({ submittedAt: observedAt, revision: 8 });
  const collision = { ...original, conflictEventId: 'other-observation' };
  assert.equal(canDiscardConflictedReviewDraft(collision, original, false), true);
  assert.equal(canDiscardConflictedReviewDraft(collision, original, true), false);
  assert.equal(canDiscardConflictedReviewDraft(original, original, false), false);
  for (const patch of [{ requestId: 'other-request' }, { rating: 4 as const }, { learningDate: '2026-10-02' },
    { observedAt: '2026-10-01T09:00:00.200Z' }, { source: 'correction' as const }, { resolvedEventId: 'saved-result' }, { submittedAt: null }]) {
    assert.equal(canDiscardConflictedReviewDraft({ ...collision, ...patch }, original, false), false);
  }
});
