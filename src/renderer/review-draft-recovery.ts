import type { ReviewAssessmentDraft, ReviewAssessmentDraftInput } from '../shared/review-plan.ts';
import { dateKey } from './learning-calendar.ts';

type ObservationIdentity = Pick<ReviewAssessmentDraft, 'learningDate' | 'timeZone' | 'observedAt'>;
export interface ReviewDraftRecoveryExpectation {
  input: ReviewAssessmentDraftInput;
  startedAt: number;
  finishedAt: number;
  /** Frozen manual drafts and official/correction sources have an exact observation identity. */
  observation?: ObservationIdentity;
  priorSubmittedAt?: string | null;
}

export function matchesReviewDraftIdentity(draft: ReviewAssessmentDraft, input: ReviewAssessmentDraftInput): boolean {
  return draft.key === input.key && draft.requestId === input.requestId && draft.problemId === input.problemId
    && draft.source === input.source && draft.opportunityId === (input.opportunityId ?? null)
    && draft.eventId === (input.eventId ?? null);
}

/** Reconcile a lost ACK, not a new request: no writes and no replacement of another draft. */
export function equivalentCommittedReviewDraft(draft: ReviewAssessmentDraft | null, expectation: ReviewDraftRecoveryExpectation): boolean {
  if (!draft || !matchesReviewDraftIdentity(draft, expectation.input) || draft.rating !== expectation.input.rating) return false;
  const priorSubmittedAt = expectation.priorSubmittedAt ?? null;
  const submitted = Boolean(expectation.input.submitted || priorSubmittedAt);
  if (Boolean(draft.submittedAt) !== submitted) return false;
  const minimumRevision = expectation.input.expectedRevision === undefined ? 1
    : expectation.input.expectedRevision + (priorSubmittedAt ? 0 : 1);
  if (!Number.isInteger(draft.revision) || draft.revision < minimumRevision) return false;
  const withinCall = (timestamp: string) => {
    const at = Date.parse(timestamp);
    return Number.isFinite(at) && expectation.startedAt <= expectation.finishedAt
      && at >= expectation.startedAt && at <= expectation.finishedAt;
  };
  if (priorSubmittedAt ? draft.submittedAt !== priorSubmittedAt : draft.submittedAt && !withinCall(draft.submittedAt)) return false;
  if (expectation.observation) {
    const expected = expectation.observation;
    return draft.learningDate === expected.learningDate && draft.timeZone === expected.timeZone && draft.observedAt === expected.observedAt;
  }
  // Only unfrozen manual saves are stamped by this call. Their server-authored zone/date must
  // be internally consistent, and their observed instant must fall inside the failed call.
  if (draft.source !== 'manual' || !withinCall(draft.observedAt)) return false;
  try { return dateKey(draft.observedAt, draft.timeZone) === draft.learningDate; } catch { return false; }
}

/** A frozen date-slot collision may be discarded only after the original request was queried. */
export function canDiscardConflictedReviewDraft(draft: ReviewAssessmentDraft | null, expected: ReviewAssessmentDraft,
  originalRequestHasResult: boolean): boolean {
  return Boolean(draft && !originalRequestHasResult && draft.source !== 'correction' && draft.submittedAt && !draft.resolvedEventId
    && draft.conflictEventId && matchesReviewDraftIdentity(draft, { key: expected.key, requestId: expected.requestId,
      problemId: expected.problemId, source: expected.source, opportunityId: expected.opportunityId ?? undefined,
      eventId: expected.eventId ?? undefined, rating: expected.rating })
    && draft.rating === expected.rating && draft.learningDate === expected.learningDate && draft.timeZone === expected.timeZone
    && draft.observedAt === expected.observedAt && draft.submittedAt === expected.submittedAt);
}
