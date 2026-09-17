import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { LearningRepository, backfillNoteAttachmentReferences, defaultLearningSettings } from '../learning/repository.ts';
import { archiveDateBoundary } from '../shared/archive-date.ts';
import { pageBounds, pageResult, searchText, literalLike, SQL_TRIM_WHITESPACE } from './pagination.ts';
import type { AttemptListItem, AttemptPageFilter, NotePageFilter, PageResult, ProblemListItem, ProblemPageFilter, RunListItem, RunPageFilter } from '../shared/learning.ts';
import { MIGRATE_V5 } from '../interview/schema.ts';
import { MIGRATE_V7 } from './submission-history-schema.ts';
import { SUBMISSION_REMARK_LIMIT, type SaveSubmissionRemarkInput, type SubmissionHistoryDetail, type SubmissionHistoryFilter,
  type SubmissionHistoryItem, type SubmissionHistorySource, type SubmissionRemark } from '../shared/submission-history.ts';
import type { CompanyDataset, InterviewSession } from '../shared/interview.ts';
import { MIGRATE_V3, MIGRATE_V4 } from '../learning/schema.ts';
import type { ActivitySampleInput, AddReviewItemInput, Attachment, BackupSnapshotInfo, ConfirmNoteInput,
  CorrectReviewInput, LearningSettingsInput, NoteFilter, ReviewFeedbackInput, ReviewFilter, SaveNoteInput } from '../shared/learning.ts';
import type { AiLevel, AiRequestCompletion, AiRequestSeed } from '../shared/ai.ts';
import type { BeginOfficialSubmissionInput, OfficialSubmission, OfficialSubmissionUpdate } from '../shared/official.ts';
import { officialProblemSlug, officialSubmissionUrl } from '../source/official-judge.ts';
import type {
  CreateImportJobInput, ImportError, ImportItem, ImportItemSeed, ImportItemStatus,
  ImportItemUpdate, ImportJob, ImportJobStatus, ImportJobUpdate, LibraryProblem,
  ListChapter, ListRefreshPreview, ListSnapshotInput, ProblemContent, ProblemSource,
  StudyList, StudyListItem,
} from '../shared/library';

export type Language = 'python' | 'java';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const TERMINAL_STATUSES = [
  'passed', 'completed', 'wrong_answer', 'compile_error', 'runtime_error',
  'timeout', 'cancelled', 'output_limit', 'environment_error', 'invalid_request',
  'internal_error', 'interrupted',
] as const;
export type TerminalStatus = typeof TERMINAL_STATUSES[number];
export type RunStatus = 'queued' | TerminalStatus;

export interface Draft {
  problemId: string;
  language: Language;
  scopeId: string;
  code: string;
  codeHash: string;
  revision: number;
  savedAt: string;
}

export interface SaveDraftInput {
  problemId: string;
  language: Language;
  code: string;
  scopeId?: string;
  expectedRevision?: number;
}

export interface StartAttemptInput {
  id?: string;
  problemId: string;
  language: Language;
  problemVersion: string;
  problemSnapshot?: JsonValue;
  mode?: 'practice' | 'strict' | 'coached';
  draftScopeId?: string;
  restoredFromRunId?: string;
}

export interface Attempt {
  id: string;
  problemId: string;
  language: Language;
  problemVersion: string;
  problemSnapshot: JsonValue;
  mode: 'practice' | 'strict' | 'coached';
  startedAt: string;
  draftScopeId: string;
  endedAt: string | null;
  finalCode: string | null;
  finalCodeHash: string | null;
  finalDraftRevision: number | null;
  lastRunId: string | null;
  lastRunMatchesFinal: boolean;
  restoredFromRunId: string | null;
  isActive: boolean;
}

export interface FinishAttemptInput {
  code?: string;
  scopeId?: string;
  expectedDraftRevision?: number;
}

export interface BeginRunInput extends SaveRunInput {
  scopeId?: string;
  expectedDraftRevision?: number;
}

export interface SaveRunInput {
  id?: string;
  attemptId: string;
  code: string;
  testSuiteVersion: string;
  testSnapshot?: JsonValue;
  adapterVersion: string;
  runtimeVersion: string;
  status?: RunStatus;
  result?: JsonValue;
}

export interface StoredRun {
  id: string;
  attemptId: string;
  problemId: string;
  language: Language;
  problemVersion: string;
  code: string;
  codeHash: string;
  testSuiteVersion: string;
  testSnapshot: JsonValue;
  adapterVersion: string;
  runtimeVersion: string;
  status: RunStatus;
  result: JsonValue;
  createdAt: string;
  finishedAt: string | null;
}

type Row = Record<string, string | number | null>;
const SCHEMA_VERSION = 7;
const MIGRATE_V6 = `
CREATE TABLE official_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK(draft_revision > 0),
  slug TEXT NOT NULL,
  source_id TEXT NOT NULL,
  submission_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('submitting','judging','paused','completed','unknown','error')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  error_json TEXT NOT NULL CHECK(json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK((status IN ('submitting','judging','paused') AND finished_at IS NULL)
    OR (status IN ('completed','unknown','error') AND finished_at IS NOT NULL)),
  CHECK((status = 'completed' AND result_json <> 'null') OR (status <> 'completed' AND result_json = 'null')),
  CHECK(status NOT IN ('judging','paused','completed') OR submission_id IS NOT NULL)
) STRICT;
CREATE INDEX official_by_attempt ON official_submissions(attempt_id, created_at);
CREATE UNIQUE INDEX official_active_attempt ON official_submissions(attempt_id) WHERE status IN ('submitting','judging');
CREATE TRIGGER immutable_official_snapshot BEFORE UPDATE OF
  id, attempt_id, code, code_hash, draft_revision, slug, source_id, created_at ON official_submissions
BEGIN SELECT RAISE(ABORT, 'official submission snapshot is immutable'); END;
CREATE TRIGGER immutable_official_id BEFORE UPDATE OF submission_id ON official_submissions
WHEN OLD.submission_id IS NOT NULL AND OLD.submission_id IS NOT NEW.submission_id
BEGIN SELECT RAISE(ABORT, 'official submission id is immutable'); END;
CREATE TRIGGER immutable_official_result BEFORE UPDATE ON official_submissions
WHEN OLD.status IN ('completed','unknown','error')
BEGIN SELECT RAISE(ABORT, 'official terminal result is immutable'); END;
ALTER TABLE ai_help_used RENAME TO ai_help_used_v5;
CREATE TABLE ai_help_used (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES ai_requests(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  level TEXT NOT NULL CHECK(level IN ('L0','L1','L2','L3','L4','adaptive')),
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO ai_help_used SELECT * FROM ai_help_used_v5;
DROP TABLE ai_help_used_v5;
`;
const terminalSQL = TERMINAL_STATUSES.map((status) => `'${status}'`).join(',');
const RUN_SNAPSHOT_TRIGGERS = `
CREATE TRIGGER immutable_run_snapshot BEFORE UPDATE OF
  id, attempt_id, code, code_hash, test_suite_version, test_snapshot_json,
  adapter_version, created_at ON runs
BEGIN SELECT RAISE(ABORT, 'run snapshot is immutable'); END;
CREATE TRIGGER immutable_run_runtime BEFORE UPDATE OF runtime_version ON runs
WHEN OLD.status <> 'queued' OR NEW.status = 'queued' OR length(trim(NEW.runtime_version)) = 0
BEGIN SELECT RAISE(ABORT, 'run runtime may only be finalized with its terminal result'); END;
`;
const SCHEMA = `
CREATE TABLE problems (id TEXT PRIMARY KEY NOT NULL) STRICT;
CREATE TABLE problem_versions (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  version TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(problem_id, version)
) STRICT;
CREATE TABLE drafts (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  language TEXT NOT NULL CHECK(language IN ('python', 'java')),
  scope_id TEXT NOT NULL,
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  saved_at TEXT NOT NULL,
  PRIMARY KEY(problem_id, language, scope_id)
) STRICT;
CREATE TABLE attempts (
  id TEXT PRIMARY KEY NOT NULL,
  problem_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('python', 'java')),
  problem_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('practice', 'strict', 'coached')),
  started_at TEXT NOT NULL,
  FOREIGN KEY(problem_id, problem_version) REFERENCES problem_versions(problem_id, version)
) STRICT;
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  test_suite_version TEXT NOT NULL,
  test_snapshot_json TEXT NOT NULL CHECK(json_valid(test_snapshot_json)),
  adapter_version TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', ${terminalSQL})),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK((status = 'queued' AND finished_at IS NULL AND result_json = 'null')
    OR (status <> 'queued' AND finished_at IS NOT NULL))
) STRICT;
CREATE INDEX runs_by_attempt ON runs(attempt_id, created_at);
CREATE TRIGGER immutable_problem_version BEFORE UPDATE ON problem_versions
BEGIN SELECT RAISE(ABORT, 'problem version is immutable'); END;
CREATE TRIGGER immutable_attempt BEFORE UPDATE ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;
${RUN_SNAPSHOT_TRIGGERS}
CREATE TRIGGER immutable_run_result BEFORE UPDATE ON runs WHEN OLD.status <> 'queued'
BEGIN SELECT RAISE(ABORT, 'run terminal result is immutable'); END;
`;

const IMPORT_ITEM_STATUSES: ImportItemStatus[] = ['pending', 'running', 'imported', 'reused', 'link_only', 'restricted', 'failed', 'skipped'];
const IMPORT_JOB_STATUSES: ImportJobStatus[] = ['pending', 'running', 'paused', 'cancelled', 'completed', 'completed_with_errors'];
const COMPLETE_ITEM_STATUSES = new Set<ImportItemStatus>(['imported', 'reused', 'link_only', 'skipped']);
const MIGRATE_V2 = `
ALTER TABLE attempts ADD COLUMN draft_scope_id TEXT NOT NULL DEFAULT 'practice';
ALTER TABLE attempts ADD COLUMN ended_at TEXT;
ALTER TABLE attempts ADD COLUMN final_code TEXT;
ALTER TABLE attempts ADD COLUMN final_code_hash TEXT;
ALTER TABLE attempts ADD COLUMN final_draft_revision INTEGER;
ALTER TABLE attempts ADD COLUMN final_last_run_id TEXT REFERENCES runs(id);
ALTER TABLE attempts ADD COLUMN last_run_matches_final INTEGER NOT NULL DEFAULT 0 CHECK(last_run_matches_final IN (0, 1));
ALTER TABLE attempts ADD COLUMN restored_from_run_id TEXT REFERENCES runs(id);
DROP TRIGGER immutable_attempt;
CREATE TRIGGER immutable_attempt BEFORE UPDATE OF
  id, problem_id, language, problem_version, mode, started_at, draft_scope_id, restored_from_run_id ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;
CREATE TRIGGER immutable_finished_attempt BEFORE UPDATE ON attempts WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'finished attempt is immutable'); END;
CREATE TRIGGER coherent_attempt_final BEFORE UPDATE ON attempts WHEN NEW.ended_at IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.final_code IS NULL OR NEW.final_code_hash IS NULL OR NEW.final_draft_revision IS NULL
    THEN RAISE(ABORT, 'finished attempt requires a final draft snapshot') END;
  SELECT CASE WHEN NEW.final_last_run_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM runs WHERE id = NEW.final_last_run_id AND attempt_id = NEW.id)
    THEN RAISE(ABORT, 'final run must belong to the attempt') END;
END;
CREATE UNIQUE INDEX attempt_scope_identity ON attempts(id, problem_id, language, mode, draft_scope_id);
CREATE TABLE active_attempts (
  problem_id TEXT NOT NULL,
  language TEXT NOT NULL,
  mode TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(problem_id, language, mode, scope_id),
  FOREIGN KEY(attempt_id, problem_id, language, mode, scope_id)
    REFERENCES attempts(id, problem_id, language, mode, draft_scope_id)
) STRICT;
INSERT INTO active_attempts SELECT problem_id, language, mode, draft_scope_id, id FROM attempts a
WHERE NOT EXISTS(SELECT 1 FROM attempts newer WHERE newer.problem_id = a.problem_id
  AND newer.language = a.language AND newer.mode = a.mode AND newer.rowid > a.rowid);
CREATE TABLE library_problem_heads (
  problem_id TEXT PRIMARY KEY NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(problem_id, version) REFERENCES problem_versions(problem_id, version)
) STRICT;
CREATE TABLE study_lists (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('local', 'leetcode-cn', 'file')),
  source_url TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE list_chapters (
  list_id TEXT NOT NULL REFERENCES study_lists(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  parent_id TEXT,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(list_id, id),
  FOREIGN KEY(list_id, parent_id) REFERENCES list_chapters(list_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE list_items (
  list_id TEXT NOT NULL REFERENCES study_lists(id),
  item_key TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  chapter_id TEXT,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(list_id, item_key),
  FOREIGN KEY(list_id, chapter_id) REFERENCES list_chapters(list_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX list_items_by_problem ON list_items(problem_id);
CREATE TABLE list_refresh_previews (
  id TEXT PRIMARY KEY NOT NULL,
  list_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
  created_at TEXT NOT NULL,
  applied_at TEXT
) STRICT;
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (${IMPORT_JOB_STATUSES.map((status) => `'${status}'`).join(',')})),
  error_json TEXT NOT NULL CHECK(json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE import_items (
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  item_key TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  seed_json TEXT NOT NULL CHECK(json_valid(seed_json)),
  version TEXT,
  status TEXT NOT NULL CHECK(status IN (${IMPORT_ITEM_STATUSES.map((status) => `'${status}'`).join(',')})),
  error_json TEXT NOT NULL CHECK(json_valid(error_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(job_id, item_key),
  FOREIGN KEY(problem_id, version) REFERENCES problem_versions(problem_id, version)
) STRICT;
CREATE TABLE draft_restorations (
  request_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
`;

