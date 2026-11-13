import type { Language } from './languages.ts';

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

export type ReviewRating = 1 | 2 | 3 | 4;
export interface FsrsCardSnapshot {
  due: string; stability: number; difficulty: number; elapsed_days: number; scheduled_days: number;
  reps: number; lapses: number; state: number; learning_steps: number; last_review?: string;
}
export interface LearningSettings { dailyReviewBudget: number | null; dailyPracticeGoal: number; timeZone: string; updatedAt: string; /** Default off; analysis is triggered only by a newly completed official submission. */ aiAutoAnalyzeOfficial?: boolean; }
export type LearningSettingsInput = Partial<Pick<LearningSettings, 'dailyReviewBudget' | 'dailyPracticeGoal' | 'timeZone' | 'aiAutoAnalyzeOfficial'>>;
export interface ActivitySampleInput { requestId: string; attemptId: string; durationMs: number; occurredAt: string; }
export interface ActivitySample extends ActivitySampleInput { id: string; createdAt: string; }
/** practiceRuns: non-passing runs that compiled or executed the user's code (no expected output, wrong answer,
 * compile/runtime error, timeout, output limit); cancelled, interrupted and environment/runner failures are excluded.
 * officialAccepted: distinct problems with a LeetCode official Accepted confirmed on that local day. */
/** completedProblems: distinct problems completed that day (see LearningDay). */
export interface ActivityDay { date: string; activeMs: number; attempts: number; completedProblems: number; runs: number; passedRuns: number; practiceRuns: number; officialAccepted: number; reviewCount: number; }
/** Current-state signals for one practiced problem. `rating` is the latest effective self-rating (corrections
 * applied); `aiHelps` counts only user-initiated hint, diagnosis and chat requests. */
export interface ProblemStruggleSignals {
  problemId: string; title: string; tags: string[];
  passedRuns: number; failedRuns: number; officialAccepted: number; officialRejected: number; aiHelps: number;
  rating: ReviewRating | null;
}
/** Why a practiced problem currently looks hard. Never "unsolved" alone: most problems cannot pass locally. */
export type StruggleReason = 'rated-hard' | 'official-failures' | 'local-failures' | 'ai-help';
export interface TopicInsight {
  tag: string; practiced: number; struggling: number;
  reasons: Record<StruggleReason, number>;
  strugglingProblems: { id: string; title: string }[];
  recommended: { id: string; title: string; difficulty: string }[];
}
export interface TopicInsights { language: Language; topics: TopicInsight[] }
/** solvedProblems: distinct problems with a local run that passed the problem's own cases, or an official Accepted;
 * officialSolvedProblems counts only the latter. passedRuns likewise counts only passes on the problem's own cases. */
export interface ArchiveStatistics {
  activeMs: number; attempts: number; runs: number; passedRuns: number; reviewedItems: number;
  solvedProblems: number; officialSolvedProblems: number;
  days: ActivityDay[];
}
/** A practice completes when it first solves its problem (its own cases all pass locally, or an official Accepted).
 * Otherwise it completes when it is ended, if before that its final code ran without failing (or reached the official
 * judge) and no official judge rejected that code; most LeetCode problems cannot be judged locally, so for them a run and
 * the end are the signal. completedProblems counts distinct problems. */
export type CompletionBlocker = 'failed' | 'unrun';
export interface LearningDay {
  date: string; activeMs: number; completedProblems: number; reviewCount: number;
}
export interface LearningDashboard {
  date: string; timeZone: string; dailyPracticeGoal: number; from: string; to: string;
  days: LearningDay[];
  /** Totals over the same inclusive local-date window as days. */
  totals: { activeMs: number; completedProblems: number; activeDays: number };
}
export interface BackupSnapshotInfo {
  schemaVersion: number; attachments: Attachment[]; mediaHashes: string[]; learningSettings: LearningSettings;
}


/** Bounded list queries; full bodies remain available only through detail methods. */
export interface PageRequest { offset?: number; limit?: number; }
export interface PageResult<T> { items: T[]; total: number; offset: number; limit: number; hasMore: boolean; }
export interface ProblemPageFilter extends PageRequest {
  search?: string; listId?: string; chapterId?: string; difficulty?: string; ids?: string[];
  support?: 'runnable' | 'reading'; language?: Language;
  /** Practice state: never opened, opened at least once, solved (local all-pass or official Accepted), or due for review today. */
  practice?: PracticeState;
}
export type PracticeState = 'unpracticed' | 'practiced' | 'solved' | 'review-due';
/** Distinct problems of a study list that were practiced or solved (local all-pass or official Accepted). */
export interface ListProgress { total: number; practiced: number; solved: number }
export interface ProblemListItem {
  id: string; version: string; createdAt: string; updatedAt: string;
  content: Pick<import('./library').ProblemContent, 'title' | 'difficulty' | 'tags' | 'source' | 'sourceUrl' | 'mode' | 'supportReason'> & { media?: { complete: boolean } };
  capability: { level: string; label: string; canRun: boolean; reason: string };
  capabilities: { statement: boolean; adapter: boolean; python: boolean; java: boolean; go: boolean; cpp: boolean;
    /** Raw C++ template evidence; historical pool snapshots may predate this projection. */
    cppTemplate?: boolean; cases: number; expected: boolean };
  listItem?: import('./library').StudyListItem;
  practice?: { practiced: boolean; solved: boolean; reviewDue: boolean };
}
export interface AttemptPageFilter extends PageRequest {
  problemId?: string; language?: Language; search?: string; state?: 'active' | 'ended';
  from?: string; to?: string;
  /** Any recorded activity on this local learning date, including an attempt spanning midnight. */
  learningDate?: string; timeZone?: string;
}
export interface AttemptListItem {
  attempt: Omit<import('../storage/practice-store').Attempt, 'problemSnapshot' | 'finalCode' | 'finalTestConfig'>;
  title: string; runCount: number; lastStatus: import('../storage/practice-store').TerminalStatus | null;
  activeMs: number; usedAi: boolean;
}
export interface RunPageFilter extends PageRequest {
  attemptId?: string; problemId?: string; language?: Language; includeQueued?: boolean;
}
export interface RunListItem extends Omit<import('../storage/practice-store').StoredRun, 'code' | 'testSnapshot' | 'result'> {
  durationMs: number | null; caseCount: number; passedCaseCount: number;
}
export interface NotePageFilter extends NoteFilter, PageRequest { confirmedOnly?: boolean; relevantProblemId?: string; }
export interface NoteListItem extends Omit<Note, 'current' | 'confirmed'> {
  current: Omit<NoteVersion, 'markdown' | 'attachmentHashes'>;
  confirmed: Omit<NoteVersion, 'markdown' | 'attachmentHashes'> | null;
}
