import type { FsrsCardSnapshot, PageRequest, PageResult, ReviewRating } from './learning.ts';

export type ProblemReviewSource = 'manual' | 'official' | 'legacy';
export type ProblemReviewStatus = 'unassessed' | 'due' | 'overdue' | 'scheduled' | 'suspended' | 'pending';
export interface ProblemReviewPlan {
  id: string; problemId: string; card: FsrsCardSnapshot | null; dueAt: string | null;
  scheduledAt: string | null; suspended: boolean; algorithmVersion: string;
  revision: number; createdAt: string; updatedAt: string; lastReviewedAt: string | null;
  latestRating: ReviewRating | null; observationCount: number; pendingAssessmentCount: number;
  legacyItemCount: number;
}
export interface ProblemReviewEvent {
  id: string; requestId: string; planId: string; problemId: string;
  kind: 'review' | 'correction'; source: ProblemReviewSource; rating: ReviewRating;
  effectiveRating: ReviewRating; observedAt: string; createdAt: string;
  learningDate: string; timeZone: string; correctsEventId: string | null;
  algorithmVersion: string; attemptId: string | null; opportunityId: string | null;
  sourceDeleted: boolean; isInitialAssessment: boolean; legacySourceEventIds: string[];
}
export interface ReviewOpportunity {
  id: string; planId: string | null; problemId: string; learningDate: string; timeZone: string;
  acceptedAt: string; officialSubmissionId: string; submissionRecordId: string | null;
  attemptId: string | null; problemVersion: string; codeHash: string;
  state: 'pending' | 'claimed' | 'skipped' | 'assessed' | 'historical';
  claimedAt: string | null; skippedAt: string | null; assessmentEventId: string | null;
  sourceDeleted: boolean; historicalBaseline: boolean; createdAt: string;
}
export interface ReviewOpportunityFilter extends PageRequest {
  problemId?: string; pendingOnly?: boolean; learningDate?: string; submissionRecordId?: string;
}
export interface ProblemReviewAssessmentInput { requestId: string; problemId: string; rating: ReviewRating; attemptId?: string; }
export interface SubmitReviewOpportunityInput { requestId: string; opportunityId: string; rating: ReviewRating; }
export interface ProblemReviewCorrectionInput { requestId: string; eventId: string; rating: ReviewRating; }
export interface ProblemReviewResult { plan: ProblemReviewPlan; event: ProblemReviewEvent; }
export interface ProblemReviewPreviewInput {
  problemId: string; rating: ReviewRating; source?: 'manual' | 'official' | 'correction';
  opportunityId?: string; eventId?: string; requestId?: string;
}
export interface ProblemReviewPreview {
  problemId: string; learningDate: string; timeZone: string; observedAt: string;
  dueAt: string; currentDueAt: string | null; isInitialAssessment: boolean;
  conflictEventId: string | null; affectedDates: string[];
}
export interface ProblemReviewBatchInput {
  problemIds: string[]; expectedRevisions?: Record<string, number>;
  suspended?: boolean; scheduledAt?: string | null;
}
export interface ReviewPlanQuery extends PageRequest {
  view?: 'today' | 'all' | 'calendar'; search?: string; listId?: string; tag?: string;
  status?: ProblemReviewStatus; date?: string; month?: string; sort?: 'due' | 'recent';
}
export interface ReviewPlanListItem extends ProblemReviewPlan {
  title: string; difficulty: string; tags: string[]; source: string;
  sourceUrl: string | null; listIds: string[]; statuses: ProblemReviewStatus[];
  effectiveDueAt: string | null; effectiveDate: string | null;
}
export interface ReviewPlanSummary {
  date: string; timeZone: string; budget: number | null; reviewedToday: number;
  firstAssessedToday: number; remainingBudget: number | null; totalCount: number;
  dueCount: number; overdueCount: number; deferredCount: number; postponedCount: number; suspendedCount: number;
  unassessedCount: number; pendingAssessmentCount: number; plannedCount: number; extraDueCount: number;
}
export interface ReviewDayLoad {
  date: string; scheduledCount: number; reviewedCount: number; firstAssessmentCount: number;
  pendingCount: number; overdueCount: number;
}
export interface ReviewPlanSnapshot {
  snapshotVersion: string; query: ReviewPlanQuery; summary: ReviewPlanSummary;
  next7: ReviewDayLoad[]; calendar: ReviewDayLoad[]; items: PageResult<ReviewPlanListItem>;
  listOptions: Array<{ id: string; title: string }>; tagOptions: string[];
}
export interface ProblemReviewDetail {
  plan: ProblemReviewPlan; item: ReviewPlanListItem;
  events: PageResult<ProblemReviewEvent>; opportunities: PageResult<ReviewOpportunity>;
  legacySources?: PageResult<ProblemReviewLegacySource>;
  legacyPlans?: ProblemReviewLegacyPlan[];
  migration: { strategy: string | null; itemIds: string[]; conflict: boolean; historicalObservations: number };
}
export interface ProblemReviewLegacySource {
  itemId: string; eventId: string; target: string; language: string;
  kind: 'review' | 'correction'; rating: ReviewRating; observedAt: string; createdAt: string;
  correctsEventId: string | null; algorithmVersion: string; attemptId: string | null;
}
export interface ProblemReviewLegacyPlan {
  id: string; target: string; language: string; initialCard: FsrsCardSnapshot; card: FsrsCardSnapshot;
  algorithmVersion: string; parameters: unknown; dueAt: string; scheduledAt: string | null;
  suspended: boolean; createdAt: string; updatedAt: string;
}
export interface ReviewAssessmentDraftInput {
  key: string; problemId: string; source: 'manual' | 'official' | 'correction';
  opportunityId?: string; eventId?: string; rating: ReviewRating | null; requestId: string;
  expectedRevision?: number; submitted?: boolean;
}
export interface ReviewAssessmentDraft {
  key: string; problemId: string; source: 'manual' | 'official' | 'correction';
  opportunityId: string | null; eventId: string | null; rating: ReviewRating | null;
  requestId: string; learningDate: string; timeZone: string; observedAt: string;
  submittedAt: string | null; revision: number;
  resolvedEventId: string | null; updatedAt: string;
  conflictEventId?: string | null;
}
export interface ReviewSession {
  id: string; problemIds: string[]; position: number; currentProblemId: string | null;
  status: 'active' | 'ended'; skippedProblemIds: string[];
  createdAt: string; updatedAt: string; endedAt: string | null;
}
export interface StartReviewSessionInput { requestId: string; problemIds?: string[]; }
export interface AdvanceReviewSessionInput { sessionId: string; problemId: string; skipped?: boolean; }
export interface ProblemReviewMigrationReport {
  strategy: string; migratedPlans: number; legacyItems: number; legacyEvents: number;
  observations: number; historicalAcDays: number;
  conflicts: Array<{ problemId: string; itemIds: string[]; suspended: boolean; scheduledAt: string | null }>;
}
