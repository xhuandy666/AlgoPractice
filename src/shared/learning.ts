export type NoteKind = 'problem' | 'topic';
export type NoteOrigin = 'user' | 'ai';
export type NoteState = 'draft' | 'confirmed';
export interface Attachment { hash: string; name: string; mimeType: string; size: number; createdAt: string; }
export interface NoteDeletionResult { deleted: boolean; attachments: Attachment[]; }
export interface NoteVersion {
  noteId: string; version: number; title: string; markdown: string; tags: string[]; attachmentHashes: string[];
  origin: NoteOrigin; state: NoteState; aiRequestId: string | null; createdAt: string;
}
export interface Note {
  id: string; kind: NoteKind; subjectId: string; latestVersion: number; confirmedVersion: number | null;
  current: NoteVersion; confirmed: NoteVersion | null; createdAt: string; updatedAt: string;
}
export interface SaveNoteInput {
  requestId: string; noteId?: string; kind: NoteKind; subjectId: string;
  title: string; markdown: string; tags?: string[]; attachmentHashes?: string[];
  origin?: NoteOrigin; state?: NoteState; aiRequestId?: string; expectedVersion?: number;
}
export interface ConfirmNoteInput { requestId: string; noteId: string; version: number; expectedVersion: number; }
export interface NoteFilter { kind?: NoteKind; subjectId?: string; tag?: string; search?: string; }

export type ReviewTarget = 'understanding' | 'rewrite';
export type ReviewLanguage = 'none' | 'python' | 'java';
export type ReviewRating = 1 | 2 | 3 | 4;
export interface FsrsCardSnapshot {
  due: string; stability: number; difficulty: number; elapsed_days: number; scheduled_days: number;
  reps: number; lapses: number; state: number; learning_steps: number; last_review?: string;
}
export interface ReviewItem {
  id: string; problemId: string; target: ReviewTarget; language: ReviewLanguage;
  dueAt: string; scheduledAt: string | null; suspended: boolean; card: FsrsCardSnapshot;
  algorithmVersion: string; createdAt: string; updatedAt: string;
}
export interface AddReviewItemInput { problemId: string; target: ReviewTarget; language: ReviewLanguage; now?: string; }
export interface ReviewFeedbackInput {
  requestId: string; itemId: string; rating: ReviewRating; reviewedAt?: string; attemptId?: string;
}
export interface CorrectReviewInput { requestId: string; eventId: string; rating: ReviewRating; }
export interface ReviewEvent {
  id: string; requestId: string; itemId: string; kind: 'review' | 'correction'; rating: ReviewRating;
  reviewedAt: string; createdAt: string; correctsEventId: string | null; algorithmVersion: string; attemptId: string | null;
}
export interface ReviewFeedbackResult { item: ReviewItem; event: ReviewEvent; }
export interface ReviewFilter { problemId?: string; target?: ReviewTarget; language?: ReviewLanguage; }
export interface LearningSettings { dailyReviewBudget: number | null; dailyPracticeGoal: number; timeZone: string; updatedAt: string; }
export type LearningSettingsInput = Partial<Pick<LearningSettings, 'dailyReviewBudget' | 'dailyPracticeGoal' | 'timeZone'>>;
export interface TodayQueue {
  date: string; timeZone: string; budget: number | null; reviewedToday: number; remainingBudget: number | null;
  items: ReviewItem[]; overdueCount: number; dueCount: number; deferredCount: number; suspendedCount: number;
  newProblemIds: string[];
}
export interface ActivitySampleInput { requestId: string; attemptId: string; durationMs: number; occurredAt: string; }
export interface ActivitySample extends ActivitySampleInput { id: string; createdAt: string; }
export interface ActivityDay { date: string; activeMs: number; attempts: number; runs: number; passedRuns: number; reviewCount: number; }
export interface ArchiveStatistics {
  activeMs: number; attempts: number; runs: number; passedRuns: number; reviewedItems: number;
  days: ActivityDay[];
}
/** Completed means the user ended an attempt; it does not assert an official judge result. */
export interface LearningDay {
  date: string; activeMs: number; completedAttempts: number; completedProblems: number; reviewCount: number;
}
export interface LearningDashboard {
  date: string; timeZone: string; dailyPracticeGoal: number; from: string; to: string;
  days: LearningDay[];
  /** Totals over the same inclusive local-date window as days. */
  totals: { activeMs: number; completedAttempts: number; completedProblems: number; activeDays: number };
  reviewItems: ReviewItem[];
  /** Original completion events for the selected month, with the latest corrected rating. */
  reviewEvents: ReviewEvent[];
}
export interface BackupSnapshotInfo {
  schemaVersion: number; attachments: Attachment[]; mediaHashes: string[]; learningSettings: LearningSettings;
}


/** Bounded list queries; full bodies remain available only through detail methods. */
export interface PageRequest { offset?: number; limit?: number; }
export interface PageResult<T> { items: T[]; total: number; offset: number; limit: number; hasMore: boolean; }
export interface ProblemPageFilter extends PageRequest {
  search?: string; listId?: string; chapterId?: string; difficulty?: string; ids?: string[];
  support?: 'runnable' | 'reading'; language?: 'python' | 'java';
}
export interface ProblemListItem {
  id: string; version: string; createdAt: string; updatedAt: string;
  content: Pick<import('./library').ProblemContent, 'title' | 'difficulty' | 'tags' | 'source' | 'sourceUrl' | 'mode' | 'supportReason'> & { media?: { complete: boolean } };
  capability: { level: string; label: string; canRun: boolean; reason: string };
  capabilities: { statement: boolean; adapter: boolean; python: boolean; java: boolean; cases: number; expected: boolean };
  listItem?: import('./library').StudyListItem;
}
export interface AttemptPageFilter extends PageRequest {
  problemId?: string; language?: 'python' | 'java'; search?: string; state?: 'active' | 'ended';
  helpLevel?: 'none' | 'L0' | 'L1' | 'L2' | 'L3' | 'L4'; from?: string; to?: string;
  /** Any recorded activity on this local learning date, including an attempt spanning midnight. */
  learningDate?: string; timeZone?: string;
}
export interface AttemptListItem {
  attempt: Omit<import('../storage/practice-store').Attempt, 'problemSnapshot' | 'finalCode'>;
  title: string; runCount: number; lastStatus: import('../storage/practice-store').TerminalStatus | null;
  activeMs: number; helpLevel: string | null;
}
export interface RunPageFilter extends PageRequest {
  attemptId?: string; problemId?: string; language?: 'python' | 'java'; includeQueued?: boolean;
}
export interface RunListItem extends Omit<import('../storage/practice-store').StoredRun, 'code' | 'testSnapshot' | 'result'> {
  durationMs: number | null; caseCount: number; passedCaseCount: number;
}
export interface NotePageFilter extends NoteFilter, PageRequest { confirmedOnly?: boolean; relevantProblemId?: string; }
export interface NoteListItem extends Omit<Note, 'current' | 'confirmed'> {
  current: Omit<NoteVersion, 'markdown' | 'attachmentHashes'>;
  confirmed: Omit<NoteVersion, 'markdown' | 'attachmentHashes'> | null;
}
