import type { OfficialSubmitInput, OfficialSubmission } from './official';
import type { SaveSubmissionRemarkInput, SubmissionHistoryDetail, SubmissionHistoryFilter, SubmissionHistoryItem, SubmissionHistorySource, SubmissionRemark } from './submission-history';
import type { CompanyDataset, CompanyPreview, InterviewRules, InterviewPool, InterviewView, InterviewSaveResult } from './interview';
import type { Language, RunEvent, RunResult, RunStatus } from '../runner/types';
import type { Attempt, Draft } from '../storage/practice-store';
import type { ImportJob, LibraryProblem, StudyList, ListRefreshPreview } from './library';
import type { ImportInput, ImportPreview } from '../source/index';
import type { AiProviderConfig, AiProviderState, AiConnectionResult, AiRequestInput, AiRequestRecord, AiEvent, AiHelpDecision, AiPatchApplication } from './ai';
import type { ReminderSettings, ReminderStatus, BackupSummary, BackupManifest, RestoreResult } from './maintenance';
import type { Note, NoteVersion, SaveNoteInput, ConfirmNoteInput, NoteFilter, Attachment, ReviewItem, ReviewEvent, AddReviewItemInput, ReviewFeedbackInput, ReviewFeedbackResult, CorrectReviewInput, ReviewFilter, LearningSettings, LearningSettingsInput, LearningDashboard, TodayQueue, ArchiveStatistics } from './learning';
import type { PageResult, ProblemPageFilter, ProblemListItem, NotePageFilter, NoteListItem, AttemptPageFilter, AttemptListItem, RunPageFilter, RunListItem } from './learning';
export type Page = 'today' | 'library' | 'workbench' | 'sources' | 'notes' | 'archives' | 'learning-settings' | 'environment' | 'interview';
export interface RunArchive {
  id: string; attemptId: string; problemId: string; problemVersion: string; code: string; language: Language; createdAt: string;
  result: Omit<RunResult, 'status'> & { status: RunStatus | 'interrupted' };
}
export interface RuntimeProgress { language: Language; phase: 'download' | 'copy' | 'verify' | 'extract' | 'validate' | 'commit' | 'ready'; receivedBytes: number; totalBytes: number; }
export interface EnvironmentInfo {
  platform: string; arch: string; electron: string; node: string; sqlite: string;
  python: string | null; java: string | null; dataDirectory: string;
  runtimeNotices: string[];
  installation: { language: Language; progress: RuntimeProgress | null } | null;
  notificationSupported: boolean; reminder: { dueAt: string; deliveredAt?: string } | null;
}
export interface LibraryData { problems: LibraryProblem[]; lists: StudyList[]; jobs: ImportJob[]; }
export interface LibraryIndex { problems: ProblemListItem[]; totalProblems: number; lists: StudyList[]; jobs: ImportJob[]; }
export interface WorkspaceData { problem: LibraryProblem; latestVersion: string; draft: Draft | null; attempt: Attempt | null; history: RunArchive[]; historyTotal?: number; }
export interface ArchiveSummary { attempt: Attempt; title: string; runCount: number; lastStatus: RunArchive['result']['status'] | null; activeMs?: number; helpLevel?: string | null; }
export interface ArchiveDetail { attempt: Attempt; runs: RunArchive[]; aiRequests?: AiRequestRecord[]; noteVersions?: NoteVersion[]; activeMs?: number; }
export interface PreparedImport { id: string; preview: ImportPreview; membership: ListRefreshPreview | null; }
export interface PreparedProblemRefresh { id: string; before: LibraryProblem; after: LibraryProblem['content']; changed: boolean; }
export interface BackupState { busy: boolean; backups: BackupSummary[]; lastError: string | null; }
export interface PreparedRestore { id: string; manifest: BackupManifest; bytes: number; }
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
  reviewInterview(id: string, problemId: string): Promise<ReviewItem>;
  previewCompany(input: { kind: 'csv' | 'json'; text: string; name: string }): Promise<{ id: string; preview: CompanyPreview }>;
  commitCompany(id: string): Promise<CompanyDataset>;
  completeCompanyProblems(id: string, requestId: string): Promise<ImportJob>;
  selectCompanyFile(): Promise<{ kind: 'csv' | 'json'; text: string; name: string } | null>;

  learningSettings(): Promise<LearningSettings>;
  saveLearningSettings(input: LearningSettingsInput): Promise<LearningSettings>;
  learningDashboard(month?: string): Promise<LearningDashboard>;
  todayQueue(): Promise<TodayQueue>;
  reviewItems(filter?: ReviewFilter): Promise<ReviewItem[]>;
  addReviewItem(input: AddReviewItemInput): Promise<ReviewItem>;
  updateReviewItem(id: string, input: { suspended?: boolean; scheduledAt?: string | null }): Promise<ReviewItem>;
  reviewEvents(itemId: string): Promise<ReviewEvent[]>;
  reviewFeedback(input: ReviewFeedbackInput): Promise<ReviewFeedbackResult>;
  correctReview(input: CorrectReviewInput): Promise<ReviewFeedbackResult>;
  learningStatistics(): Promise<ArchiveStatistics>;
  notes(filter?: NoteFilter): Promise<Note[]>;
  note(id: string): Promise<Note | null>;
  saveNote(input: SaveNoteInput): Promise<Note>;
  confirmNote(input: ConfirmNoteInput): Promise<Note>;
  deleteNote(id: string, expectedVersion: number): Promise<void>;
  noteVersions(id: string): Promise<NoteVersion[]>;
  exportNote(id: string, version: number): Promise<boolean>;
  addAttachment(): Promise<Attachment | null>;
  attachment(hash: string): Promise<Attachment | null>;
  saveAiNoteDraft(requestId: string): Promise<Note>;
  reminderState(): Promise<ReminderStatus>;
  saveReminderSettings(settings: ReminderSettings): Promise<ReminderStatus>;
  snoozeReviews(): Promise<ReminderStatus>;
  backups(): Promise<BackupState>;
  createBackup(): Promise<BackupSummary | null>;
  previewRestore(): Promise<PreparedRestore | null>;
  restoreBackup(previewId: string): Promise<RestoreResult>;
  aiProvider(): Promise<AiProviderState>;
  saveAiProvider(config: AiProviderConfig, key?: string): Promise<AiProviderState>;
  clearAiKey(): Promise<AiProviderState>;
  testAiProvider(): Promise<AiConnectionResult>;
  aiRequests(attemptId: string): Promise<AiRequestRecord[]>;
  askAi(input: AiRequestInput): Promise<AiRequestRecord>;
  cancelAi(requestId: string): Promise<void>;
  onAiEvent(callback: (event: AiEvent) => void): () => void;
  takeAiHelp(attemptId: string): Promise<AiHelpDecision>;
  dismissAiHelp(attemptId: string): Promise<void>;
  previewAiPatch(requestId: string): Promise<AiPatchApplication>;
  applyAiPatch(requestId: string): Promise<Draft>;
  openWebLink(url: string): Promise<void>;
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
  runPage(filter?: RunPageFilter): Promise<PageResult<RunListItem>>;
  runDetail(id: string): Promise<RunArchive>;
  archiveOverview(id: string): Promise<{ attempt: Attempt; runCount: number; activeMs: number; interviewId: string | null }>;
  archiveLearning(id: string): Promise<{ aiRequests: AiRequestRecord[]; noteVersions: NoteVersion[] }>;
  library(): Promise<LibraryData>;
  workspace(problemId: string, language: Language, scopeId?: string): Promise<WorkspaceData>;
  startPractice(problemId: string, language: Language, scopeId?: string): Promise<WorkspaceData>;
  finishPractice(attemptId: string, code: string): Promise<Attempt>;
  archives(): Promise<ArchiveSummary[]>;
  deleteArchive(id: string): Promise<boolean>;
  archive(id: string): Promise<ArchiveDetail>;
  restoreRun(runId: string, requestId: string): Promise<{ draft: Draft; attempt: Attempt }>;
  loadDraft(problemId: string, language: Language, scopeId?: string): Promise<Draft | null>;
  saveDraft(problemId: string, language: Language, code: string, scopeId?: string): Promise<{ revision: number }>;
  run(problemId: string, language: Language, code: string, scopeId?: string, requestId?: string, problemVersion?: string): Promise<RunArchive>;
  cancel(): Promise<void>;
  onRunEvent(callback: (event: RunEvent) => void): () => void;
  history(problemId: string, language: Language, scopeId?: string): Promise<RunArchive[]>;
  previewImport(input: ImportInput): Promise<PreparedImport>;
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
  setRuntime(language: Language): Promise<void>;
  installRuntime(language: Language, offline?: boolean): Promise<void>;
  cancelInstall(): Promise<void>;
  onRuntimeProgress(callback: (progress: RuntimeProgress) => void): () => void;
  notifyAfter(seconds: number): Promise<void>;
  clearReminder(): Promise<void>;
  probeSource(url: string): Promise<unknown>;
  openSource(url: string): Promise<void>;
  onNavigate(callback: (page: Page) => void): () => void;
  onClosing(callback: () => void): () => void;
  closeReady(): void;
}
declare global { interface Window { algo?: DesktopBridge; } }
