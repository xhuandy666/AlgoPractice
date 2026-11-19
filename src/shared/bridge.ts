import type { OfficialSubmitInput, OfficialSubmission } from './official';
import type { RuntimeState } from './runtime';
import type { AnswerFormat, AcmTestConfig, ExpectedOutputSource, PracticeSpec } from './answer-format';
import type { SaveSubmissionRemarkInput, SubmissionHistoryDetail, SubmissionHistoryFilter, SubmissionHistoryItem, SubmissionHistorySource, SubmissionRemark } from './submission-history';
import type { CompanyDataset, CompanyPreview, InterviewRules, InterviewPool, InterviewView, InterviewSaveResult } from './interview';
import type { Language, RunEvent, RunResult, RunStatus } from '../runner/types';
import type { Attempt, Draft } from '../storage/practice-store';
import type { ImportJob, LibraryProblem, StudyList, ListRefreshPreview } from './library';
import type { ImportInput, ImportPreview } from '../source/index';
import type { AiProviderConfig, AiProviderState, AiConnectionResult, AiRequestInput, AiRequestRecord, AiEvent, AiHelpDecision, AiPatchApplication, AiUsageSummary } from './ai';
import type { ReminderSettings, ReminderStatus, BackupSummary, BackupManifest, MirrorStatus, RestoreResult, UpdateCheck } from './maintenance';
import type { AppUpdateState } from './update';
import type { Note, NoteVersion, SaveNoteInput, ConfirmNoteInput, NoteFilter, Attachment, LearningSettings, LearningSettingsInput, LearningDashboard, ArchiveStatistics, TopicInsights } from './learning';
import type { PageResult, ProblemPageFilter, ProblemListItem, NotePageFilter, NoteListItem, AttemptPageFilter, AttemptListItem, RunPageFilter, RunListItem, ListProgress, CompletionBlocker } from './learning';
import type { AdvanceReviewSessionInput, ProblemReviewAssessmentInput, ProblemReviewBatchInput, ProblemReviewCorrectionInput,
  ProblemReviewDetail, ProblemReviewPlan, ProblemReviewPreview, ProblemReviewPreviewInput, ProblemReviewResult,
  ReviewAssessmentDraft, ReviewAssessmentDraftInput, ReviewOpportunity, ReviewOpportunityFilter, ReviewPlanQuery,
  ReviewPlanSnapshot, ReviewSession, StartReviewSessionInput, SubmitReviewOpportunityInput } from './review-plan';