function requireText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be non-empty`);
}

function requireLanguage(language: Language): void {
  if (language !== 'python' && language !== 'java') throw new Error('Unsupported language');
}

function requireSource(source: ProblemSource): void {
  if (!['local', 'leetcode-cn', 'file'].includes(source)) throw new Error('Unsupported problem source');
}

function position(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Position must be a non-negative integer');
}

function normalizeProblem(input: ProblemContent): ProblemContent {
  const content = JSON.parse(json(input)) as ProblemContent;
  requireText(content.id, 'problem id'); requireText(content.title, 'problem title'); requireSource(content.source);
  if (typeof content.difficulty !== 'string' || typeof content.description !== 'string'
    || !['plain', 'html'].includes(content.descriptionFormat) || !['function', 'acm'].includes(content.mode)) {
    throw new Error('Invalid problem content');
  }
  if (content.acmCompare !== undefined && !['normalized', 'exact'].includes(content.acmCompare)) throw new Error('Invalid ACM comparator');
  for (const field of ['tags', 'constraints'] as const) {
    if (!Array.isArray(content[field]) || content[field].some((value) => typeof value !== 'string')) throw new Error(`Invalid ${field}`);
  }
  if (!Array.isArray(content.cases) || !content.starter || typeof content.starter !== 'object' || Array.isArray(content.starter)) {
    throw new Error('Problem cases and starter templates are required');
  }
  for (const [language, code] of Object.entries(content.starter)) {
    requireLanguage(language as Language);
    if (typeof code !== 'string') throw new Error('Starter code must be text');
  }
  if (content.media && (typeof content.media.complete !== 'boolean' || !Array.isArray(content.media.missingUrls)
    || content.media.missingUrls.some((url) => typeof url !== 'string'))) throw new Error('Invalid media cache status');
  return content;
}

function placeholderProblem(id: string, title: string, source: ProblemSource, sourceUrl?: string): ProblemContent {
  return { id, title: title || id, source, ...(sourceUrl ? { sourceUrl } : {}), difficulty: '未知', tags: [],
    description: '', descriptionFormat: 'plain', constraints: [], mode: 'function', cases: [], starter: {},
    supportReason: '仅保存题目引用；题面、模板或测试尚未获取。' };
}

function normalizeList(input: ListSnapshotInput): ListSnapshotInput {
  const value = JSON.parse(json(input)) as ListSnapshotInput;
  requireText(value.id, 'list id'); requireText(value.title, 'list title'); requireSource(value.source);
  if (typeof value.membershipComplete !== 'boolean' || !Array.isArray(value.chapters) || !Array.isArray(value.items)) {
    throw new Error('List chapters, items and membership completeness are required');
  }
  const chapters = new Map<string, ListChapter>();
  for (const chapter of value.chapters) {
    requireText(chapter.id, 'chapter id'); requireText(chapter.title, 'chapter title'); position(chapter.position);
    if (chapters.has(chapter.id)) throw new Error('Duplicate chapter id');
    chapters.set(chapter.id, chapter);
  }
  for (const chapter of value.chapters) {
    const visited = new Set([chapter.id]);
    let parent = chapter.parentId;
    while (parent !== undefined) {
      if (!chapters.has(parent)) throw new Error('Missing parent chapter');
      if (visited.has(parent)) throw new Error('Chapter hierarchy contains a cycle');
      visited.add(parent); parent = chapters.get(parent)!.parentId;
    }
  }
  const items = new Map<string, StudyListItem>();
  for (const item of value.items) {
    requireText(item.key, 'list item key'); requireText(item.problemId, 'problem id'); position(item.position);
    if (item.chapterId !== undefined && !chapters.has(item.chapterId)) throw new Error('Missing item chapter');
    const existing = items.get(item.key);
    if (existing && json(existing) !== json(item)) throw new Error('List item key identifies conflicting entries');
    items.set(item.key, item);
  }
  value.items = [...items.values()];
  return value;
}

function normalizeError(error: ImportError | null | undefined): ImportError | null {
  if (error == null) return null;
  requireText(error.code, 'error code'); requireText(error.message, 'error message');
  if (typeof error.retryable !== 'boolean') throw new Error('Error retryable flag is required');
  return { code: error.code, message: error.message, retryable: error.retryable };
}

function json(value: unknown): string {
  // Sorting object keys makes request retries independent of property insertion order.
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('JSON numbers must be finite');
    if (typeof item === 'function' || typeof item === 'symbol') {
      throw new Error('Value is not serializable JSON');
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    }
    return item;
  });
  if (serialized === undefined) throw new Error('Value is not serializable JSON');
  return serialized;
}

export function hashCode(code: string): string {
  if (typeof code !== 'string') throw new Error('code must be a string');
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function checkDatabase(db: DatabaseSync, allowedVersions = [SCHEMA_VERSION]): void {
  const version = db.prepare('PRAGMA user_version').get() as Row;
  if (!allowedVersions.includes(version.user_version as number)) throw new Error('Unsupported backup schema version');
  const integrity = db.prepare('PRAGMA integrity_check').all() as Row[];
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
  if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('SQLite foreign key check failed');
}

function historySource(value: unknown): SubmissionHistorySource {
  if (value !== 'local' && value !== 'official') throw new Error('历史记录来源无效。');
  return value;
}

function historyItem(row: Row): SubmissionHistoryItem {
  return { id: row.id as string, source: row.source as SubmissionHistorySource, attemptId: row.attempt_id as string,
    problemId: row.problem_id as string, problemVersion: row.problem_version as string, language: row.language as Language,
    createdAt: row.created_at as string, finishedAt: row.finished_at as string | null, codeHash: row.code_hash as string,
    status: row.status as SubmissionHistoryItem['status'], verdict: row.verdict as SubmissionHistoryItem['verdict'],
    remark: (row.remark as string | null) ?? '', remarkRevision: (row.remark_revision as number | null) ?? 0 };
}

/** Local P3 repository. Construct after acquiring the application's single-instance lock. */
export class PracticeStore {
  readonly dbPath: string;
  readonly migrationBackupPath: string | null = null;
  #db: DatabaseSync;
  #learning!: LearningRepository;
  #closed = false;
  #backupsInFlight = 0;
  #inTransaction = false;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.#db = new DatabaseSync(this.dbPath);
    try {
      const version = (this.#db.prepare('PRAGMA user_version').get() as Row).user_version;
      if (![0, 1, 2, 3, 4, 5, 6, SCHEMA_VERSION].includes(version as number)) throw new Error(`Unsupported schema version: ${version}`);
      this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
      if (version === 0) this.#transaction(() => {
        this.#db.exec(SCHEMA);
        this.#db.exec(MIGRATE_V2);
        this.#db.exec(MIGRATE_V3);
        this.#db.exec(MIGRATE_V4);
        this.#db.exec(MIGRATE_V5);
        this.#db.exec(MIGRATE_V6);
        this.#db.exec(MIGRATE_V7);
        this.#db.prepare('INSERT INTO learning_settings VALUES (1, ?)').run(json({ ...defaultLearningSettings(), updatedAt: new Date().toISOString() }));
        this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      if (version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6) {
        checkDatabase(this.#db, [version]);
        const backupPath = `${this.dbPath}.before-v7-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`;
        const temporary = `${backupPath}.partial`;
        try {
          // VACUUM INTO is a synchronous, transactionally consistent snapshot including committed WAL pages.
          // It preserves the synchronous P1 constructor; application single-instance ownership excludes concurrent writers.
          this.#db.prepare('VACUUM INTO ?').run(temporary);
          const verification = new DatabaseSync(temporary, { readOnly: true });
          try { checkDatabase(verification, [version]); } finally { verification.close(); }
          linkSync(temporary, backupPath);
          this.migrationBackupPath = backupPath;
        } finally { if (existsSync(temporary)) unlinkSync(temporary); }
        try {
          this.#transaction(() => {
            if (version === 1) this.#db.exec(MIGRATE_V2);
            if (version < 3) {
              this.#db.exec(MIGRATE_V3);
              this.#db.prepare('INSERT INTO learning_settings VALUES (1, ?)').run(json({ ...defaultLearningSettings(), updatedAt: new Date().toISOString() }));
            }
            if (version < 4) this.#db.exec(MIGRATE_V4);
            if (version < 5) this.#db.exec(MIGRATE_V5);
            if (version < 6) this.#db.exec(MIGRATE_V6);
            this.#db.exec(MIGRATE_V7);
            backfillNoteAttachmentReferences(this.#db);
            this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
            checkDatabase(this.#db);
          });
        } catch (error) {
          throw new Error(`Schema v7 migration failed; original schema retained. Backup: ${backupPath}`, { cause: error });
        }
      }
      // Existing schema 2 databases need only a trigger update; table layouts and stored snapshots stay intact.
      if (!this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'immutable_run_runtime'").get()) {
        this.#transaction(() => {
          this.#db.exec('DROP TRIGGER immutable_run_snapshot');
          this.#db.exec(RUN_SNAPSHOT_TRIGGERS);
        });
      }
      this.#learning = new LearningRepository(this.#db, operation => this.#transaction(operation), attemptId => this.getInterviewForAttempt(attemptId)?.mode);
      if (version === SCHEMA_VERSION) this.#transaction(() => backfillNoteAttachmentReferences(this.#db));
      if (!this.#db.prepare('SELECT 1 FROM learning_settings WHERE id = 1').get()) this.#learning.updateLearningSettings({});
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
    }
  }

  #transaction<T>(operation: () => T): T {
    if (this.#inTransaction) return operation();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#inTransaction = true;
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      // SQLITE_FULL and some I/O failures already roll the transaction back. Preserve the original error.
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    } finally { this.#inTransaction = false; }
  }

  upsertProblem(input: ProblemContent): LibraryProblem {
    const content = normalizeProblem(input);
    const snapshot = json(content);
    const version = `sha256:${hashCode(snapshot)}`;
    return this.#transaction(() => {
      const existing = this.getProblem(content.id);
      if (existing?.version === version) return existing;
      const now = new Date().toISOString();
      this.#db.prepare('INSERT OR IGNORE INTO problems(id) VALUES (?)').run(content.id);
      this.#db.prepare('INSERT OR IGNORE INTO problem_versions VALUES (?, ?, ?)').run(content.id, version, snapshot);
      const saved = this.#db.prepare('SELECT snapshot_json FROM problem_versions WHERE problem_id = ? AND version = ?')
        .get(content.id, version) as Row;
      if (saved.snapshot_json !== snapshot) throw new Error('Problem content hash conflicts with an immutable version');
      this.#db.prepare(`INSERT INTO library_problem_heads VALUES (?, ?, ?, ?)
        ON CONFLICT(problem_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`)
        .run(content.id, version, now, now);
      return this.getProblem(content.id)!;
    });
  }

  getProblem(id: string, version?: string): LibraryProblem | undefined {
    const head = this.#db.prepare('SELECT * FROM library_problem_heads WHERE problem_id = ?').get(id) as Row | undefined;
    const selectedVersion = version ?? head?.version;
    if (!selectedVersion) return undefined;
    const snapshot = this.#db.prepare('SELECT snapshot_json FROM problem_versions WHERE problem_id = ? AND version = ?')
      .get(id, selectedVersion) as Row | undefined;
    if (!snapshot) return undefined;
    const original = JSON.parse(snapshot.snapshot_json as string);
    let content: ProblemContent;
    if (original && original.descriptionFormat && original.source) content = normalizeProblem(original);
    else {
      // Old P1 snapshots are retained byte-for-byte. Only this read view adapts their known demo fields.
      const legacy = original && typeof original === 'object' ? original : {};
      content = { ...placeholderProblem(id, typeof legacy.title === 'string' ? legacy.title : id, 'local'),
        difficulty: typeof legacy.difficulty === 'string' ? legacy.difficulty : '未知',
        tags: typeof legacy.topic === 'string' ? [legacy.topic] : [],
        description: typeof legacy.description === 'string' ? legacy.description : '',
        constraints: Array.isArray(legacy.constraints) ? legacy.constraints : [],
        mode: legacy.mode === 'acm' ? 'acm' : 'function',
        ...(legacy.adapter ? { adapter: legacy.adapter } : {}),
        cases: Array.isArray(legacy.cases) ? legacy.cases : [],
        starter: legacy.starter && typeof legacy.starter === 'object' ? legacy.starter : {},
        supportReason: '来自保留的 P1 题面快照；可运行能力仍须按实际模板与测试判定。',
      };
    }
    const legacyTime = this.#db.prepare('SELECT MIN(started_at) AS started_at FROM attempts WHERE problem_id = ?')
      .get(id) as Row;
    const createdAt = (head?.created_at ?? legacyTime.started_at ?? '') as string;
    return { id, version: selectedVersion as string, content, createdAt, updatedAt: (head?.updated_at ?? createdAt) as string };
  }

  /** Complete identity set for company-import membership checks; no content projection. */
  listProblemIds(): string[] {
    return (this.#db.prepare('SELECT problem_id FROM library_problem_heads ORDER BY rowid').all() as Row[]).map(row => row.problem_id as string);
  }

  /** Only the two immutable fields used to exclude recently practiced interview candidates. */
  listAttemptDates(): Array<Pick<Attempt, 'problemId' | 'startedAt'>> {
    return (this.#db.prepare('SELECT problem_id, started_at FROM attempts ORDER BY rowid DESC').all() as Row[])
      .map(row => ({ problemId: row.problem_id as string, startedAt: row.started_at as string }));
  }

  listProblems(filter: { search?: string; listId?: string } = {}): LibraryProblem[] {
    const rows = this.#db.prepare('SELECT problem_id FROM library_problem_heads ORDER BY rowid').all() as Row[];
    const memberIds = filter.listId ? new Set(this.getList(filter.listId)?.items.map((item) => item.problemId) ?? []) : undefined;
    const search = filter.search?.trim().toLocaleLowerCase();
    return rows.filter((row) => !memberIds || memberIds.has(row.problem_id as string))
      .map((row) => this.getProblem(row.problem_id as string)!)
      .filter((problem) => !search || `${problem.id} ${problem.content.title} ${problem.content.tags.join(' ')}`.toLocaleLowerCase().includes(search));
  }

  /** Metadata-only projection. SQL filters and limits before any row enters JavaScript. */
  listProblemPage(filter: ProblemPageFilter = {}): PageResult<ProblemListItem> {
    const bounds = pageBounds(filter), clauses: string[] = [], values: Array<string | number> = [], search = searchText(filter.search);
    if (filter.language) requireLanguage(filter.language);
    if (filter.support && !['runnable', 'reading'].includes(filter.support)) throw new Error('Invalid problem support filter');
    if (filter.ids !== undefined) {
      if (!Array.isArray(filter.ids) || filter.ids.length > 100) throw new Error('Problem ids must contain at most 100 ids');
      filter.ids.forEach(id => requireText(id, 'problem id'));
      if (!filter.ids.length) return pageResult([], 0, bounds);
      clauses.push(`problem_id IN (${filter.ids.map(() => '?').join(',')})`); values.push(...filter.ids);
    }
    if (filter.chapterId && !filter.listId) throw new Error('A chapter filter requires a list');
    if (filter.listId) { clauses.push('list_id = ?'); values.push(filter.listId); }
    if (filter.chapterId) { clauses.push('chapter_id = ?'); values.push(filter.chapterId); }
    if (search) { clauses.push("(problem_id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(tags_json) WHERE value LIKE ? ESCAPE '\\'))"); values.push(literalLike(search), literalLike(search), literalLike(search)); }
    if (filter.difficulty) { clauses.push("CASE lower(difficulty) WHEN 'easy' THEN '简单' WHEN 'medium' THEN '中等' WHEN 'hard' THEN '困难' ELSE difficulty END = ?"); values.push(filter.difficulty); }
    const template = filter.language === 'python' ? 'has_python' : filter.language === 'java' ? 'has_java' : '(has_python OR has_java)';
    const runnable = `(${template} AND (mode = 'acm' OR has_adapter) AND case_count > 0)`;
    if (filter.support) clauses.push(filter.support === 'runnable' ? runnable : `NOT ${runnable}`);
    if (filter.language) clauses.push(template);
    const cte = `WITH metadata AS (SELECT h.problem_id, h.version, h.created_at, h.updated_at, h.rowid AS ordering,
      COALESCE(json_extract(v.snapshot_json, '$.title'), h.problem_id) AS title,
      COALESCE(json_extract(v.snapshot_json, '$.difficulty'), '未知') AS difficulty,
      COALESCE(json_extract(v.snapshot_json, '$.tags'), json_array(json_extract(v.snapshot_json, '$.topic'))) AS tags_json,
      COALESCE(json_extract(v.snapshot_json, '$.source'), 'local') AS source,
      json_extract(v.snapshot_json, '$.sourceUrl') AS source_url, json_extract(v.snapshot_json, '$.supportReason') AS support_reason,
      COALESCE(json_extract(v.snapshot_json, '$.mode'), 'function') AS mode,
      json_extract(v.snapshot_json, '$.media.complete') AS media_complete,
      length(trim(COALESCE(json_extract(v.snapshot_json, '$.description'), ''), ${SQL_TRIM_WHITESPACE})) > 0 AS has_statement,
      COALESCE(json_type(v.snapshot_json, '$.adapter') = 'object', 0) AS has_adapter,
      length(trim(COALESCE(json_extract(v.snapshot_json, '$.starter.python'), ''), ${SQL_TRIM_WHITESPACE})) > 0 AS has_python,
      length(trim(COALESCE(json_extract(v.snapshot_json, '$.starter.java'), ''), ${SQL_TRIM_WHITESPACE})) > 0 AS has_java,
      COALESCE(json_array_length(v.snapshot_json, '$.cases'), 0) AS case_count,
      NOT EXISTS(SELECT 1 FROM json_each(v.snapshot_json, '$.cases') c WHERE json_type(c.value, '$.expected') IS NULL) AS has_expected
      ${filter.listId ? ', li.list_id, li.item_key, li.chapter_id, li.position, li.rowid AS item_order' : ''}
      FROM library_problem_heads h JOIN problem_versions v ON v.problem_id = h.problem_id AND v.version = h.version
      ${filter.listId ? 'JOIN list_items li ON li.problem_id = h.problem_id' : ''})`;
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.#db.prepare(`${cte} SELECT COUNT(*) AS total FROM metadata ${where}`).get(...values)!.total as number;
    const rows = this.#db.prepare(`${cte} SELECT * FROM metadata ${where} ORDER BY ${filter.listId ? 'position, item_order' : 'ordering'} LIMIT ? OFFSET ?`)
      .all(...values, bounds.limit, bounds.offset) as Row[];
    return pageResult(rows.map(row => {
      const statement = Boolean(row.has_statement), adapter = Boolean(row.has_adapter), python = Boolean(row.has_python), java = Boolean(row.has_java);
      const canRun = (filter.language === 'python' ? python : filter.language === 'java' ? java : python || java) && (row.mode === 'acm' || adapter) && Number(row.case_count) > 0;
      const expected = Boolean(row.has_expected), supportReason = row.support_reason as string | null;
      return { id: row.problem_id as string, version: row.version as string, createdAt: row.created_at as string, updatedAt: row.updated_at as string,
        content: { title: row.title as string, difficulty: row.difficulty as string, tags: (JSON.parse(row.tags_json as string) as unknown[]).filter((tag): tag is string => typeof tag === 'string'),
          source: row.source as ProblemSource, mode: row.mode as ProblemContent['mode'], ...(row.source_url ? { sourceUrl: row.source_url as string } : {}),
          ...(supportReason ? { supportReason } : {}), ...(row.media_complete !== null ? { media: { complete: Boolean(row.media_complete) } } : {}) },
        capabilities: { statement, adapter, python, java, cases: row.case_count as number, expected },
        capability: { canRun, level: canRun ? expected ? 'sample-verified' : 'execution-only' : statement ? 'statement-only' : 'link-only',
          label: canRun ? expected ? statement ? '本地可运行' : '本地可运行 · 缺题面' : '可运行 · 仅看输出' : statement ? '题面可读' : '仅链接',
          reason: canRun ? expected ? '使用已缓存的本地用例，结果不等同于官方 AC。' : '用例没有完整的可信期望值，只展示实际输出。' : supportReason || '题面、函数签名、语言模板或用例尚未准备完整。' },
        ...(filter.listId ? { listItem: { key: row.item_key as string, problemId: row.problem_id as string, position: row.position as number,
          ...(row.chapter_id !== null ? { chapterId: row.chapter_id as string } : {}) } } : {}) };
    }), total, bounds);
  }

  listAttemptPage(filter: AttemptPageFilter = {}): PageResult<AttemptListItem> {
    const bounds = pageBounds(filter), clauses: string[] = [], values: Array<string | number> = [], search = searchText(filter.search);
    if (filter.problemId) { clauses.push('problem_id = ?'); values.push(filter.problemId); }
    if (filter.language) { requireLanguage(filter.language); clauses.push('language = ?'); values.push(filter.language); }
    if (filter.state) {
      if (!['active', 'ended'].includes(filter.state)) throw new Error('Invalid attempt state filter');
      clauses.push(filter.state === 'active' ? 'is_active = 1' : 'ended_at IS NOT NULL');
    }
    if (search) { clauses.push("(title LIKE ? ESCAPE '\\' OR problem_id LIKE ? ESCAPE '\\')"); values.push(literalLike(search), literalLike(search)); }
    if (filter.helpLevel) {
      if (!['none', 'L0', 'L1', 'L2', 'L3', 'L4'].includes(filter.helpLevel)) throw new Error('Invalid help level filter');
      if (filter.helpLevel === 'none') clauses.push('help_level IS NULL'); else { clauses.push('help_level = ?'); values.push(filter.helpLevel); }
    }
    for (const [key, operator] of [['from', '>='], ['to', '<']] as const) if (filter[key]) {
      if (!Number.isFinite(Date.parse(filter[key]!))) throw new Error('Invalid attempt date filter');
      clauses.push(`started_at ${operator} ?`); values.push(new Date(filter[key]!).toISOString());
    }
    if (filter.timeZone !== undefined && !filter.learningDate) throw new Error('A learning time zone requires a learning date');
    if (filter.learningDate !== undefined) {
      const timeZone = filter.timeZone ?? this.getLearningSettings().timeZone;
      const start = archiveDateBoundary(filter.learningDate, timeZone), end = archiveDateBoundary(filter.learningDate, timeZone, true);
      // A recorded pulse is the preceding duration ending at occurred_at. Include either side of midnight.
      clauses.push(`(started_at >= ? AND started_at < ? OR ended_at >= ? AND ended_at < ?
        OR EXISTS(SELECT 1 FROM activity_samples s WHERE s.attempt_id = summaries.id AND s.duration_ms > 0 AND s.occurred_at > ?
          AND julianday(s.occurred_at) - s.duration_ms / 86400000.0 < julianday(?))
        OR EXISTS(SELECT 1 FROM runs r WHERE r.attempt_id = summaries.id AND r.created_at >= ? AND r.created_at < ?)
        OR EXISTS(SELECT 1 FROM review_events e WHERE e.attempt_id = summaries.id AND e.kind = 'review' AND e.reviewed_at >= ? AND e.reviewed_at < ?))`);
      values.push(start, end, start, end, start, end, start, end, start, end);
    }
    const cte = `WITH summaries AS (SELECT a.id, a.problem_id, a.language, a.problem_version, a.mode, a.started_at,
      a.draft_scope_id, a.ended_at, a.final_code_hash, a.final_draft_revision, a.final_last_run_id,
      a.last_run_matches_final, a.restored_from_run_id, a.rowid AS ordering,
      EXISTS(SELECT 1 FROM active_attempts active WHERE active.attempt_id = a.id) AS is_active,
      COALESCE(json_extract(v.snapshot_json, '$.title'), a.problem_id) AS title,
      (SELECT MAX(COALESCE(json_extract(ai.snapshot_json, '$.level'), 'adaptive')) FROM ai_requests ai WHERE ai.attempt_id = a.id AND ai.status = 'completed') AS help_level
      FROM attempts a JOIN problem_versions v ON v.problem_id = a.problem_id AND v.version = a.problem_version)`;
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.#db.prepare(`${cte} SELECT COUNT(*) AS total FROM summaries ${where}`).get(...values)!.total as number;
    const rows = this.#db.prepare(`${cte} SELECT *,
      (SELECT COUNT(*) FROM runs r WHERE r.attempt_id = summaries.id) AS run_count,
      (SELECT r.status FROM runs r WHERE r.attempt_id = summaries.id AND r.status <> 'queued' ORDER BY r.rowid DESC LIMIT 1) AS last_status,
      (SELECT COALESCE(SUM(s.duration_ms), 0) FROM activity_samples s WHERE s.attempt_id = summaries.id) AS active_ms
      FROM summaries ${where} ORDER BY ordering DESC LIMIT ? OFFSET ?`).all(...values, bounds.limit, bounds.offset) as Row[];
    return pageResult(rows.map(row => ({ attempt: { id: row.id as string, problemId: row.problem_id as string,
      language: row.language as Language, problemVersion: row.problem_version as string, mode: row.mode as Attempt['mode'],
      startedAt: row.started_at as string, draftScopeId: row.draft_scope_id as string, endedAt: row.ended_at as string | null,
      finalCodeHash: row.final_code_hash as string | null, finalDraftRevision: row.final_draft_revision as number | null,
      lastRunId: row.final_last_run_id as string | null, lastRunMatchesFinal: Boolean(row.last_run_matches_final),
      restoredFromRunId: row.restored_from_run_id as string | null, isActive: Boolean(row.is_active) },
      title: row.title as string, runCount: row.run_count as number, lastStatus: row.last_status as TerminalStatus | null,
      activeMs: row.active_ms as number, helpLevel: row.help_level as string | null })), total, bounds);
  }

  /** Newest first. Queued runs are excluded unless explicitly requested. */
  listRunPage(filter: RunPageFilter = {}): PageResult<RunListItem> {
    const bounds = pageBounds(filter), clauses: string[] = [], values: string[] = [];
    if (filter.attemptId) { clauses.push('r.attempt_id = ?'); values.push(filter.attemptId); }
    if (filter.problemId) { clauses.push('a.problem_id = ?'); values.push(filter.problemId); }
    if (filter.language) { requireLanguage(filter.language); clauses.push('a.language = ?'); values.push(filter.language); }
    if (filter.includeQueued !== undefined && typeof filter.includeQueued !== 'boolean') throw new Error('Invalid queued-run filter');
    if (!filter.includeQueued) clauses.push("r.status <> 'queued'");
    const from = 'FROM runs r JOIN attempts a ON a.id = r.attempt_id';
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.#db.prepare(`SELECT COUNT(*) AS total ${from} ${where}`).get(...values)!.total as number;
    // Materialize the page of ids first: sorting an old page must not decode every large result.
    const rows = this.#db.prepare(`WITH selected AS MATERIALIZED (
      SELECT r.id ${from} ${where} ORDER BY r.rowid DESC LIMIT ? OFFSET ?)
      SELECT r.id, r.attempt_id, a.problem_id, a.language, a.problem_version,
      r.code_hash, r.test_suite_version, r.adapter_version, r.runtime_version, r.status, r.created_at, r.finished_at,
      json_extract(r.result_json, '$.durationMs') AS duration_ms,
      COALESCE(json_array_length(r.result_json, '$.caseResults'), 0) AS case_count,
      (SELECT COUNT(*) FROM json_each(r.result_json, '$.caseResults') c WHERE json_extract(c.value, '$.status') = 'passed') AS passed_case_count
      FROM selected JOIN runs r ON r.id = selected.id JOIN attempts a ON a.id = r.attempt_id
      ORDER BY r.rowid DESC`).all(...values, bounds.limit, bounds.offset) as Row[];
    return pageResult(rows.map(row => ({ id: row.id as string, attemptId: row.attempt_id as string,
      problemId: row.problem_id as string, language: row.language as Language, problemVersion: row.problem_version as string,
      codeHash: row.code_hash as string, testSuiteVersion: row.test_suite_version as string, adapterVersion: row.adapter_version as string,
      runtimeVersion: row.runtime_version as string, status: row.status as RunStatus, createdAt: row.created_at as string,
      finishedAt: row.finished_at as string | null, durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : null,
      caseCount: row.case_count as number, passedCaseCount: row.passed_case_count as number })), total, bounds);
  }

  /** Across attempts for one problem and language, without fetching code or whole judge results. */
  listSubmissionHistory(filter: SubmissionHistoryFilter): PageResult<SubmissionHistoryItem> {
    if (!filter || typeof filter !== 'object') throw new Error('请选择题目和语言。');
    requireText(filter.problemId, 'problem id'); requireLanguage(filter.language);
    const bounds = pageBounds(filter), values = [filter.problemId, filter.language];
    const ids = `SELECT r.id, 'local' AS source, r.created_at FROM runs r JOIN attempts a ON a.id = r.attempt_id
      WHERE a.problem_id = ? AND a.language = ? AND r.status <> 'queued'
      UNION ALL SELECT s.id, 'official' AS source, s.created_at FROM official_submissions s JOIN attempts a ON a.id = s.attempt_id
      WHERE a.problem_id = ? AND a.language = ?`;
    const total = this.#db.prepare(`SELECT COUNT(*) AS total FROM (${ids})`).get(...values, ...values)!.total as number;
    // Select a bounded page before decoding even the official verdict field from a potentially large payload.
    const rows = this.#db.prepare(`WITH selected AS MATERIALIZED (SELECT * FROM (${ids})
      ORDER BY created_at DESC, source DESC, id DESC LIMIT ? OFFSET ?)
      SELECT selected.id, selected.source, COALESCE(r.attempt_id, s.attempt_id) AS attempt_id,
        a.problem_id, a.problem_version, a.language, selected.created_at,
        COALESCE(r.finished_at, s.finished_at) AS finished_at, COALESCE(r.code_hash, s.code_hash) AS code_hash,
        COALESCE(r.status, s.status) AS status, json_extract(s.result_json, '$.status') AS verdict,
        m.remark, m.revision AS remark_revision
      FROM selected
      LEFT JOIN runs r ON selected.source = 'local' AND r.id = selected.id
      LEFT JOIN official_submissions s ON selected.source = 'official' AND s.id = selected.id
      JOIN attempts a ON a.id = COALESCE(r.attempt_id, s.attempt_id)
      LEFT JOIN submission_remarks m ON (selected.source = 'local' AND m.local_run_id = selected.id)
        OR (selected.source = 'official' AND m.official_submission_id = selected.id)
      ORDER BY selected.created_at DESC, selected.source DESC, selected.id DESC`)
      .all(...values, ...values, bounds.limit, bounds.offset) as Row[];
    return pageResult(rows.map(historyItem), total, bounds);
  }

  /** Read-only comparison: this path never saves a draft or restores a run. */
  getSubmissionHistoryDetail(source: SubmissionHistorySource, id: string): SubmissionHistoryDetail {
    historySource(source); requireText(id, 'history id');
    const table = source === 'local' ? 'runs' : 'official_submissions';
    const reference = source === 'local' ? 'local_run_id' : 'official_submission_id';
    const row = this.#db.prepare(`SELECT r.id, ? AS source, r.attempt_id, a.problem_id, a.problem_version, a.language,
      r.created_at, r.finished_at, r.code_hash, r.status, r.code,
      ${source === 'official' ? "json_extract(r.result_json, '$.status')" : 'NULL'} AS verdict,
      m.remark, m.revision AS remark_revision
      FROM ${table} r JOIN attempts a ON a.id = r.attempt_id LEFT JOIN submission_remarks m ON m.${reference} = r.id
      WHERE r.id = ? ${source === 'local' ? "AND r.status <> 'queued'" : ''}`).get(source, id) as Row | undefined;
    if (!row) throw new Error('历史记录不存在或尚未完成。');
    return { ...historyItem(row), code: row.code as string };
  }

  saveSubmissionRemark(input: SaveSubmissionRemarkInput): SubmissionRemark {
    if (!input || typeof input !== 'object') throw new Error('备注内容无效。');
    const source = historySource(input.source); requireText(input.id, 'history id');
    if (typeof input.remark !== 'string' || input.remark.includes('\0') || [...input.remark].length > SUBMISSION_REMARK_LIMIT) {
      throw new Error(`备注最多 ${SUBMISSION_REMARK_LIMIT} 个字。`);
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('备注版本无效。');
    const remark = input.remark.trim(), table = source === 'local' ? 'runs' : 'official_submissions';
    const reference = source === 'local' ? 'local_run_id' : 'official_submission_id';
    return this.#transaction(() => {
      const target = this.#db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(input.id) as Row | undefined;
      if (!target || (source === 'local' && target.status === 'queued')) throw new Error('历史记录不存在或尚未完成。');
      const previous = this.#db.prepare(`SELECT remark, revision FROM submission_remarks WHERE ${reference} = ?`).get(input.id) as Row | undefined;
      const revision = (previous?.revision as number | undefined) ?? 0;
      if (revision !== input.expectedRevision) throw new Error('备注已在其他位置更新，请重新打开后再保存。');
      if ((previous?.remark ?? '') === remark) return { source, id: input.id, remark, remarkRevision: revision };
      // Keep an empty annotation row after clearing, so an older editor cannot recreate a discarded remark.
      if (previous) this.#db.prepare(`UPDATE submission_remarks SET remark = ?, revision = ?, updated_at = ? WHERE ${reference} = ?`)
        .run(remark, revision + 1, new Date().toISOString(), input.id);
      else this.#db.prepare(`INSERT INTO submission_remarks (${reference}, remark, revision, updated_at) VALUES (?, ?, 1, ?)`)
        .run(input.id, remark, new Date().toISOString());
      return { source, id: input.id, remark, remarkRevision: revision + 1 };
    });
  }

  getList(id: string): StudyList | undefined {
    const row = this.#db.prepare('SELECT * FROM study_lists WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    const chapters = (this.#db.prepare('SELECT * FROM list_chapters WHERE list_id = ? ORDER BY position, rowid').all(id) as Row[])
      .map((chapter): ListChapter => ({ id: chapter.id as string, title: chapter.title as string,
        ...(chapter.parent_id === null ? {} : { parentId: chapter.parent_id as string }), position: chapter.position as number }));
    const items = (this.#db.prepare('SELECT * FROM list_items WHERE list_id = ? ORDER BY position, rowid').all(id) as Row[])
      .map((item): StudyListItem => ({ key: item.item_key as string, problemId: item.problem_id as string,
        ...(item.chapter_id === null ? {} : { chapterId: item.chapter_id as string }), position: item.position as number }));
    return { id, title: row.title as string, source: row.source as ProblemSource,
      ...(row.source_url === null ? {} : { sourceUrl: row.source_url as string }), chapters, items,
      revision: row.revision as number, createdAt: row.created_at as string, updatedAt: row.updated_at as string };
  }

  listLists(): StudyList[] {
    return (this.#db.prepare('SELECT id FROM study_lists ORDER BY rowid').all() as Row[])
      .map((row) => this.getList(row.id as string)!);
  }

  previewListRefresh(input: ListSnapshotInput): ListRefreshPreview {
    const candidate = normalizeList(input);
    return this.#transaction(() => {
      const existing = this.getList(candidate.id);
      const previous = new Map(existing?.items.map((item) => [item.key, item]) ?? []);
      const incoming = new Map(candidate.items.map((item) => [item.key, item]));
      const added = candidate.items.filter((item) => previous.get(item.key)?.problemId !== item.problemId);
      const removed = (existing?.items ?? []).filter((item) => incoming.get(item.key)?.problemId !== item.problemId);
      const moved = candidate.items.flatMap((after) => {
        const before = previous.get(after.key);
        return before && before.problemId === after.problemId && json(before) !== json(after) ? [{ before, after }] : [];
      });
      const preview: ListRefreshPreview = { id: randomUUID(), listId: candidate.id, baseRevision: existing?.revision ?? 0,
        candidate, added, removed, moved, canApply: candidate.membershipComplete,
        ...(!candidate.membershipComplete ? { reason: '题单成员未完整获取；不能应用不完整刷新。' } : {}), appliedAt: null };
      this.#db.prepare('INSERT INTO list_refresh_previews VALUES (?, ?, ?, ?, ?, NULL)')
        .run(preview.id, preview.listId, preview.baseRevision, json(preview), new Date().toISOString());
      return preview;
    });
  }

  applyListRefresh(previewId: string): StudyList {
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM list_refresh_previews WHERE id = ?').get(previewId) as Row | undefined;
      if (!row) throw new Error('Refresh preview not found');
      const preview = JSON.parse(row.preview_json as string) as ListRefreshPreview;
      const previous = this.getList(preview.listId);
      if (row.applied_at !== null) {
        if (!previous) throw new Error('Previously applied list is missing');
        return previous;
      }
      if (!preview.canApply || !preview.candidate.membershipComplete) throw new Error('Incomplete list membership cannot be applied');
      if ((previous?.revision ?? 0) !== preview.baseRevision) throw new Error('List changed after preview; create a new preview');
      const candidate = normalizeList(preview.candidate);
      const now = new Date().toISOString();
      this.#db.prepare(`INSERT INTO study_lists VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, source = excluded.source,
        source_url = excluded.source_url, revision = excluded.revision, updated_at = excluded.updated_at`)
        .run(candidate.id, candidate.title, candidate.source, candidate.sourceUrl ?? null, preview.baseRevision + 1, now, now);
      this.#db.prepare('DELETE FROM list_items WHERE list_id = ?').run(candidate.id);
      this.#db.prepare('DELETE FROM list_chapters WHERE list_id = ?').run(candidate.id);
      for (const chapter of candidate.chapters) this.#db.prepare('INSERT INTO list_chapters VALUES (?, ?, ?, ?, ?)')
        .run(candidate.id, chapter.id, chapter.title, chapter.parentId ?? null, chapter.position);
      for (const item of candidate.items) {
        if (!this.getProblem(item.problemId)) this.upsertProblem(placeholderProblem(item.problemId, item.problemId, candidate.source));
        this.#db.prepare('INSERT INTO list_items VALUES (?, ?, ?, ?, ?)')
          .run(candidate.id, item.key, item.problemId, item.chapterId ?? null, item.position);
      }
      this.#db.prepare('UPDATE list_refresh_previews SET applied_at = ? WHERE id = ?').run(now, previewId);
      return this.getList(candidate.id)!;
    });
  }

  createImportJob(input: CreateImportJobInput): ImportJob {
    requireText(input.title, 'import title'); requireText(input.input, 'import input'); requireSource(input.source);
    if (!Array.isArray(input.items)) throw new Error('Import items are required');
    const deduplicated = new Map<string, ImportItemSeed>();
    for (const raw of input.items) {
      const seed = JSON.parse(json(raw)) as ImportItemSeed;
      requireText(seed.key, 'import item key'); requireText(seed.problemId, 'problem id'); position(seed.position);
      if (typeof seed.title !== 'string') throw new Error('Import item title must be text');
      const previous = deduplicated.get(seed.key);
      if (previous && json(previous) !== json(seed)) throw new Error('Import item key identifies conflicting entries');
      deduplicated.set(seed.key, seed);
    }
    const payload = { title: input.title, input: input.input, source: input.source,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.list ? { list: normalizeList(input.list) } : {}), items: [...deduplicated.values()] };
    const payloadJSON = json(payload);
    const inputHash = hashCode(payloadJSON);
    const requestKey = input.requestKey ?? input.id ?? randomUUID();
    const id = input.id ?? randomUUID();
    requireText(requestKey, 'import request key'); requireText(id, 'import id');
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT id, request_key, input_hash FROM import_jobs WHERE request_key = ? OR id = ?')
        .all(requestKey, id) as Row[];
      if (existing.length) {
        if (existing.length !== 1 || existing[0].request_key !== requestKey || existing[0].input_hash !== inputHash
          || (input.id !== undefined && existing[0].id !== input.id)) throw new Error('Import request key conflicts with different input');
        return this.getImportJob(existing[0].id as string)!;
      }
      const now = new Date().toISOString();
      this.#db.prepare('INSERT INTO import_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, requestKey, payloadJSON, inputHash, 'pending', 'null', now, now);
      for (const seed of payload.items) {
        if (!this.getProblem(seed.problemId)) this.upsertProblem(placeholderProblem(seed.problemId, seed.title, input.source, seed.sourceUrl));
        this.#db.prepare('INSERT INTO import_items VALUES (?, ?, ?, ?, NULL, ?, ?, 0, ?)')
          .run(id, seed.key, seed.problemId, json(seed), 'pending', 'null', now);
      }
      return this.getImportJob(id)!;
    });
  }

  getImportJob(id: string): ImportJob | undefined {
    const row = this.#db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    const input = JSON.parse(row.input_json as string) as Omit<CreateImportJobInput, 'id' | 'requestKey'>;
    const counts = Object.fromEntries(IMPORT_ITEM_STATUSES.map((status) => [status, 0])) as Record<ImportItemStatus, number>;
    const items = (this.#db.prepare('SELECT * FROM import_items WHERE job_id = ? ORDER BY rowid').all(id) as Row[])
      .map((item): ImportItem => {
        const status = item.status as ImportItemStatus; counts[status]++;
        return { ...(JSON.parse(item.seed_json as string) as ImportItemSeed), status, version: item.version as string | null,
          error: JSON.parse(item.error_json as string), attempts: item.attempts as number, updatedAt: item.updated_at as string };
      });
    return { ...input, id, requestKey: row.request_key as string, status: row.status as ImportJobStatus,
      items, counts, total: items.length, error: JSON.parse(row.error_json as string),
      createdAt: row.created_at as string, updatedAt: row.updated_at as string };
  }

  listImportJobs(): ImportJob[] {
    return (this.#db.prepare('SELECT id FROM import_jobs ORDER BY rowid DESC').all() as Row[])
      .map((row) => this.getImportJob(row.id as string)!);
  }

  updateImportItem(jobId: string, key: string, update: ImportItemUpdate): ImportItem {
    if (!IMPORT_ITEM_STATUSES.includes(update.status)) throw new Error('Invalid import item status');
    const error = normalizeError(update.error);
    return this.#transaction(() => {
      const job = this.getImportJob(jobId);
      const item = job?.items.find((candidate) => candidate.key === key);
      if (!job || !item) throw new Error('Import item not found');
      const content = update.content ? normalizeProblem(update.content) : undefined;
      if (content && content.id !== item.problemId) throw new Error('Imported content belongs to a different problem');
      if (COMPLETE_ITEM_STATUSES.has(item.status)) {
        const version = content ? `sha256:${hashCode(json(content))}` : item.version;
        const sameSuccess = ['imported', 'reused'].includes(item.status) && ['imported', 'reused'].includes(update.status);
        if ((update.status === item.status || sameSuccess) && version === item.version && json(error) === json(item.error)) return item;
        throw new Error('Successful import item cannot be overwritten; use a new import job for refresh');
      }
      if (job.status !== 'running') throw new Error('Import job must be running before updating items');
      if (update.status === 'running' && !['pending', 'running'].includes(item.status)) throw new Error('Retry failed items explicitly before running');
      if (update.status === 'pending' && !['pending', 'running'].includes(item.status)) throw new Error('Retry failed items explicitly before resetting item state');
      let status = update.status;
      let version = item.version;
      const previous = this.getProblem(item.problemId);
      if (content && !['imported', 'reused', 'link_only', 'restricted'].includes(status)) {
        throw new Error('Fetched content must be committed with an import outcome');
      }
      const hasPreparedContent = previous && (previous.content.description.trim() || previous.content.cases.length
        || Object.values(previous.content.starter).some((code) => code?.trim()));
      if (content && ['link_only', 'restricted'].includes(status) && hasPreparedContent) {
        // An unavailable refresh is evidence about the source, not permission to erase an existing local statement.
        version = previous.version;
      } else if (content) {
        const saved = this.upsertProblem(content); version = saved.version;
        if (status === 'imported' || status === 'reused') status = previous?.version === saved.version ? 'reused' : 'imported';
      } else if (status === 'imported' || status === 'reused') {
        if (!previous) throw new Error('Successful import requires content or an existing version reference');
        status = 'reused'; version = previous.version;
      } else if (['link_only', 'restricted', 'failed'].includes(status)) version = previous?.version ?? null;
      if ((status === 'failed' || status === 'restricted') && !error) throw new Error('Failed or restricted item requires an error');
      const attempts = item.attempts + (status === 'running' && item.status !== 'running' ? 1 : 0);
      const now = new Date().toISOString();
      this.#db.prepare('UPDATE import_items SET version = ?, status = ?, error_json = ?, attempts = ?, updated_at = ? WHERE job_id = ? AND item_key = ?')
        .run(version, status, json(error), attempts, now, jobId, key);
      this.#db.prepare('UPDATE import_jobs SET updated_at = ? WHERE id = ?').run(now, jobId);
      return this.getImportJob(jobId)!.items.find((candidate) => candidate.key === key)!;
    });
  }

  updateImportJob(id: string, update: ImportJobUpdate): ImportJob {
    if (!IMPORT_JOB_STATUSES.includes(update.status)) throw new Error('Invalid import job status');
    const error = normalizeError(update.error);
    return this.#transaction(() => {
      const job = this.getImportJob(id);
      if (!job) throw new Error('Import job not found');
      const now = new Date().toISOString();
      if (update.retryFailed) {
        if (update.status !== 'running') throw new Error('Retry requires running status');
        this.#db.prepare(`UPDATE import_items SET status = 'pending', error_json = 'null', updated_at = ?
          WHERE job_id = ? AND status IN ('failed', 'restricted')`).run(now, id);
      }
      if (update.status === 'paused' || update.status === 'cancelled') {
        this.#db.prepare(`UPDATE import_items SET status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'running'`).run(now, id);
      }
      let status = update.status;
      if (status === 'completed' || status === 'completed_with_errors') {
        const current = this.getImportJob(id)!;
        if (current.counts.pending || current.counts.running) throw new Error('Import still contains unfinished items');
        status = current.counts.failed || current.counts.restricted ? 'completed_with_errors' : 'completed';
      }
      if (update.status === 'running' && ['completed', 'completed_with_errors'].includes(job.status) && !update.retryFailed) {
        throw new Error('Completed import requires an explicit retry of failed items');
      }
      this.#db.prepare('UPDATE import_jobs SET status = ?, error_json = ?, updated_at = ? WHERE id = ?')
        .run(status, json(error), now, id);
      return this.getImportJob(id)!;
    });
  }

  recoverImportJobs(): number {
    return this.#transaction(() => {
      const jobs = this.#db.prepare("SELECT id FROM import_jobs WHERE status = 'running'").all() as Row[];
      for (const row of jobs) this.updateImportJob(row.id as string, { status: 'paused', error: {
        code: 'INTERRUPTED', message: '应用中断；已完成项目已保留，可继续未完成项目。', retryable: true,
      } });
      return jobs.length;
    });
  }

  getDraft(problemId: string, language: Language, scopeId = 'practice'): Draft | undefined {
    const row = this.#db.prepare('SELECT * FROM drafts WHERE problem_id = ? AND language = ? AND scope_id = ?')
      .get(problemId, language, scopeId) as Row | undefined;
    return row ? {
      problemId: row.problem_id as string, language: row.language as Language,
      scopeId: row.scope_id as string, code: row.code as string, codeHash: row.code_hash as string,
      revision: row.revision as number, savedAt: row.saved_at as string,
    } : undefined;
  }

  saveDraft(input: SaveDraftInput): Draft {
    requireText(input.problemId, 'problemId');
    requireLanguage(input.language);
    const scopeId = input.scopeId ?? 'practice';
    requireText(scopeId, 'scopeId');
    const codeHash = hashCode(input.code);
    return this.#transaction(() => {
      const previous = this.getDraft(input.problemId, input.language, scopeId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== (previous?.revision ?? 0)) {
        throw new Error('Draft revision conflict');
      }
      if (previous?.codeHash === codeHash) return previous;
      this.#db.prepare('INSERT OR IGNORE INTO problems(id) VALUES (?)').run(input.problemId);
      this.#db.prepare(`INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(problem_id, language, scope_id) DO UPDATE SET
        code = excluded.code, code_hash = excluded.code_hash,
        revision = excluded.revision, saved_at = excluded.saved_at`)
        .run(input.problemId, input.language, scopeId, input.code, codeHash,
          (previous?.revision ?? 0) + 1, new Date().toISOString());
      return this.getDraft(input.problemId, input.language, scopeId)!;
    });
  }

  getAttempt(id: string): Attempt | undefined {
    const row = this.#db.prepare(`SELECT a.*, p.snapshot_json,
      EXISTS(SELECT 1 FROM active_attempts current WHERE current.attempt_id = a.id) AS is_active FROM attempts a
      JOIN problem_versions p ON p.problem_id = a.problem_id AND p.version = a.problem_version
      WHERE a.id = ?`).get(id) as Row | undefined;
    return row ? {
      id: row.id as string, problemId: row.problem_id as string, language: row.language as Language,
      problemVersion: row.problem_version as string, problemSnapshot: JSON.parse(row.snapshot_json as string),
      mode: row.mode as Attempt['mode'], startedAt: row.started_at as string,
      draftScopeId: row.draft_scope_id as string, endedAt: row.ended_at as string | null,
      finalCode: row.final_code as string | null, finalCodeHash: row.final_code_hash as string | null,
      finalDraftRevision: row.final_draft_revision as number | null, lastRunId: row.final_last_run_id as string | null,
      lastRunMatchesFinal: row.last_run_matches_final === 1, restoredFromRunId: row.restored_from_run_id as string | null,
      isActive: row.is_active === 1,
    } : undefined;
  }

  getActiveAttempt(problemId: string, language: Language, mode: Attempt['mode'] = 'practice', scopeId = 'practice'): Attempt | undefined {
    const row = this.#db.prepare('SELECT attempt_id FROM active_attempts WHERE problem_id = ? AND language = ? AND mode = ? AND scope_id = ?')
      .get(problemId, language, mode, scopeId) as Row | undefined;
    return row ? this.getAttempt(row.attempt_id as string) : undefined;
  }

  listAttempts(problemId?: string, language?: Language): Attempt[] {
    const rows = this.#db.prepare(`SELECT id FROM attempts
      WHERE (? IS NULL OR problem_id = ?) AND (? IS NULL OR language = ?) ORDER BY rowid DESC`)
      .all(problemId ?? null, problemId ?? null, language ?? null, language ?? null) as Row[];
    return rows.map((row) => this.getAttempt(row.id as string)!);
  }

  startAttempt(input: StartAttemptInput): Attempt {
    requireText(input.problemId, 'problemId');
    requireText(input.problemVersion, 'problemVersion');
    requireLanguage(input.language);
    const id = input.id ?? randomUUID();
    requireText(id, 'id');
    const mode = input.mode ?? 'practice';
    const scopeId = input.draftScopeId ?? 'practice';
    requireText(scopeId, 'draft scope id');
    return this.#transaction(() => {
      const existing = this.getAttempt(id);
      if (existing) {
        if (existing.problemId !== input.problemId || existing.language !== input.language
          || existing.problemVersion !== input.problemVersion || existing.mode !== mode || existing.draftScopeId !== scopeId
          || existing.restoredFromRunId !== (input.restoredFromRunId ?? null)
          || (input.problemSnapshot !== undefined && json(existing.problemSnapshot) !== json(input.problemSnapshot))) {
          throw new Error('Attempt id conflicts with an existing attempt');
        }
        return existing;
      }
      const active = this.getActiveAttempt(input.problemId, input.language, mode, scopeId);
      if (active) {
        if (active.problemVersion === input.problemVersion && input.problemSnapshot !== undefined
          && json(active.problemSnapshot) !== json(input.problemSnapshot)) throw new Error('Problem version conflicts with its immutable snapshot');
        if (input.id || active.problemVersion !== input.problemVersion) {
          throw new Error('An active attempt already owns this draft scope; continue or finish it first');
        }
        return active;
      }
      if (input.restoredFromRunId) {
        const original = this.#readRun(input.restoredFromRunId);
        if (!original || original.problemId !== input.problemId || original.language !== input.language
          || original.problemVersion !== input.problemVersion) throw new Error('Restored run does not match the attempt identity');
      }
      this.#db.prepare('INSERT OR IGNORE INTO problems(id) VALUES (?)').run(input.problemId);
      const version = this.#db.prepare('SELECT snapshot_json FROM problem_versions WHERE problem_id = ? AND version = ?')
        .get(input.problemId, input.problemVersion) as Row | undefined;
      if (version && input.problemSnapshot !== undefined && version.snapshot_json !== json(input.problemSnapshot)) {
        throw new Error('Problem version conflicts with its immutable snapshot');
      }
      if (!version) this.#db.prepare('INSERT INTO problem_versions VALUES (?, ?, ?)')
        .run(input.problemId, input.problemVersion, json(input.problemSnapshot ?? null));
      this.#db.prepare(`INSERT INTO attempts
        (id, problem_id, language, problem_version, mode, started_at, draft_scope_id, restored_from_run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.problemId, input.language, input.problemVersion, mode, new Date().toISOString(), scopeId, input.restoredFromRunId ?? null);
      this.#db.prepare('INSERT INTO active_attempts VALUES (?, ?, ?, ?, ?)').run(input.problemId, input.language, mode, scopeId, id);
      return this.getAttempt(id)!;
    });
  }

  finishAttempt(id: string, input: FinishAttemptInput = {}): Attempt {
    return this.#transaction(() => {
      const attempt = this.getAttempt(id);
      if (!attempt) throw new Error('Attempt not found');
      const scopeId = input.scopeId ?? attempt.draftScopeId;
      if (scopeId !== attempt.draftScopeId) throw new Error('Draft scope does not match the attempt');
      if (attempt.endedAt !== null) {
        if (input.code !== undefined && hashCode(input.code) !== attempt.finalCodeHash) throw new Error('Attempt already ended with a different final snapshot');
        return attempt;
      }
      if (this.#db.prepare("SELECT id FROM runs WHERE attempt_id = ? AND status = 'queued' LIMIT 1").get(id) || this.hasActiveOfficialSubmission(id)) {
        throw new Error('Cannot finish an attempt while a run or official submission is unfinished');
      }
      const draft = input.code === undefined ? this.getDraft(attempt.problemId, attempt.language, scopeId)
        : this.saveDraft({ problemId: attempt.problemId, language: attempt.language, scopeId, code: input.code,
          expectedRevision: input.expectedDraftRevision });
      if (!draft) throw new Error('A final draft is required to finish the attempt');
      if (input.code === undefined && input.expectedDraftRevision !== undefined && draft.revision !== input.expectedDraftRevision) {
        throw new Error('Draft revision conflict');
      }
      const lastRun = this.#db.prepare('SELECT id, code_hash AS codeHash FROM runs WHERE attempt_id = ? ORDER BY rowid DESC LIMIT 1').get(id);
      const matches = lastRun !== undefined && lastRun.codeHash === draft.codeHash;
      this.#db.prepare(`UPDATE attempts SET ended_at = ?, final_code = ?, final_code_hash = ?,
        final_draft_revision = ?, final_last_run_id = ?, last_run_matches_final = ? WHERE id = ?`)
        .run(new Date().toISOString(), draft.code, draft.codeHash, draft.revision, lastRun?.id ?? null, matches ? 1 : 0, id);
      this.#db.prepare('DELETE FROM active_attempts WHERE attempt_id = ?').run(id);
      this.#learning.freezeAttemptNotes(id, attempt.problemId);
      return this.getAttempt(id)!;
    });
  }

  getRun(id: string): StoredRun | undefined { return this.#readRun(id); }

  getOfficialSubmission(id: string): OfficialSubmission | undefined {
    const row = this.#db.prepare(`SELECT s.*, a.problem_id, a.problem_version, a.language
      FROM official_submissions s JOIN attempts a ON a.id = s.attempt_id WHERE s.id = ?`).get(id) as Row | undefined;
    if (!row) return undefined;
    const submissionId = row.submission_id as string | null;
    return { id: row.id as string, attemptId: row.attempt_id as string, problemId: row.problem_id as string,
      problemVersion: row.problem_version as string, language: row.language as Language,
      code: row.code as string, codeHash: row.code_hash as string, draftRevision: row.draft_revision as number,
      slug: row.slug as string, sourceId: row.source_id as string, submissionId,
      status: row.status as OfficialSubmission['status'], result: JSON.parse(row.result_json as string),
      error: JSON.parse(row.error_json as string), createdAt: row.created_at as string,
      updatedAt: row.updated_at as string, finishedAt: row.finished_at as string | null,
      resultUrl: submissionId ? officialSubmissionUrl(submissionId) : null };
  }

  listOfficialSubmissions(attemptId: string): OfficialSubmission[] {
    requireText(attemptId, 'attempt id');
    return (this.#db.prepare('SELECT id FROM official_submissions WHERE attempt_id = ? ORDER BY rowid DESC LIMIT 200')
      .all(attemptId) as Row[]).map(row => this.getOfficialSubmission(row.id as string)!);
  }

  hasActiveOfficialSubmission(attemptId?: string): boolean {
    return Boolean(attemptId
      ? this.#db.prepare("SELECT 1 FROM official_submissions WHERE attempt_id = ? AND status IN ('submitting','judging') LIMIT 1").get(attemptId)
      : this.#db.prepare("SELECT 1 FROM official_submissions WHERE status IN ('submitting','judging') LIMIT 1").get());
  }

  beginOfficialSubmission(input: BeginOfficialSubmissionInput): OfficialSubmission {
    requireText(input.requestId, 'official request id'); requireText(input.attemptId, 'attempt id');
    if (input.requestId.length > 200 || typeof input.code !== 'string' || Buffer.byteLength(input.code, 'utf8') > 1_000_000) throw new Error('Invalid official submission input');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug) || !/^\d{1,30}$/.test(input.sourceId)) throw new Error('Invalid official problem identity');
    return this.#transaction(() => {
      const codeHash = hashCode(input.code), previous = this.getOfficialSubmission(input.requestId);
      if (previous) {
        if (previous.attemptId !== input.attemptId || previous.codeHash !== codeHash || previous.slug !== input.slug || previous.sourceId !== input.sourceId) {
          throw new Error('Official request id conflicts with a different snapshot');
        }
        return previous;
      }
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt || !attempt.isActive || attempt.endedAt || attempt.mode === 'strict') throw new Error('请在当前普通练习中提交代码。');
      const interview = this.getInterviewForAttempt(attempt.id);
      if (interview && !interview.endedAt) throw new Error('模拟面试中不能提交到力扣。');
      const problem = this.getProblem(attempt.problemId, attempt.problemVersion)?.content;
      if (!problem || problem.source !== 'leetcode-cn' || problem.mode !== 'function' || !problem.starter[attempt.language]
        || problem.sourceId !== input.sourceId || officialProblemSlug(problem.sourceUrl) !== input.slug) throw new Error('题目缺少当前语言的官方模板或提交信息，请重新导入。');
      const draft = this.getDraft(attempt.problemId, attempt.language, attempt.draftScopeId);
      if (!draft || draft.codeHash !== codeHash || (input.expectedDraftRevision !== undefined && draft.revision !== input.expectedDraftRevision)) {
        throw new Error('代码已变化，请等待草稿保存完成后再提交。');
      }
      if (this.hasActiveOfficialSubmission(attempt.id)) throw new Error('当前题目正在提交或判题，请等待结果。');
      const now = new Date().toISOString();
      this.#db.prepare(`INSERT INTO official_submissions
        (id,attempt_id,code,code_hash,draft_revision,slug,source_id,submission_id,status,result_json,error_json,created_at,updated_at,finished_at)
        VALUES (?,?,?,?,?,?,?,NULL,'submitting','null','null',?,?,NULL)`)
        .run(input.requestId, attempt.id, input.code, codeHash, draft.revision, input.slug, input.sourceId, now, now);
      return this.getOfficialSubmission(input.requestId)!;
    });
  }

  updateOfficialSubmission(id: string, input: OfficialSubmissionUpdate): OfficialSubmission {
    return this.#transaction(() => {
      const previous = this.getOfficialSubmission(id);
      if (!previous) throw new Error('Official submission not found');
      const allowed: Record<OfficialSubmission['status'], OfficialSubmission['status'][]> = {
        submitting: ['judging', 'unknown', 'error'], judging: ['completed', 'paused'], paused: ['judging'], completed: [], unknown: [], error: [],
      };
      const submissionId = input.submissionId ?? previous.submissionId;
      if (submissionId) officialSubmissionUrl(submissionId);
      if (previous.submissionId && submissionId !== previous.submissionId) throw new Error('Official submission id is immutable');
      const result = input.result ?? null, error = input.error ?? null;
      if (previous.status === input.status && previous.submissionId === submissionId && json(previous.result) === json(result) && json(previous.error) === json(error)) return previous;
      if (!allowed[previous.status].includes(input.status)) throw new Error('Invalid official submission status transition');
      if (['judging', 'paused', 'completed'].includes(input.status) && !submissionId) throw new Error('Official submission id is required');
      if ((input.status === 'completed') !== Boolean(result)) throw new Error('Official result is only valid after completed judging');
      const now = new Date(Math.max(Date.now(), Date.parse(previous.updatedAt) + 1)).toISOString();
      const finishedAt = ['completed', 'unknown', 'error'].includes(input.status) ? now : null;
      this.#db.prepare(`UPDATE official_submissions SET submission_id=?,status=?,result_json=?,error_json=?,updated_at=?,finished_at=? WHERE id=?`)
        .run(submissionId, input.status, json(result), json(error), now, finishedAt, id);
      return this.getOfficialSubmission(id)!;
    });
  }

  recoverInterruptedOfficialSubmissions(): number {
    const rows = this.#db.prepare("SELECT id FROM official_submissions WHERE status IN ('submitting','judging')").all() as Row[];
    return this.#transaction(() => {
      for (const row of rows) {
        const record = this.getOfficialSubmission(row.id as string)!;
        this.updateOfficialSubmission(record.id, { status: record.submissionId ? 'paused' : 'unknown',
          error: { code: 'interrupted', message: record.submissionId ? '结果查询已暂停，可以继续查询。' : '上次提交被中断，无法确认是否已送达，请先在力扣提交记录中核对。' } });
      }
      return rows.length;
    });
  }

  /** Explicit user deletion of one finished archive; ratings, notes and all drafts remain independent. */
  deleteEndedAttempt(id: string): boolean {
    requireText(id, 'attempt id');
    return this.#transaction(() => {
      const attempt = this.getAttempt(id);
      if (!attempt) return false;
      if (attempt.endedAt === null || attempt.isActive) throw new Error('Finish the attempt before deleting its archive');
      if (this.#db.prepare("SELECT 1 FROM runs WHERE attempt_id = ? AND status = 'queued' LIMIT 1").get(id)
        || this.#db.prepare("SELECT 1 FROM ai_requests WHERE attempt_id = ? AND status IN ('pending', 'streaming', 'repairing') LIMIT 1").get(id)
        || this.hasActiveOfficialSubmission(id)) {
        throw new Error('Wait for unfinished runs and AI requests before deleting the archive');
      }
      // Run.attempt_id and Attempt.final_last_run_id form a cycle. Defer checks until this
      // transaction has deleted both sides; foreign_keys remains ON and COMMIT checks all FKs.
      this.#db.exec('PRAGMA defer_foreign_keys = ON');
      this.#learning.detachAndDeleteAttemptData(id);
      this.#db.prepare(`UPDATE attempts SET restored_from_run_id = NULL
        WHERE id <> ? AND restored_from_run_id IN (SELECT id FROM runs WHERE attempt_id = ?)`).run(id, id);
      this.#db.prepare(`DELETE FROM draft_restorations
        WHERE attempt_id = ? OR run_id IN (SELECT id FROM runs WHERE attempt_id = ?)`).run(id, id);
      this.#db.prepare('DELETE FROM runs WHERE attempt_id = ?').run(id);
      this.#db.prepare('DELETE FROM official_submissions WHERE attempt_id = ?').run(id);
      this.#db.prepare('DELETE FROM attempts WHERE id = ?').run(id);
      return true;
    });
  }

  beginRun(input: BeginRunInput): StoredRun {
    if (input.status !== undefined && input.status !== 'queued') throw new Error('beginRun must persist a queued snapshot before execution');
    return this.#transaction(() => {
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error('Attempt not found');
      const scopeId = input.scopeId ?? attempt.draftScopeId;
      if (scopeId !== attempt.draftScopeId) throw new Error('Run draft scope does not match the attempt');
      // Retrying an existing Run must not replace a newer draft with its older code.
      if (input.id && this.#readRun(input.id)) return this.saveRun(input);
      this.saveDraft({ problemId: attempt.problemId, language: attempt.language, code: input.code,
        scopeId, expectedRevision: input.expectedDraftRevision });
      return this.saveRun(input);
    });
  }

  restoreRunAsDraft(runId: string, input: { requestId: string; scopeId?: string }): { draft: Draft; attempt: Attempt } {
    requireText(input.requestId, 'restore request id');
    const scopeId = input.scopeId ?? `restore:${input.requestId}`;
    requireText(scopeId, 'restore draft scope');
    return this.#transaction(() => {
      const restored = this.#db.prepare('SELECT * FROM draft_restorations WHERE request_id = ?').get(input.requestId) as Row | undefined;
      if (restored) {
        if (restored.run_id !== runId || restored.scope_id !== scopeId) throw new Error('Restore request id conflicts with different input');
        const attempt = this.getAttempt(restored.attempt_id as string)!;
        const draft = this.getDraft(attempt.problemId, attempt.language, scopeId);
        if (!draft) throw new Error('Restored draft is missing');
        return { draft, attempt };
      }
      const run = this.#readRun(runId);
      if (!run) throw new Error('Run not found');
      if (this.getDraft(run.problemId, run.language, scopeId)
        || this.getActiveAttempt(run.problemId, run.language, 'practice', scopeId)) throw new Error('Restore requires a new draft scope');
      const original = this.getAttempt(run.attemptId)!;
      const attempt = this.startAttempt({ id: `restore-attempt:${input.requestId}`, problemId: run.problemId,
        language: run.language, problemVersion: run.problemVersion, problemSnapshot: original.problemSnapshot,
        draftScopeId: scopeId, restoredFromRunId: runId });
      const draft = this.saveDraft({ problemId: run.problemId, language: run.language, code: run.code, scopeId, expectedRevision: 0 });
      this.#db.prepare('INSERT INTO draft_restorations VALUES (?, ?, ?, ?, ?)')
        .run(input.requestId, runId, attempt.id, scopeId, new Date().toISOString());
      return { draft, attempt };
    });
  }

  #readRun(id: string): StoredRun | undefined {
    const row = this.#db.prepare(`SELECT r.*, a.problem_id, a.language, a.problem_version
      FROM runs r JOIN attempts a ON a.id = r.attempt_id WHERE r.id = ?`).get(id) as Row | undefined;
    return row ? {
      id: row.id as string, attemptId: row.attempt_id as string,
      problemId: row.problem_id as string, language: row.language as Language,
      problemVersion: row.problem_version as string, code: row.code as string, codeHash: row.code_hash as string,
      testSuiteVersion: row.test_suite_version as string, testSnapshot: JSON.parse(row.test_snapshot_json as string),
      adapterVersion: row.adapter_version as string, runtimeVersion: row.runtime_version as string,
      status: row.status as RunStatus, result: JSON.parse(row.result_json as string),
      createdAt: row.created_at as string, finishedAt: row.finished_at as string | null,
    } : undefined;
  }

  saveRun(input: SaveRunInput): StoredRun {
    for (const key of ['attemptId', 'testSuiteVersion', 'adapterVersion', 'runtimeVersion'] as const) requireText(input[key], key);
    const id = input.id ?? randomUUID();
    requireText(id, 'id');
    const codeHash = hashCode(input.code);
    const status = input.status ?? 'queued';
    const result = json(input.result ?? null);
    if (status === 'queued' && result !== 'null') throw new Error('Queued run cannot contain a terminal result');
    const testSnapshot = json(input.testSnapshot ?? null);
    return this.#transaction(() => {
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error('Attempt not found');
      const existing = this.#readRun(id);
      if (existing) {
        if (existing.attemptId !== input.attemptId || existing.codeHash !== codeHash
          || existing.testSuiteVersion !== input.testSuiteVersion || json(existing.testSnapshot) !== testSnapshot
          || existing.adapterVersion !== input.adapterVersion || existing.runtimeVersion !== input.runtimeVersion
          || (status !== 'queued' && (existing.status !== status || json(existing.result) !== result))) {
          throw new Error('Run id conflicts with its immutable snapshot or result');
        }
        return existing;
      }
      if (attempt.endedAt !== null) {
        const interview = this.getInterviewForAttempt(attempt.id);
        if (!interview?.endedAt || !interview.items.some(item => item.attemptId === attempt.id && item.final?.codeHash === codeHash)) throw new Error('Cannot add a run to a finished attempt');
      }
      const now = new Date().toISOString();
      this.#db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.attemptId, input.code, codeHash, input.testSuiteVersion, testSnapshot,
          input.adapterVersion, input.runtimeVersion, status, result, now, status === 'queued' ? null : now);
      return this.#readRun(id)!;
    });
  }

  finishRun(id: string, completion: { status: TerminalStatus; result: JsonValue; runtimeVersion?: string }): StoredRun {
    if (!TERMINAL_STATUSES.includes(completion.status)) throw new Error('Invalid terminal status');
    if (completion.runtimeVersion !== undefined) requireText(completion.runtimeVersion, 'runtimeVersion');
    const result = json(completion.result);
    return this.#transaction(() => {
      const existing = this.#readRun(id);
      if (!existing) throw new Error('Run not found');
      if (existing.status !== 'queued') {
        if (existing.status === completion.status && json(existing.result) === result) return existing;
        throw new Error('Run already has a different terminal result');
      }
      this.#db.prepare('UPDATE runs SET status = ?, result_json = ?, finished_at = ?, runtime_version = ? WHERE id = ?')
        .run(completion.status, result, new Date().toISOString(), completion.runtimeVersion ?? existing.runtimeVersion, id);
      return this.#readRun(id)!;
    });
  }

  listRuns(attemptId: string): StoredRun[] {
    const ids = this.#db.prepare('SELECT id FROM runs WHERE attempt_id = ? ORDER BY rowid').all(attemptId) as Row[];
    return ids.map((row) => this.#readRun(row.id as string)!);
  }

  /** Call once after acquiring the application's single-instance lock, before starting any runner. */
  recoverInterruptedRuns(): number {
    return this.#transaction(() => Number(this.#db.prepare(`UPDATE runs SET status = 'interrupted',
      result_json = ?, finished_at = ? WHERE status = 'queued'`)
      .run(json({ reason: 'Application stopped before a terminal result was saved; code was not rerun.' }),
        new Date().toISOString()).changes));
  }

  integrityCheck(): void { checkDatabase(this.#db); }

  listCompanyDatasets(): CompanyDataset[] { return (this.#db.prepare('SELECT data_json FROM company_datasets ORDER BY rowid DESC').all() as Row[]).map(row => JSON.parse(row.data_json as string)); }
  saveCompanyDataset(dataset: CompanyDataset): CompanyDataset {
    return this.#transaction(() => {
      const existing = this.listCompanyDatasets().find(d => d.id === dataset.id); if (existing) return existing;
      for (const entry of dataset.entries) if (!this.getProblem(entry.problemId)) this.upsertProblem({ id:entry.problemId,title:entry.problemId,difficulty:'未标注',tags:[],source:entry.url?'leetcode-cn':'file',...(entry.url?{sourceUrl:entry.url}:{}),description:'',descriptionFormat:'plain',constraints:[],mode:'function',cases:[],starter:{},supportReason:'企业文件只提供题目关联；请补全题面、语言适配与公开用例。' });
      this.#db.prepare('INSERT INTO company_datasets VALUES (?, ?, ?)').run(dataset.id, dataset.fileHash, json(dataset)); return dataset;
    });
  }
  listInterviews(): InterviewSession[] { return (this.#db.prepare('SELECT data_json FROM interview_sessions ORDER BY rowid DESC').all() as Row[]).map(row => JSON.parse(row.data_json as string)); }
  getInterview(id: string): InterviewSession | null { const row = this.#db.prepare('SELECT data_json FROM interview_sessions WHERE id = ?').get(id) as Row | undefined; return row ? JSON.parse(row.data_json as string) : null; }
  getInterviewForAttempt(id: string): InterviewSession | null { const row = this.#db.prepare('SELECT session_id FROM interview_attempts WHERE attempt_id = ?').get(id) as Row | undefined; return row ? this.getInterview(row.session_id as string) : null; }
  getActiveInterview(): InterviewSession | null { const row = this.#db.prepare('SELECT data_json FROM interview_sessions WHERE ended_at IS NULL').get() as Row | undefined; return row ? JSON.parse(row.data_json as string) : null; }
  createInterview(session: InterviewSession): InterviewSession {
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT id FROM interview_sessions WHERE request_id = ?').get(session.requestId) as Row | undefined;
      if (existing) { const previous = this.getInterview(existing.id as string)!; if (json(previous.pool) !== json(session.pool)) throw new Error('面试请求标识已用于不同题池。'); return previous; }
      if (this.getActiveInterview()) throw new Error('请先结束正在进行的面试。');
      this.#db.prepare('INSERT INTO interview_sessions VALUES (?, ?, NULL, ?)').run(session.id, session.requestId, json(session));
      for (const item of session.items) {
        this.startAttempt({ id: item.attemptId, problemId: item.problem.id, language: session.pool.rules.language, problemVersion: item.problem.version, problemSnapshot: JSON.parse(JSON.stringify(item.problem.content)), mode: session.initialMode, draftScopeId: item.scopeId });
        const draft = this.saveDraft({ problemId: item.problem.id, language: session.pool.rules.language, scopeId: item.scopeId, code: item.accepted.code });
        item.accepted = { ...item.accepted, revision: draft.revision, codeHash: draft.codeHash, savedAt: draft.savedAt };
        this.#db.prepare('INSERT INTO interview_attempts VALUES (?, ?)').run(item.attemptId, session.id);
      }
      this.updateInterview(session); return session;
    });
  }
  updateInterview(session: InterviewSession): void {
    const existing = this.getInterview(session.id); if (!existing) throw new Error('面试不存在。');
    if (existing.endedAt) throw new Error('已结束的面试不可修改。');
    if (existing.requestId !== session.requestId || existing.deadlineAt !== session.deadlineAt || existing.startedAt !== session.startedAt || json(existing.pool) !== json(session.pool) || existing.initialMode !== session.initialMode) throw new Error('面试固定快照不可修改。');
    this.#db.prepare('UPDATE interview_sessions SET ended_at = ?, data_json = ? WHERE id = ?').run(session.endedAt, json(session), session.id);
  }
  freezeInterview(session: InterviewSession): InterviewSession {
    return this.#transaction(() => {
      const previous = this.getInterview(session.id); if (!previous) throw new Error('面试不存在。'); if (previous.endedAt) return previous;
      if (!session.endedAt) throw new Error('缺少面试结束时间。');
      for (const item of session.items) {
        if (!item.final) throw new Error('缺少截止快照。'); const final = item.final;
        const lastRun = this.#db.prepare('SELECT id, code_hash AS codeHash FROM runs WHERE attempt_id = ? ORDER BY rowid DESC LIMIT 1').get(item.attemptId);
        this.#db.prepare(`UPDATE attempts SET ended_at = ?, final_code = ?, final_code_hash = ?, final_draft_revision = ?, final_last_run_id = ?, last_run_matches_final = ? WHERE id = ?`)
          .run(session.endedAt, final.code, final.codeHash, final.revision, lastRun?.id ?? null, lastRun?.codeHash === final.codeHash ? 1 : 0, item.attemptId);
        this.#db.prepare('DELETE FROM active_attempts WHERE attempt_id = ?').run(item.attemptId);
        this.#learning.freezeAttemptNotes(item.attemptId, item.problem.id);
      }
      this.updateInterview(session); return session;
    });
  }

  registerAttachment(input: Attachment) { return this.#learning.registerAttachment(input); }
  getAttachment(hash: string) { return this.#learning.getAttachment(hash); }
  listAttachmentReferences() { return this.#learning.listAttachmentReferences(); }
  listAttachmentDeletionCandidates() { return this.#learning.listAttachmentDeletionCandidates(); }
  purgeAttachmentMetadataIfUnreferenced(expected: Attachment) { return this.#learning.purgeAttachmentMetadataIfUnreferenced(expected); }
  finishAttachmentDeletionCandidate(hash: string) { return this.#learning.finishAttachmentDeletionCandidate(hash); }
  saveNote(input: SaveNoteInput) { return this.#learning.saveNote(input); }
  confirmNote(input: ConfirmNoteInput) { return this.#learning.confirmNote(input); }
  deleteNote(id: string, expectedVersion: number) { return this.#learning.deleteNote(id, expectedVersion); }
  deleteNoteWithAttachmentCandidates(id: string, expectedVersion: number) { return this.#learning.deleteNoteWithAttachmentCandidates(id, expectedVersion); }
  getNote(id: string) { return this.#learning.getNote(id); }
  getNoteVersion(id: string, version: number) { return this.#learning.getNoteVersion(id, version); }
  listNotes(filter: NoteFilter = {}) { return this.#learning.listNotes(filter); }
  listNotePage(filter: NotePageFilter = {}) { return this.#learning.listNotePage(filter); }
  listNoteVersions(id: string) { return this.#learning.listNoteVersions(id); }
  getAttemptNoteVersions(attemptId: string) { return this.#learning.getAttemptNoteVersions(attemptId); }
  getLearningSettings() { return this.#learning.getLearningSettings(); }
  getLearningDashboard(month?: string, at?: string) { return this.#learning.getLearningDashboard(month, at); }
  updateLearningSettings(input: LearningSettingsInput) { return this.#learning.updateLearningSettings(input); }
  addReviewItem(input: AddReviewItemInput) { return this.#learning.addReviewItem(input); }
  getReviewItem(id: string) { return this.#learning.getReviewItem(id); }
  listReviewItems(filter: ReviewFilter = {}) { return this.#learning.listReviewItems(filter); }
  recordReview(input: ReviewFeedbackInput) { return this.#learning.recordReview(input); }
  correctReview(input: CorrectReviewInput) { return this.#learning.correctReview(input); }
  listReviewEvents(itemId: string) { return this.#learning.listReviewEvents(itemId); }
  setReviewPlan(id: string, input: { suspended?: boolean; scheduledAt?: string | null }) { return this.#learning.setReviewPlan(id, input); }
  getTodayQueue(at?: string) { return this.#learning.getTodayQueue(at); }
  recordActivity(input: ActivitySampleInput) { return this.#learning.recordActivity(input); }
  getArchiveStatistics(input: { attemptId?: string; from?: string; to?: string; timeZone?: string } = {}) { return this.#learning.getArchiveStatistics(input); }
  beginAIRequest(input: AiRequestSeed) { return this.#learning.beginAIRequest(input); }
  setAIRequestPhase(id: string, phase: 'streaming' | 'repairing') { return this.#learning.setAIRequestPhase(id, phase); }
  finishAIRequest(id: string, input: AiRequestCompletion) { return this.#learning.finishAIRequest(id, input); }
  getAIRequest(id: string) { return this.#learning.getAIRequest(id); }
  findCompletedAIRequest(hash: string) { return this.#learning.findCompletedAIRequest(hash); }
  listAIRequests(attemptId: string) { return this.#learning.listAIRequests(attemptId); }
  recoverInterruptedAIRequests() { return this.#learning.recoverInterruptedAIRequests(); }
  getAIHelpState(attemptId: string) { return this.#learning.getAIHelpState(attemptId); }
  markAIHelpShown(attemptId: string) { return this.#learning.markAIHelpShown(attemptId); }
  dismissAIHelp(attemptId: string) { return this.#learning.dismissAIHelp(attemptId); }
  markAIHelpUsed(attemptId: string, requestId: string, legacyLevel?: AiLevel) { return this.#learning.markAIHelpUsed(attemptId, requestId, legacyLevel); }

  /** Inspect the completed SQLite snapshot, never the mutable live database. Includes historical references. */
  static inspectBackupSnapshot(snapshotPath: string): BackupSnapshotInfo {
    const db = new DatabaseSync(resolve(snapshotPath), { readOnly: true });
    try {
      checkDatabase(db, [1, 2, 3, 4, 5, 6, SCHEMA_VERSION]);
      const version = (db.prepare('PRAGMA user_version').get() as Row).user_version as number;
      const mediaHashes = new Set<string>();
      for (const row of db.prepare('SELECT snapshot_json FROM problem_versions').all() as Row[]) {
        for (const match of (row.snapshot_json as string).matchAll(/algopractice:\/\/app\/media\/([a-f0-9]{64})(?![a-f0-9])/g)) mediaHashes.add(match[1]);
      }
      const learning = version >= 3 ? new LearningRepository(db, () => { throw new Error('Backup snapshot is read-only'); }) : null;
      return { schemaVersion: version, attachments: learning?.listAttachmentReferences() ?? [], mediaHashes: [...mediaHashes].sort(),
        learningSettings: learning?.getLearningSettings() ?? { ...defaultLearningSettings(), timeZone: 'UTC' } };
    } finally { db.close(); }
  }

  /** Committed SQLite snapshot; the backup service packages its referenced files. Destination must be new. */
  async backupTo(destination: string): Promise<string> {
    if (this.#closed) throw new Error('Cannot back up a closed store');
    const target = resolve(destination);
    if (target === this.dbPath || existsSync(target)) throw new Error('Backup destination must not exist');
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.partial`;
    let source: DatabaseSync | null = null;
    this.#backupsInFlight++;
    try {
      // A separate reader avoids Node 24's first-step lock error on a writing connection.
      // Pin the committed WAL snapshot so later edits cannot restart this copy.
      source = new DatabaseSync(this.dbPath, { readOnly: true });
      source.exec('PRAGMA busy_timeout = 5000; BEGIN;');
      source.prepare('SELECT rootpage FROM sqlite_schema LIMIT 1').get();
      await sqliteBackup(source, temporary);
      const verification = new DatabaseSync(temporary, { readOnly: true });
      try { checkDatabase(verification); } finally { verification.close(); }
      // Atomic publication without overwriting a file created by a concurrent request.
      linkSync(temporary, target);
      return target;
    } finally {
      try { source?.close(); } finally {
        this.#backupsInFlight--;
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
  }

  /** Restore SQLite into a fresh path; the backup service coordinates live replacement and file packages. */
  static restoreBackup(backupPath: string, destination: string): string {
    const source = resolve(backupPath);
    const target = resolve(destination);
    if (existsSync(target)) throw new Error('Restore destination must not exist');
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.partial`;
    try {
      copyFileSync(source, temporary);
      const verification = new DatabaseSync(temporary, { readOnly: true });
      try { checkDatabase(verification, [1, 2, 3, 4, 5, 6, SCHEMA_VERSION]); } finally { verification.close(); }
      linkSync(temporary, target);
      return target;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  close(): void {
    if (this.#backupsInFlight > 0) throw new Error('Cannot close while a backup is in progress');
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
}