export type Page = 'today' | 'reviews' | 'library' | 'workbench' | 'sources' | 'notes' | 'archives' | 'learning-settings' | 'environment' | 'interview';
export interface RunArchive {
  id: string; attemptId: string; problemId: string; problemVersion: string; code: string; language: Language; createdAt: string;
  result: Omit<RunResult, 'status'> & { status: RunStatus | 'interrupted' };
  answerFormat?: AnswerFormat; specVersion?: string; testConfigDigest?: string | null; testConfig?: AcmTestConfig;
  expectedOutputSource?: ExpectedOutputSource;
}
export interface RuntimeProgress { language: Language; phase: 'download' | 'copy' | 'verify' | 'extract' | 'validate' | 'commit' | 'ready'; receivedBytes: number; totalBytes: number; }
export interface EnvironmentInfo {
  platform: string; arch: string; electron: string; node: string; sqlite: string;
  python: string | null; java: string | null; go: string | null; cpp: string | null; dataDirectory: string;
  runtimeNotices: string[];
  installation: { language: Language; progress: RuntimeProgress | null } | null;
  runtimeStates: Record<Language, RuntimeState>;
  installations: Partial<Record<Language, { progress: RuntimeProgress | null }>>;
  autoInstallRuntimes: boolean;
  notificationSupported: boolean; reminder: { dueAt: string; deliveredAt?: string } | null;
}
export interface LibraryData { problems: LibraryProblem[]; lists: StudyList[]; jobs: ImportJob[]; }
export interface LibraryIndex { problems: ProblemListItem[]; totalProblems: number; lists: StudyList[]; jobs: ImportJob[]; progress?: Record<string, ListProgress>; }
export interface WorkspaceData { problem: LibraryProblem; latestVersion: string; draft: Draft | null; attempt: Attempt | null; history: RunArchive[]; historyTotal?: number; spec?: PracticeSpec; }
/** completedAt: when this practice counted as completed; otherwise notCountedBecause says why its end does not count. */
export type FinishedAttempt = Attempt & { completedAt: string | null; notCountedBecause: CompletionBlocker | null };
export interface ArchiveDetail { attempt: Attempt; runs: RunArchive[]; aiRequests?: AiRequestRecord[]; noteVersions?: NoteVersion[]; activeMs?: number; }
export interface PreparedImport { id: string; preview: ImportPreview; membership: ListRefreshPreview | null; }
export interface Hot100ImportResult { listId: string; job: ImportJob | null; }
export interface PreparedProblemRefresh { id: string; before: LibraryProblem; after: LibraryProblem['content']; changed: boolean; }
export interface BackupState { busy: boolean; backups: BackupSummary[]; lastError: string | null; mirror?: MirrorStatus; }
export interface PreparedRestore { id: string; manifest: BackupManifest; bytes: number; }
export interface RunPreparation { token: string; runtime: RuntimeState; autoInstall: boolean; }
export interface RunOptions { answerFormat?: 'function' | 'acm'; preparationToken?: string; }
/** One self-written input for a function problem: the arguments in signature order (see shared/self-test.ts). */
export interface SelfTestOptions { args: import('../runner/types').WireValue[]; preparationToken?: string; requestId?: string; }
export interface DraftOptions { answerFormat?: AnswerFormat; testConfig?: AcmTestConfig; expectedRevision?: number; }
export interface DesktopBridge {
  submissionHistory(filter: SubmissionHistoryFilter): Promise<PageResult<SubmissionHistoryItem>>;
  submissionHistoryDetail(source: SubmissionHistorySource, id: string): Promise<SubmissionHistoryDetail>;
  saveSubmissionRemark(input: SaveSubmissionRemarkInput): Promise<SubmissionRemark>;
  officialSubmit(input: OfficialSubmitInput): Promise<OfficialSubmission>;
  officialSubmissions(attemptId: string): Promise<OfficialSubmission[]>;
  officialResume(id: string): Promise<OfficialSubmission>;
  onOfficialEvent(callback: (record: OfficialSubmission) => void): () => void;
  interviewState(): Promise<{ active: InterviewView | null; history: { id: string; mode: 'strict' | 'coached'; startedAt: string; endedAt: string | null; count: number; anomalous: boolean }[]; datasets: CompanyDataset[] }>;
  previewInterview(rules: InterviewRules): Promise<{ id: string; pool: InterviewPool }>;
  startInterview(previewId: string, requestId: string): Promise<InterviewView>;
  interview(id: string): Promise<InterviewView>;
  saveInterview(id: string, problemId: string, code: string, reasoning: string): Promise<InterviewSaveResult>;
  finishInterview(id: string): Promise<InterviewView>;
  coachInterview(id: string): Promise<InterviewView>;
  runInterview(id: string, problemId: string, requestId: string, supplement: boolean): Promise<RunArchive>;
  applyInterviewPatch(id: string, requestId: string): Promise<InterviewSaveResult>;
  reviewInterview(id: string, problemId: string): Promise<ProblemReviewPlan>;
  previewCompany(input: { kind: 'csv' | 'json'; text: string; name: string }): Promise<{ id: string; preview: CompanyPreview }>;
  commitCompany(id: string): Promise<CompanyDataset>;
  completeCompanyProblems(id: string, requestId: string): Promise<ImportJob>;
  selectCompanyFile(): Promise<{ kind: 'csv' | 'json'; text: string; name: string } | null>;

  learningSettings(): Promise<LearningSettings>;
  saveLearningSettings(input: LearningSettingsInput): Promise<LearningSettings>;
  learningDashboard(): Promise<LearningDashboard>;
  reviewPlan(query?: ReviewPlanQuery): Promise<ReviewPlanSnapshot>;
  problemReviewDetail(problemId: string, history?: import('./learning').PageRequest): Promise<ProblemReviewDetail>;
  addProblemReviews(input: { problemIds: string[] }): Promise<ProblemReviewPlan[]>;
  updateProblemReviews(input: ProblemReviewBatchInput): Promise<ProblemReviewPlan[]>;
  previewProblemReview(input: ProblemReviewPreviewInput): Promise<ProblemReviewPreview>;
  recordProblemReview(input: ProblemReviewAssessmentInput): Promise<ProblemReviewResult>;
  submitReviewOpportunity(input: SubmitReviewOpportunityInput): Promise<ProblemReviewResult>;
  correctProblemReview(input: ProblemReviewCorrectionInput): Promise<ProblemReviewResult>;
  problemReviewRequest(requestId: string): Promise<ProblemReviewResult | null>;
  reviewOpportunities(filter?: ReviewOpportunityFilter): Promise<PageResult<ReviewOpportunity>>;
  reviewOpportunityForSubmission(submissionRecordId: string): Promise<ReviewOpportunity | null>;
  claimReviewOpportunity(id: string): Promise<ReviewOpportunity | null>;
  skipReviewOpportunity(id: string): Promise<ReviewOpportunity>;
  /** Main-process wall clock, shared with server-authored assessment timestamps. */
  reviewAssessmentTime(): Promise<number>;
  saveReviewAssessmentDraft(input: ReviewAssessmentDraftInput): Promise<ReviewAssessmentDraft>;
  reviewAssessmentDraft(key: string): Promise<ReviewAssessmentDraft | null>;
  deleteReviewAssessmentDraft(key: string, expectedRevision?: number): Promise<boolean>;
  startReviewSession(input: StartReviewSessionInput): Promise<ReviewSession>;
  reviewSession(id?: string): Promise<ReviewSession | null>;
  advanceReviewSession(input: AdvanceReviewSessionInput): Promise<ReviewSession>;
  endReviewSession(id: string): Promise<ReviewSession>;
  learningStatistics(): Promise<ArchiveStatistics>;
  /** Weakest practiced topics (current-state struggle signals) with redo and next-problem suggestions in `language`. */
  topicInsights(language: Language): Promise<TopicInsights>;
  notes(filter?: NoteFilter): Promise<Note[]>;
  note(id: string): Promise<Note | null>;
  saveNote(input: SaveNoteInput): Promise<Note>;
  confirmNote(input: ConfirmNoteInput): Promise<Note>;
  deleteNote(id: string, expectedVersion: number): Promise<void>;
  noteVersions(id: string): Promise<NoteVersion[]>;
  exportNote(id: string, version: number): Promise<boolean>;
  addAttachment(): Promise<Attachment | null>;
  saveAiNoteDraft(requestId: string): Promise<Note>;
  reminderState(): Promise<ReminderStatus>;
  saveReminderSettings(settings: ReminderSettings): Promise<ReminderStatus>;
  backups(): Promise<BackupState>;
  /** Opens the folder picker; null when cancelled. */
  chooseBackupMirror(): Promise<MirrorStatus | null>;
  clearBackupMirror(): Promise<MirrorStatus>;
  syncBackupMirror(): Promise<MirrorStatus>;
  createBackup(): Promise<BackupSummary | null>;
  previewRestore(): Promise<PreparedRestore | null>;
  restoreBackup(previewId: string): Promise<RestoreResult>;
  aiProvider(): Promise<AiProviderState>;
  saveAiAutoAnalysis(enabled: boolean): Promise<AiProviderState>;
  saveAiProvider(config: AiProviderConfig, key?: string): Promise<AiProviderState>;
  clearAiKey(): Promise<AiProviderState>;
  testAiProvider(): Promise<AiConnectionResult>;
  aiRequests(attemptId: string): Promise<AiRequestRecord[]>;
  aiUsage(): Promise<AiUsageSummary>;
  askAi(input: AiRequestInput): Promise<AiRequestRecord>;
  cancelAi(requestId: string): Promise<void>;
  onAiEvent(callback: (event: AiEvent) => void): () => void;
  takeAiHelp(attemptId: string): Promise<AiHelpDecision>;
  dismissAiHelp(attemptId: string): Promise<void>;
  previewAiPatch(requestId: string): Promise<AiPatchApplication>;
  applyAiPatch(requestId: string): Promise<Draft>;
  openWebLink(url: string): Promise<void>;
  /** One anonymous request to the project's public releases; nothing is downloaded or installed. */
  checkForUpdate(): Promise<UpdateCheck>;
  updateState(): Promise<AppUpdateState>;
  checkForAppUpdate(): Promise<AppUpdateState>;
  downloadAppUpdate(): Promise<AppUpdateState>;
  installAppUpdate(): Promise<void>;
  setAutomaticUpdates(enabled: boolean): Promise<AppUpdateState>;
  onAppUpdate(callback: (state: AppUpdateState) => void): () => void;
  copyCode(code: string): Promise<void>;
  exportAttachment(hash: string): Promise<boolean>;
  onMaintenance(callback: (requestId: string) => void): () => void;
  maintenanceReady(requestId: string, error?: string): void;
  onMaintenanceEnd(callback: () => void): () => void;
  activityPulse(attemptId: string): Promise<void>;
  pauseActivity(): Promise<void>;
  environment(): Promise<EnvironmentInfo>;
  libraryIndex(): Promise<LibraryIndex>;
  problemPage(filter?: ProblemPageFilter): Promise<PageResult<ProblemListItem>>;
  notePage(filter?: NotePageFilter): Promise<PageResult<NoteListItem>>;
  attemptPage(filter?: AttemptPageFilter): Promise<PageResult<AttemptListItem>>;
  /** Effective practice time of one attempt in milliseconds. */
  attemptActiveTime(attemptId: string): Promise<number>;
  runPage(filter?: RunPageFilter): Promise<PageResult<RunListItem>>;
  runDetail(id: string): Promise<RunArchive>;
  archiveOverview(id: string): Promise<{ attempt: Attempt; runCount: number; activeMs: number; interviewId: string | null }>;
  archiveLearning(id: string): Promise<{ aiRequests: AiRequestRecord[]; noteVersions: NoteVersion[] }>;
  library(): Promise<LibraryData>;
  workspace(problemId: string, language: Language, scopeId?: string, answerFormat?: AnswerFormat): Promise<WorkspaceData>;
  startPractice(problemId: string, language: Language, scopeId?: string, answerFormat?: AnswerFormat): Promise<WorkspaceData>;
  finishPractice(attemptId: string, code: string): Promise<FinishedAttempt>;
  deleteArchive(id: string): Promise<boolean>;
  archive(id: string): Promise<ArchiveDetail>;
  restoreRun(runId: string, requestId: string): Promise<{ draft: Draft; attempt: Attempt }>;
  loadDraft(problemId: string, language: Language, scopeId?: string, answerFormat?: AnswerFormat): Promise<Draft | null>;
  saveDraft(problemId: string, language: Language, code: string, scopeId?: string, options?: DraftOptions): Promise<{ revision: number }>;
  run(problemId: string, language: Language, code: string, scopeId?: string, requestId?: string, problemVersion?: string, options?: RunOptions): Promise<RunArchive>;
  /** Runs the code on one self-written input and returns the outcome without recording a run, an attempt or any statistic. */
  selfTest(problemId: string, language: Language, code: string, scopeId: string | undefined, problemVersion: string | undefined, options: SelfTestOptions): Promise<import('../runner/types').RunResult>;
  prepareRun(problemId: string, language: Language, code: string, scopeId?: string, problemVersion?: string, answerFormat?: 'function' | 'acm'): Promise<RunPreparation>;
  cancelPreparedRun(token: string): Promise<void>;
  cancel(): Promise<void>;
  onRunEvent(callback: (event: RunEvent) => void): () => void;
  history(problemId: string, language: Language, scopeId?: string): Promise<RunArchive[]>;
  previewImport(input: ImportInput): Promise<PreparedImport>;
  importHot100(): Promise<Hot100ImportResult>;
  selectImportFile(): Promise<ImportInput | null>;
  startImport(previewId: string, requestId: string): Promise<ImportJob>;
  importJob(id: string): Promise<ImportJob>;
  resumeImport(id: string, retryFailed?: boolean): Promise<ImportJob>;
  pauseImport(id: string): Promise<void>;
  onLibraryChanged(callback: () => void): () => void;
  previewProblemRefresh(problemId: string): Promise<PreparedProblemRefresh>;
  applyProblemRefresh(previewId: string): Promise<LibraryProblem>;
  detachListItem(listId: string, key: string, expectedRevision: number): Promise<StudyList>;
  sourceSession(): Promise<{ hasSession: boolean }>;
  loginSource(): Promise<void>;
  logoutSource(): Promise<void>;
  setRuntime(language: Language): Promise<boolean | void>;
  resetRuntime(language: Language): Promise<void>;
  runtimePreflight(language: Language): Promise<RuntimeState>;
  setAutoInstallRuntimes(enabled: boolean): Promise<void>;
  uninstallRuntime(language: Language): Promise<void>;
  installRuntime(language: Language, offline?: boolean): Promise<boolean | void>;
  cancelInstall(language?: Language): Promise<void>;
  onRuntimeProgress(callback: (progress: RuntimeProgress) => void): () => void;
  notifyAfter(seconds: number): Promise<void>;
  clearReminder(): Promise<void>;
  openSource(url: string): Promise<void>;
  onNavigate(callback: (page: Page) => void): () => void;
  onClosing(callback: () => void): () => void;
  closeReady(): void;
}
declare global { interface Window { algo?: DesktopBridge; } }
