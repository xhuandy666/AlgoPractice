import { createHash, randomUUID } from 'node:crypto';
import { literalLike, pageBounds, pageResult, searchText } from '../storage/pagination.ts';
import type { NoteListItem, NotePageFilter, PageResult } from '../shared/learning.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ActivityDay, ActivitySample, ActivitySampleInput, ArchiveStatistics, Attachment, ProblemStruggleSignals, ReviewRating, ConfirmNoteInput, LearningSettings, LearningSettingsInput, Note, NoteDeletionResult, NoteFilter, NoteVersion, SaveNoteInput } from '../shared/learning.ts';
import type { AiHelpState, AiRequestCompletion, AiRequestRecord, AiRequestSeed, AiUsageSummary, AiUsageTotals } from '../shared/ai.ts';
import { localDate } from './fsrs.ts';
import { learningDashboard } from './dashboard.ts';
import { attemptCompletionsSql, officialAcceptedSql, trustedPassSql } from './verdicts.ts';
import type { RunStatus } from '../runner/types.ts';
import { FAILED_RUN_STATUSES } from '../ai/help-card.ts';
import { dayNumberDate, isoMsSql, localDayAt, localDaySegments, localDaySql } from './local-days.ts';

/** Run outcomes where the user's own code compiled or executed but did not pass every case. A pass against expected
 * outputs the user typed in is practice as well (see practiceRunSql): it cannot count as solving the problem, but it
 * must not earn less than a wrong answer does. */
const PRACTICE_RUN_STATUS_LIST: readonly RunStatus[] = ['completed', 'wrong_answer', 'compile_error', 'runtime_error', 'timeout', 'output_limit'];
const PRACTICE_RUN_STATUSES = PRACTICE_RUN_STATUS_LIST.map(status => `'${status}'`).join(', ');
const practiceRunSql = `(status IN (${PRACTICE_RUN_STATUSES}) OR (status = 'passed' AND expected_output_source <> 'native-samples'))`;
/** Local outcomes that are the user's code failing a check. Unlike the AI help suggestion, compile errors are left out:
 * they say little about the topic. A stored wrong_answer always had an expectation: unjudged runs end as completed. */
const STRUGGLE_RUN_STATUSES = ['wrong_answer', ...FAILED_RUN_STATUSES].map(status => `'${status}'`).join(', ');
/** Official verdicts that reject the code; compile errors, internal errors and unknown results are not counted. */
const OFFICIAL_REJECTED_STATUSES = ['wrong_answer', 'runtime_error', 'timeout', 'memory_limit', 'output_limit'].map(status => `'${status}'`).join(', ');
import { ProblemReviewRepository } from './problem-review-repository.ts';
import type { AdvanceReviewSessionInput, ProblemReviewAssessmentInput, ProblemReviewBatchInput, ProblemReviewCorrectionInput, ProblemReviewPreviewInput, ReviewAssessmentDraftInput, ReviewOpportunityFilter, ReviewPlanQuery, StartReviewSessionInput, SubmitReviewOpportunityInput } from '../shared/review-plan.ts';
import type { PageRequest } from '../shared/learning.ts';

type Row = Record<string, string | number | null>;
type Transaction = <T>(operation: () => T) => T;
const now = () => new Date().toISOString();
function text(value: unknown, name: string, max = 10000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be non-empty text within ${max} characters`);
}
function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${name}`);
}
function timestamp(value: string, name = 'timestamp'): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${name}`);
  return new Date(value).toISOString();
}
function canonical(value: unknown): string {
  const out = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('JSON numbers must be finite');
    if (typeof item === 'function' || typeof item === 'symbol') throw new Error('Unsupported JSON value');
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  });
  if (out === undefined) throw new Error('Unsupported JSON value');
  return out;
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function sha(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid SHA-256 reference'); }
function zone(value: string): void { text(value, 'time zone', 100); new Intl.DateTimeFormat('en', { timeZone: value }).format(); }
const attachmentUrlPrefix = 'algopractice://app/attachment/';
function markdownAttachmentHashes(markdown: string): string[] {
  // Keep registered URLs mentioned in code/text conservatively too; never change the Markdown itself.
  return [...new Set([...markdown.matchAll(/algopractice:\/\/app\/attachment\/([a-f0-9]{64})(?=$|[^a-zA-Z0-9_/?#%+&=.~-])/g)].map(match => match[1]))].sort();
}
function* registeredMarkdownReferences(db: DatabaseSync) {
  const exists = db.prepare('SELECT 1 FROM attachments WHERE hash = ?');
  const versions = db.prepare('SELECT note_id, version, markdown FROM note_versions WHERE instr(markdown, ?) > 0').iterate(attachmentUrlPrefix);
  for (const row of versions) for (const hash of markdownAttachmentHashes(row.markdown as string)) {
    if (exists.get(hash)) yield { noteId: row.note_id as string, version: row.version as number, hash };
  }
}
function backfillAttachmentHashReferences(db: DatabaseSync, hash: string): void {
  const insert = db.prepare('INSERT OR IGNORE INTO note_attachment_refs VALUES (?, ?, ?)');
  const versions = db.prepare('SELECT note_id, version, markdown FROM note_versions WHERE instr(markdown, ?) > 0').iterate(attachmentUrlPrefix + hash);
  for (const row of versions) if (markdownAttachmentHashes(row.markdown as string).includes(hash)) insert.run(row.note_id, row.version, hash);
}
export function defaultLearningSettings(): LearningSettings {
  return { dailyReviewBudget: 3, dailyPracticeGoal: 3, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', updatedAt: '1970-01-01T00:00:00.000Z', aiAutoAnalyzeOfficial: false };
}

/** Shares the PracticeStore connection and transaction boundary; never opens another live writer. */
export class LearningRepository {
  private db: DatabaseSync;
  private transaction: Transaction;
  private reviews: ProblemReviewRepository;
  constructor(db: DatabaseSync, transaction: Transaction, private readonly interviewMode?: (attemptId: string) => string | undefined) {
    this.db = db; this.transaction = transaction; this.reviews = new ProblemReviewRepository(db, transaction, () => this.getLearningSettings());
  }

  registerAttachment(input: Attachment): Attachment {
    sha(input.hash); text(input.name, 'attachment name', 500); text(input.mimeType, 'attachment MIME type', 200);
    integer(input.size, 'attachment size', 0, 25 * 1024 * 1024);
    const createdAt = timestamp(input.createdAt);
    return this.transaction(() => {
      const existing = this.getAttachment(input.hash);
      if (existing && existing.size !== input.size) throw new Error('Attachment hash conflicts with size');
      if (!existing) this.db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?)').run(input.hash, input.name, input.mimeType, input.size, createdAt);
      // A URL saved before its file was registered becomes a real reference at this boundary.
      backfillAttachmentHashReferences(this.db, input.hash);
      this.db.prepare('DELETE FROM attachment_deletion_candidates WHERE hash = ?').run(input.hash);
      return this.getAttachment(input.hash)!;
    });
  }
  getAttachment(hash: string): Attachment | undefined {
    const row = this.db.prepare('SELECT * FROM attachments WHERE hash = ?').get(hash) as Row | undefined;
    return row ? { hash: row.hash as string, name: row.name as string, mimeType: row.mime_type as string, size: row.size as number, createdAt: row.created_at as string } : undefined;
  }
  listAttachmentReferences(): Attachment[] {
    const hashes = new Set((this.db.prepare('SELECT DISTINCT hash FROM note_attachment_refs').all() as Row[]).map(row => row.hash as string));
    // Also scan the saved Markdown: an attachment it still mentions stays in backups even if its reference row is missing.
    for (const ref of registeredMarkdownReferences(this.db)) hashes.add(ref.hash);
    return [...hashes].sort().map(hash => this.getAttachment(hash)!);
  }
  listAttachmentDeletionCandidates(): Attachment[] {
    return (this.db.prepare('SELECT * FROM attachment_deletion_candidates ORDER BY hash').all() as Row[])
      .map(row => ({ hash: row.hash as string, name: row.name as string, mimeType: row.mime_type as string, size: row.size as number, createdAt: row.created_at as string }));
  }
  /** Call under the attachment service's file-operation lock while no backup snapshot is copying files. */
  purgeAttachmentMetadataIfUnreferenced(expected: Attachment): boolean {
    sha(expected.hash);
    return this.transaction(() => {
      const candidate = this.listAttachmentDeletionCandidates().find(value => value.hash === expected.hash);
      if (!candidate || canonical(candidate) !== canonical(expected)) return false;
      const current = this.getAttachment(expected.hash);
      if (this.db.prepare('SELECT 1 FROM note_attachment_refs WHERE hash = ? LIMIT 1').get(expected.hash)
        || (current && canonical(current) !== canonical(expected))) {
        this.db.prepare('DELETE FROM attachment_deletion_candidates WHERE hash = ?').run(expected.hash);
        return false;
      }
      if (current) this.db.prepare('DELETE FROM attachments WHERE hash = ?').run(expected.hash);
      // Keep the explicit candidate until unlink succeeds; a crash or file error must remain retryable.
      return true;
    });
  }
  finishAttachmentDeletionCandidate(hash: string): void {
    sha(hash);
    this.transaction(() => { this.db.prepare('DELETE FROM attachment_deletion_candidates WHERE hash = ?').run(hash); });
  }
  getNoteVersion(noteId: string, version: number): NoteVersion | undefined {
    const row = this.db.prepare('SELECT * FROM note_versions WHERE note_id = ? AND version = ?').get(noteId, version) as Row | undefined;
    if (!row) return undefined;
    return { noteId, version, title: row.title as string, markdown: row.markdown as string, tags: JSON.parse(row.tags_json as string),
      attachmentHashes: (this.db.prepare('SELECT hash FROM note_attachment_refs WHERE note_id = ? AND version = ? ORDER BY hash').all(noteId, version) as Row[]).map(value => value.hash as string),
      origin: row.origin as NoteVersion['origin'], state: row.state as NoteVersion['state'], aiRequestId: row.ai_request_id as string | null, createdAt: row.created_at as string };
  }
  getNote(id: string): Note | undefined {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Row | undefined;
    return row ? { id, kind: row.kind as Note['kind'], subjectId: row.subject_id as string,
      latestVersion: row.latest_version as number, confirmedVersion: row.confirmed_version as number | null,
      current: this.getNoteVersion(id, row.latest_version as number)!,
      confirmed: row.confirmed_version === null ? null : this.getNoteVersion(id, row.confirmed_version as number)!,
      createdAt: row.created_at as string, updatedAt: row.updated_at as string } : undefined;
  }
  listNoteVersions(noteId: string): NoteVersion[] {
    return (this.db.prepare('SELECT version FROM note_versions WHERE note_id = ? ORDER BY version DESC').all(noteId) as Row[])
      .map(row => this.getNoteVersion(noteId, row.version as number)!);
  }
  listNotes(filter: NoteFilter = {}): Note[] {
    const clauses: string[] = [], values: string[] = [];
    if (filter.kind) { clauses.push('n.kind = ?'); values.push(filter.kind); }
    if (filter.subjectId) { clauses.push('n.subject_id = ?'); values.push(filter.subjectId); }
    if (filter.tag) { clauses.push('EXISTS(SELECT 1 FROM note_versions v, json_each(v.tags_json) t WHERE v.note_id = n.id AND lower(t.value) = lower(?))'); values.push(filter.tag); }
    if (filter.search) { clauses.push("EXISTS(SELECT 1 FROM note_versions v WHERE v.note_id = n.id AND (v.title LIKE ? ESCAPE '\\' OR v.markdown LIKE ? ESCAPE '\\'))"); values.push(literalLike(filter.search), literalLike(filter.search)); }
    return (this.db.prepare(`SELECT n.id FROM notes n ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY n.updated_at DESC, n.id`).all(...values) as Row[])
      .map(row => this.getNote(row.id as string)!);
  }
  listNotePage(filter: NotePageFilter = {}): PageResult<NoteListItem> {
    const bounds = pageBounds(filter), clauses: string[] = [], values: string[] = [], search = searchText(filter.search);
    if (filter.confirmedOnly !== undefined && typeof filter.confirmedOnly !== 'boolean') throw new Error('Invalid confirmed-note filter');
    if (filter.confirmedOnly) clauses.push('n.confirmed_version IS NOT NULL');
    if (filter.relevantProblemId) { text(filter.relevantProblemId, 'relevant problem id', 512); clauses.push("(n.kind = 'topic' OR (n.kind = 'problem' AND n.subject_id = ?))"); values.push(filter.relevantProblemId); }

    if (filter.kind) { if (!['problem', 'topic'].includes(filter.kind)) throw new Error('Invalid note kind'); clauses.push('n.kind = ?'); values.push(filter.kind); }
    if (filter.subjectId) { clauses.push('n.subject_id = ?'); values.push(filter.subjectId); }
    if (filter.tag) { clauses.push('EXISTS(SELECT 1 FROM note_versions v, json_each(v.tags_json) t WHERE v.note_id = n.id AND lower(t.value) = lower(?))'); values.push(filter.tag); }
    if (search) { clauses.push("EXISTS(SELECT 1 FROM note_versions v WHERE v.note_id = n.id AND (v.title LIKE ? ESCAPE '\\' OR v.markdown LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(v.tags_json) tag WHERE tag.value LIKE ? ESCAPE '\\')))"); values.push(literalLike(search), literalLike(search), literalLike(search)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS total FROM notes n ${where}`).get(...values)!.total as number;
    const rows = this.db.prepare(`SELECT n.id, n.kind, n.subject_id, n.latest_version, n.confirmed_version,
      n.created_at, n.updated_at, v.title, v.tags_json, v.origin, v.state, v.ai_request_id, v.created_at AS version_created_at,
      c.title AS confirmed_title, c.tags_json AS confirmed_tags_json, c.origin AS confirmed_origin, c.state AS confirmed_state,
      c.ai_request_id AS confirmed_ai_request_id, c.created_at AS confirmed_created_at
      FROM notes n JOIN note_versions v ON v.note_id = n.id AND v.version = n.latest_version
      LEFT JOIN note_versions c ON c.note_id = n.id AND c.version = n.confirmed_version ${where}
      ORDER BY n.updated_at DESC, n.id LIMIT ? OFFSET ?`).all(...values, bounds.limit, bounds.offset) as Row[];
    return pageResult(rows.map(row => ({ id: row.id as string, kind: row.kind as Note['kind'], subjectId: row.subject_id as string,
      latestVersion: row.latest_version as number, confirmedVersion: row.confirmed_version as number | null,
      createdAt: row.created_at as string, updatedAt: row.updated_at as string,
      current: { noteId: row.id as string, version: row.latest_version as number, title: row.title as string,
        tags: JSON.parse(row.tags_json as string), origin: row.origin as NoteVersion['origin'], state: row.state as NoteVersion['state'],
        aiRequestId: row.ai_request_id as string | null, createdAt: row.version_created_at as string },
      confirmed: row.confirmed_version === null ? null : { noteId: row.id as string, version: row.confirmed_version as number,
        title: row.confirmed_title as string, tags: JSON.parse(row.confirmed_tags_json as string), origin: row.confirmed_origin as NoteVersion['origin'],
        state: row.confirmed_state as NoteVersion['state'], aiRequestId: row.confirmed_ai_request_id as string | null, createdAt: row.confirmed_created_at as string } })), total, bounds);
  }

  saveNote(input: SaveNoteInput): Note {
    text(input.requestId, 'request id', 200); text(input.subjectId, 'note subject', 200); text(input.title, 'note title', 500);
    if (!['problem', 'topic'].includes(input.kind)) throw new Error('Invalid note kind');
    if (typeof input.markdown !== 'string' || input.markdown.length > 1_000_000) throw new Error('Note markdown exceeds the supported size');
    const origin = input.origin ?? 'user', state = input.state ?? 'draft';
    if (!['user', 'ai'].includes(origin) || !['draft', 'confirmed'].includes(state)) throw new Error('Invalid note origin or state');
    if (origin === 'ai' && state !== 'draft') throw new Error('AI notes must first be saved as drafts and explicitly confirmed');
    const tags = [...new Set((input.tags ?? []).map(tag => { text(tag, 'tag', 100); return tag.trim(); }))].sort();
    if (tags.length > 50) throw new Error('Too many tags');
    const attachmentHashes = [...new Set(input.attachmentHashes ?? [])].sort();
    if (attachmentHashes.length > 100) throw new Error('Too many attachments');
    attachmentHashes.forEach(sha);
    if (input.expectedVersion !== undefined) integer(input.expectedVersion, 'expected note version');
    const normalized = { ...input, origin, state, tags, attachmentHashes };
    const requestHash = hash(normalized);
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM note_requests WHERE request_id = ?').get(input.requestId) as Row | undefined;
      if (prior) { if (prior.input_hash !== requestHash) throw new Error('Note request id conflicts with different input'); return this.getNote(prior.note_id as string)!; }
      const previous = input.noteId ? this.getNote(input.noteId) : undefined;
      if (input.noteId && !previous) throw new Error('Note not found');
      if (previous && (previous.kind !== input.kind || previous.subjectId !== input.subjectId)) throw new Error('Note identity is immutable');
      if (previous ? input.expectedVersion !== previous.latestVersion : input.expectedVersion !== undefined && input.expectedVersion !== 0) throw new Error('Note version conflict');
      if (input.kind === 'problem' && !this.db.prepare('SELECT 1 FROM problems WHERE id = ?').get(input.subjectId)) throw new Error('Problem not found');
      for (const attachment of attachmentHashes) if (!this.getAttachment(attachment)) throw new Error('Attachment must be written and registered before saving a note');
      const resolvedAttachments = [...new Set([...attachmentHashes, ...markdownAttachmentHashes(input.markdown).filter(hash => this.getAttachment(hash))])].sort();
      if (resolvedAttachments.length > 100) throw new Error('Too many attachments');
      if (input.aiRequestId) {
        const request = this.getAIRequest(input.aiRequestId);
        if (!request || request.status !== 'completed' || (input.kind === 'problem' && request.snapshot.problemId !== input.subjectId)) throw new Error('AI note request does not match the note');
      }
      const id = previous?.id ?? randomUUID(), at = now(), version = (previous?.latestVersion ?? 0) + 1;
      if (!previous) this.db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, NULL, ?, ?)').run(id, input.kind, input.subjectId, version, at, at);
      this.appendNoteVersion({ noteId: id, version, title: input.title, markdown: input.markdown, tags, attachmentHashes: resolvedAttachments, origin, state, aiRequestId: input.aiRequestId ?? null, createdAt: at });
      this.db.prepare('INSERT INTO note_requests VALUES (?, ?, ?, ?)').run(input.requestId, requestHash, id, version);
      return this.getNote(id)!;
    });
  }
  private appendNoteVersion(version: NoteVersion): void {
    this.db.prepare('INSERT INTO note_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(version.noteId, version.version, version.title,
      version.markdown, canonical(version.tags), version.origin, version.state, version.aiRequestId, version.createdAt);
    for (const hash of version.attachmentHashes) this.db.prepare('INSERT INTO note_attachment_refs VALUES (?, ?, ?)').run(version.noteId, version.version, hash);
    this.db.prepare('UPDATE notes SET latest_version = ?, confirmed_version = CASE WHEN ? = \'confirmed\' THEN ? ELSE confirmed_version END, updated_at = ? WHERE id = ?')
      .run(version.version, version.state, version.version, version.createdAt, version.noteId);
  }
  confirmNote(input: ConfirmNoteInput): Note {
    text(input.requestId, 'request id', 200); integer(input.version, 'note version', 1); integer(input.expectedVersion, 'expected note version', 1);
    return this.transaction(() => {
      const requestHash = hash({ operation: 'confirm', ...input });
      const prior = this.db.prepare('SELECT * FROM note_requests WHERE request_id = ?').get(input.requestId) as Row | undefined;
      if (prior) { if (prior.input_hash !== requestHash) throw new Error('Note request id conflicts with different input'); return this.getNote(prior.note_id as string)!; }
      const note = this.getNote(input.noteId), selected = this.getNoteVersion(input.noteId, input.version);
      if (!note || !selected) throw new Error('Note version not found');
      if (note.latestVersion !== input.expectedVersion || input.version !== input.expectedVersion) throw new Error('Note version conflict; confirm the current draft');
      const version = note.latestVersion + 1;
      this.appendNoteVersion({ ...selected, version, state: 'confirmed', createdAt: now() });
      this.db.prepare('INSERT INTO note_requests VALUES (?, ?, ?, ?)').run(input.requestId, requestHash, note.id, version);
      return this.getNote(note.id)!;
    });
  }
  deleteNote(noteId: string, expectedVersion: number): boolean {
    return this.deleteNoteWithAttachmentCandidates(noteId, expectedVersion).deleted;
  }
  deleteNoteWithAttachmentCandidates(noteId: string, expectedVersion: number): NoteDeletionResult {
    integer(expectedVersion, 'expected note version', 1);
    return this.transaction(() => { const note = this.getNote(noteId); if (!note) return { deleted: false, attachments: [] };
      if (note.latestVersion !== expectedVersion) throw new Error('Note version conflict');
      const hashes = this.db.prepare('SELECT DISTINCT hash FROM note_attachment_refs WHERE note_id = ? ORDER BY hash').all(noteId) as Row[];
      this.db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
      const attachments: Attachment[] = [];
      for (const { hash } of hashes) {
        if (this.db.prepare('SELECT 1 FROM note_attachment_refs WHERE hash = ? LIMIT 1').get(hash)) continue;
        const attachment = this.getAttachment(hash as string)!;
        this.db.prepare('INSERT OR IGNORE INTO attachment_deletion_candidates VALUES (?, ?, ?, ?, ?)')
          .run(attachment.hash, attachment.name, attachment.mimeType, attachment.size, attachment.createdAt);
        attachments.push(attachment);
      }
      return { deleted: true, attachments };
    });
  }
  /** Part of PracticeStore's single archive-deletion transaction. Independent learning content stays intact. */
  detachAndDeleteAttemptData(attemptId: string): void {
    this.db.prepare('UPDATE note_versions SET ai_request_id = NULL WHERE ai_request_id IN (SELECT id FROM ai_requests WHERE attempt_id = ?)').run(attemptId);
    this.db.prepare(`UPDATE ai_requests SET cached_from_request_id = NULL
      WHERE attempt_id <> ? AND cached_from_request_id IN (SELECT id FROM ai_requests WHERE attempt_id = ?)`).run(attemptId, attemptId);
    this.db.prepare('DELETE FROM ai_help_state WHERE attempt_id = ?').run(attemptId);
    this.db.prepare('DELETE FROM activity_samples WHERE attempt_id = ?').run(attemptId);
    this.db.prepare('DELETE FROM ai_requests WHERE attempt_id = ?').run(attemptId);
    this.db.prepare('DELETE FROM attempt_note_versions WHERE attempt_id = ?').run(attemptId);
  }
  freezeAttemptNotes(attemptId: string, problemId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO attempt_note_versions SELECT ?, id, confirmed_version FROM notes
      WHERE kind = 'problem' AND subject_id = ? AND confirmed_version IS NOT NULL`).run(attemptId, problemId);
  }
  getAttemptNoteVersions(attemptId: string): NoteVersion[] {
    return (this.db.prepare('SELECT note_id, version FROM attempt_note_versions WHERE attempt_id = ? ORDER BY note_id').all(attemptId) as Row[])
      .map(row => this.getNoteVersion(row.note_id as string, row.version as number)!);
  }

  getLearningSettings(): LearningSettings {
    const row = this.db.prepare('SELECT value_json FROM learning_settings WHERE id = 1').get() as Row | undefined;
    // A new optional JSON setting needs no table migration or rewrite of existing learning records.
    return row ? { ...defaultLearningSettings(), ...JSON.parse(row.value_json as string) } : defaultLearningSettings();
  }
  updateLearningSettings(input: LearningSettingsInput): LearningSettings {
    if (Object.keys(input).some(key => !['dailyReviewBudget', 'dailyPracticeGoal', 'timeZone', 'aiAutoAnalyzeOfficial'].includes(key))) throw new Error('Unknown learning setting');
    if (input.dailyReviewBudget !== undefined && input.dailyReviewBudget !== null) integer(input.dailyReviewBudget, 'daily review budget', 0, 1000);
    if (input.dailyPracticeGoal !== undefined) integer(input.dailyPracticeGoal, 'daily practice goal', 1, 1000);
    if (input.timeZone !== undefined) zone(input.timeZone);
    if (input.aiAutoAnalyzeOfficial !== undefined && typeof input.aiAutoAnalyzeOfficial !== 'boolean') throw new Error('Invalid AI automatic analysis setting');
    return this.transaction(() => {
      const settings = { ...this.getLearningSettings(), ...input, updatedAt: now() };
      this.db.prepare('INSERT INTO learning_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json').run(canonical(settings));
      return settings;
    });
  }
  /** Reviews due today (the reminder's count), from the same snapshot as the review plan. */
  dueReviewCount(at = now()): number { return this.reviews.getReviewPlanSnapshot({ view: 'today', limit: 1 }, timestamp(at)).summary.dueCount; }
  addProblemReview(problemId: string, at?: string) { return this.reviews.addProblemReview(problemId, at); }
  addProblemReviews(input: { problemIds: string[] }) { return this.reviews.addProblemReviews(input); }
  getProblemReview(problemId: string) { return this.reviews.getProblemReview(problemId); }
  listProblemReviews() { return this.reviews.listProblemReviews(); }
  updateProblemReviews(input: ProblemReviewBatchInput) { return this.reviews.updateProblemReviews(input); }
  getReviewPlanSnapshot(query: ReviewPlanQuery = {}, at?: string) { return this.reviews.getReviewPlanSnapshot(query, at); }
  getProblemReviewDetail(problemId: string, history: PageRequest = {}) { return this.reviews.getProblemReviewDetail(problemId, history); }
  recordProblemReview(input: ProblemReviewAssessmentInput, at?: string) { return this.reviews.recordProblemReview(input, at); }
  correctProblemReview(input: ProblemReviewCorrectionInput) { return this.reviews.correctProblemReview(input); }
  previewProblemReview(input: ProblemReviewPreviewInput, at?: string) { return this.reviews.previewProblemReview(input, at); }
  getProblemReviewRequest(requestId: string) { return this.reviews.getProblemReviewRequest(requestId); }
  registerReviewAccepted(localRecordId: string) { return this.reviews.registerReviewAccepted(localRecordId); }
  reviewOpportunities(filter: ReviewOpportunityFilter = {}) { return this.reviews.reviewOpportunities(filter); }
  getReviewOpportunityForSubmission(localRecordId: string) { return this.reviews.getReviewOpportunityForSubmission(localRecordId); }
  claimReviewOpportunity(id: string, at?: string) { return this.reviews.claimReviewOpportunity(id, at); }
  skipReviewOpportunity(id: string) { return this.reviews.skipReviewOpportunity(id); }
  submitReviewOpportunity(input: SubmitReviewOpportunityInput) { return this.reviews.submitReviewOpportunity(input); }
  detachReviewAttempt(id: string) { this.reviews.detachReviewAttempt(id); }
  getReviewAssessmentDraft(key: string) { return this.reviews.getReviewAssessmentDraft(key); }
  saveReviewAssessmentDraft(input: ReviewAssessmentDraftInput) { return this.reviews.saveReviewAssessmentDraft(input); }
  deleteReviewAssessmentDraft(key: string, expectedRevision?: number) { this.reviews.deleteReviewAssessmentDraft(key, expectedRevision); }
  startReviewSession(input: StartReviewSessionInput) { return this.reviews.startReviewSession(input); }
  getReviewSession(id?: string) { return this.reviews.getReviewSession(id); }
  advanceReviewSession(input: AdvanceReviewSessionInput) { return this.reviews.advanceReviewSession(input); }
  endReviewSession(id: string) { return this.reviews.endReviewSession(id); }

  /** Effective practice time recorded for one attempt (the workbench timer's starting point). */
  attemptActiveMs(attemptId: string): number {
    text(attemptId, 'attempt id', 200);
    return Number((this.db.prepare('SELECT COALESCE(SUM(duration_ms), 0) AS total FROM activity_samples WHERE attempt_id = ?').get(attemptId) as Row).total);
  }
  recordActivity(input: ActivitySampleInput): ActivitySample {
    text(input.requestId, 'activity request id', 200); integer(input.durationMs, 'activity duration', 0, 30000);
    const occurredAt = timestamp(input.occurredAt);
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM activity_samples WHERE request_id = ?').get(input.requestId) as Row | undefined;
      if (prior) {
        if (prior.attempt_id !== input.attemptId || prior.duration_ms !== input.durationMs || prior.occurred_at !== occurredAt) throw new Error('Activity request id conflicts with different input');
        return { id: prior.id as string, requestId: input.requestId, attemptId: input.attemptId, durationMs: input.durationMs, occurredAt, createdAt: prior.created_at as string };
      }
      const attempt = this.db.prepare('SELECT started_at, ended_at FROM attempts WHERE id = ?').get(input.attemptId) as Row | undefined;
      if (!attempt) throw new Error('Attempt not found');
      if (occurredAt < (attempt.started_at as string) || (attempt.ended_at !== null && occurredAt > (attempt.ended_at as string))) throw new Error('Activity sample is outside the attempt');
      const sample = { ...input, id: randomUUID(), occurredAt, createdAt: now() };
      this.db.prepare('INSERT INTO activity_samples VALUES (?, ?, ?, ?, ?, ?)').run(sample.id, input.requestId, input.attemptId, input.durationMs, occurredAt, sample.createdAt);
      return sample;
    });
  }
  getLearningDashboard(at = now()) {
    return learningDashboard(this.db, this.getLearningSettings(), timestamp(at));
  }
  /** Current-state struggle signals for every problem that still has a practice archive (deleting an archive removes
   * its runs, official results and AI requests, so they stop counting). Tags and title come from the library head. */
  listProblemStruggleSignals(): ProblemStruggleSignals[] {
    const rows = this.db.prepare(`WITH practiced AS (SELECT DISTINCT problem_id FROM attempts),
      local AS (SELECT a.problem_id, SUM(${trustedPassSql('r')}) AS passed, SUM(r.status IN (${STRUGGLE_RUN_STATUSES})) AS failed
        FROM runs r JOIN attempts a ON a.id = r.attempt_id GROUP BY a.problem_id),
      official AS (SELECT a.problem_id, SUM(json_extract(s.result_json, '$.status') = 'accepted') AS accepted,
        SUM(json_extract(s.result_json, '$.status') IN (${OFFICIAL_REJECTED_STATUSES})) AS rejected
        FROM official_submissions s JOIN attempts a ON a.id = s.attempt_id WHERE s.status = 'completed' GROUP BY a.problem_id),
      helps AS (SELECT a.problem_id, COUNT(*) AS helps FROM ai_requests q JOIN attempts a ON a.id = q.attempt_id
        WHERE q.status = 'completed' AND json_extract(q.snapshot_json, '$.kind') IN ('hint', 'diagnosis', 'chat') GROUP BY a.problem_id),
      ratings AS (SELECT problem_id, effective_rating FROM (SELECT problem_id, effective_rating,
        ROW_NUMBER() OVER (PARTITION BY problem_id ORDER BY observed_at DESC, sequence DESC) AS position FROM problem_review_effective_events) WHERE position = 1)
      SELECT p.problem_id AS problem_id, COALESCE(json_extract(v.snapshot_json, '$.title'), p.problem_id) AS title,
        COALESCE(json_extract(v.snapshot_json, '$.tags'), '[]') AS tags_json, COALESCE(l.passed, 0) AS passed, COALESCE(l.failed, 0) AS failed,
        COALESCE(o.accepted, 0) AS accepted, COALESCE(o.rejected, 0) AS rejected, COALESCE(h.helps, 0) AS helps, r.effective_rating AS rating
      FROM practiced p LEFT JOIN library_problem_heads head ON head.problem_id = p.problem_id
        LEFT JOIN problem_versions v ON v.problem_id = head.problem_id AND v.version = head.version
        LEFT JOIN local l ON l.problem_id = p.problem_id LEFT JOIN official o ON o.problem_id = p.problem_id
        LEFT JOIN helps h ON h.problem_id = p.problem_id LEFT JOIN ratings r ON r.problem_id = p.problem_id
      ORDER BY p.problem_id`).all() as Row[];
    return rows.map(row => {
      let tags: unknown = []; try { tags = JSON.parse(String(row.tags_json)); } catch { tags = []; }
      return { problemId: String(row.problem_id), title: String(row.title), tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
        passedRuns: Number(row.passed), failedRuns: Number(row.failed), officialAccepted: Number(row.accepted), officialRejected: Number(row.rejected),
        aiHelps: Number(row.helps), rating: row.rating === null ? null : Number(row.rating) as ReviewRating };
    });
  }
  getArchiveStatistics(input: { attemptId?: string; from?: string; to?: string; timeZone?: string } = {}): ArchiveStatistics {
    const timeZone = input.timeZone ?? this.getLearningSettings().timeZone; zone(timeZone);
    const from = input.from ? timestamp(input.from) : '', to = input.to ? timestamp(input.to) : '9999';
    const days = new Map<string, ActivityDay>();
    const day = (date: string) => { if (!days.has(date)) days.set(date, { date, activeMs: 0, attempts: 0, completedProblems: 0, runs: 0, passedRuns: 0, practiceRuns: 0, officialAccepted: 0, reviewCount: 0 }); return days.get(date)!; };
    const condition = input.attemptId ? ' AND attempt_id = ?' : '', args = input.attemptId ? [from, to, input.attemptId] : [from, to];
    const attemptCondition = input.attemptId ? ' AND id = ?' : '';
    let activeMs = 0, attempts = 0, runs = 0, passedRuns = 0;
    const activityWhere = `occurred_at >= ? AND occurred_at <= ?${condition}`;
    // Official results live with their attempt, so deleting an archive removes them exactly like its local runs.
    const officialWhere = `${officialAcceptedSql('s')}
      AND s.finished_at >= ? AND s.finished_at <= ?${input.attemptId ? ' AND s.attempt_id = ?' : ''}`;
    // Local dates are bucketed inside SQLite from precomputed day segments (local-days.ts). A JavaScript callback per
    // row kept the main process busy for about a second per 100k focus samples, and statistics refresh every minute.
    const extent = this.db.prepare(`SELECT MIN(low) AS low, MAX(high) AS high FROM (
      SELECT MIN(occurred_at) AS low, MAX(occurred_at) AS high FROM activity_samples WHERE ${activityWhere}
      UNION ALL SELECT MIN(started_at), MAX(started_at) FROM attempts WHERE started_at >= ? AND started_at <= ?${attemptCondition}
      UNION ALL SELECT MIN(ended_at), MAX(ended_at) FROM attempts WHERE ended_at IS NOT NULL AND ended_at >= ? AND ended_at <= ?${attemptCondition}
      UNION ALL SELECT MIN(created_at), MAX(created_at) FROM runs WHERE created_at >= ? AND created_at <= ?${condition}
      UNION ALL SELECT MIN(s.finished_at), MAX(s.finished_at) FROM official_submissions s WHERE ${officialWhere})`).get(...args, ...args, ...args, ...args, ...args) as Row;
    if (extent.low !== null) {
      const segments = localDaySegments(Date.parse(String(extent.low)), Date.parse(String(extent.high)), timeZone);
      const byDay = localDaySql('ms', segments).day, last = localDaySql('last_at', segments);
      const date = (value: unknown) => { if (typeof value !== 'number') throw new Error('统计日期映射不完整。'); return dayNumberDate(value); };
      // "LIMIT -1" keeps SQLite from flattening the timestamp subquery into every CASE branch, which would parse
      // each timestamp once per reference instead of once per row.
      const timestamps = (column: string, rest: string) => `(SELECT ${isoMsSql(column)} AS ms${rest} LIMIT -1)`;
      // A pulse describes [end-duration, end), so exactly-midnight samples belong to yesterday. A pulse that crosses
      // midnight gives the part before it to the previous local day: pulses last at most 30 s and every non-empty
      // local day is far longer, so that day is the one containing the instant just before the boundary.
      for (const row of this.db.prepare(`SELECT day, MIN(last_start) - 1 AS before_start, SUM(duration - previous) AS duration, SUM(previous) AS carried FROM (
          SELECT ${last.day} AS day, ${last.dayStart} AS last_start, duration, MAX(0, ${last.dayStart} - first_at) AS previous
          FROM (SELECT ms - (duration > 0) AS last_at, ms - duration AS first_at, duration FROM ${timestamps('occurred_at', `, duration_ms AS duration
            FROM activity_samples WHERE ${activityWhere}`)} LIMIT -1)) GROUP BY day`).all(...args) as Row[]) {
        activeMs += (row.duration as number) + (row.carried as number); day(date(row.day)).activeMs += row.duration as number;
        if ((row.carried as number) > 0) day(date(localDayAt(row.before_start as number, segments))).activeMs += row.carried as number;
      }
      for (const row of this.db.prepare(`SELECT ${byDay} AS day, COUNT(*) AS count FROM ${timestamps('started_at', `
        FROM attempts WHERE started_at >= ? AND started_at <= ?${attemptCondition}`)} GROUP BY day`).all(...args) as Row[]) {
        attempts += row.count as number; day(date(row.day)).attempts = row.count as number;
      }
      // Completion instants are run, official or end times of these attempts, all inside the extent above.
      for (const row of this.db.prepare(`SELECT ${byDay} AS day, COUNT(DISTINCT problem_id) AS count FROM ${timestamps('completed_at', `, problem_id
        FROM (${attemptCompletionsSql(input.attemptId ? 'a.id = ?' : '')}) WHERE completed_at >= ? AND completed_at <= ?`)} GROUP BY day`)
        .all(...(input.attemptId ? [input.attemptId, from, to] : [from, to])) as Row[]) {
        day(date(row.day)).completedProblems = row.count as number;
      }
      for (const row of this.db.prepare(`SELECT ${byDay} AS day, COUNT(*) AS count, SUM(${trustedPassSql()}) AS passed,
        SUM(${practiceRunSql}) AS practiced FROM ${timestamps('created_at', `, status, expected_output_source
        FROM runs WHERE created_at >= ? AND created_at <= ?${condition}`)} GROUP BY day`).all(...args) as Row[]) {
        runs += row.count as number; passedRuns += row.passed as number;
        Object.assign(day(date(row.day)), { runs: row.count as number, passedRuns: row.passed as number, practiceRuns: row.practiced as number });
      }
      for (const row of this.db.prepare(`SELECT ${byDay} AS day, COUNT(DISTINCT problem_id) AS count FROM ${timestamps('s.finished_at', `, a.problem_id
        FROM official_submissions s JOIN attempts a ON a.id = s.attempt_id WHERE ${officialWhere}`)} GROUP BY day`).all(...args) as Row[]) {
        day(date(row.day)).officialAccepted = row.count as number;
      }
    }
    const solved = this.db.prepare(`SELECT COUNT(*) AS solved, COALESCE(SUM(official), 0) AS official FROM (
      SELECT problem_id, MAX(official) AS official FROM (
        SELECT a.problem_id, 0 AS official FROM runs r JOIN attempts a ON a.id = r.attempt_id
          WHERE ${trustedPassSql('r')} AND r.created_at >= ? AND r.created_at <= ?${input.attemptId ? ' AND r.attempt_id = ?' : ''}
        UNION ALL
        SELECT a.problem_id, 1 AS official FROM official_submissions s JOIN attempts a ON a.id = s.attempt_id WHERE ${officialWhere}
      ) GROUP BY problem_id)`).get(...args, ...args)!;
    for (const row of this.db.prepare(`SELECT learning_date AS date, COUNT(DISTINCT problem_id) AS count
      FROM problem_review_effective_events WHERE is_initial=0 AND observed_at>=? AND observed_at<=?${condition} GROUP BY learning_date`).all(...args) as Row[]) day(row.date as string).reviewCount = row.count as number;
    const reviewedItems = this.db.prepare(`SELECT COUNT(DISTINCT problem_id) AS count FROM problem_review_effective_events
      WHERE is_initial=0 AND observed_at>=? AND observed_at<=?${condition}`).get(...args)!.count as number;
    return { activeMs, attempts, runs, passedRuns, reviewedItems, solvedProblems: solved.solved as number, officialSolvedProblems: solved.official as number,
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  }

  private aiRecord(row: Row): AiRequestRecord {
    return { id: row.id as string, attemptId: row.attempt_id as string, requestHash: row.request_hash as string, snapshot: JSON.parse(row.snapshot_json as string),
      status: row.status as AiRequestRecord['status'], response: JSON.parse(row.response_json as string), error: JSON.parse(row.error_json as string), usage: JSON.parse(row.usage_json as string),
      cachedFromRequestId: row.cached_from_request_id as string | null, createdAt: row.created_at as string, finishedAt: row.finished_at as string | null };
  }
  getAIRequest(id: string): AiRequestRecord | null { const row = this.db.prepare('SELECT * FROM ai_requests WHERE id = ?').get(id) as Row | undefined; return row ? this.aiRecord(row) : null; }
  findCompletedAIRequest(requestHash: string): AiRequestRecord | null {
    const row = this.db.prepare("SELECT * FROM ai_requests WHERE request_hash = ? AND status = 'completed' ORDER BY rowid DESC LIMIT 1").get(requestHash) as Row | undefined;
    return row ? this.aiRecord(row) : null;
  }
  listAIRequests(attemptId: string): AiRequestRecord[] { return (this.db.prepare('SELECT * FROM ai_requests WHERE attempt_id = ? ORDER BY rowid').all(attemptId) as Row[]).map(row => this.aiRecord(row)); }
  beginAIRequest(input: AiRequestSeed): AiRequestRecord {
    text(input.id, 'AI request id', 200); sha(input.requestHash);
    const snapshot = canonical(input.snapshot);
    if (snapshot.length > 2_000_000) throw new Error('AI request context is too large');
    const providerKeys = ['id', 'baseUrl', 'model', 'temperature', 'maxOutputTokens', 'timeoutMs', 'jsonMode', 'includeUsage', 'compatibility'];
    if (Object.keys(input.snapshot.provider).some(key => !providerKeys.includes(key))) throw new Error('Credentials or unknown fields cannot be stored in provider configuration');
    const compatibility = input.snapshot.provider.compatibility;
    if (compatibility !== undefined && !['openai-compatible', 'deepseek', 'glm', 'qwen'].includes(compatibility)) throw new Error('Invalid AI provider compatibility');
    return this.transaction(() => {
      const prior = this.getAIRequest(input.id);
      if (prior) { if (prior.attemptId !== input.attemptId || prior.requestHash !== input.requestHash || canonical(prior.snapshot) !== snapshot) throw new Error('AI request id conflicts with different input'); return prior; }
      const attempt = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(input.attemptId) as Row | undefined;
      if (!attempt || input.snapshot.attemptId !== input.attemptId || input.snapshot.problemId !== attempt.problem_id || input.snapshot.problemVersion !== attempt.problem_version
        || input.snapshot.language !== attempt.language || input.snapshot.mode !== (this.interviewMode?.(input.attemptId) ?? attempt.mode)) throw new Error('AI snapshot does not match the persisted attempt');
      if (createHash('sha256').update(input.snapshot.code).digest('hex') !== input.snapshot.codeHash) throw new Error('AI code snapshot hash mismatch');
      this.db.prepare("INSERT INTO ai_requests VALUES (?, ?, ?, ?, 'pending', 'null', 'null', 'null', NULL, ?, NULL)")
        .run(input.id, input.attemptId, input.requestHash, snapshot, now());
      return this.getAIRequest(input.id)!;
    });
  }
  setAIRequestPhase(id: string, phase: 'streaming' | 'repairing'): AiRequestRecord {
    if (!['streaming', 'repairing'].includes(phase)) throw new Error('Invalid AI phase');
    return this.transaction(() => { const request = this.getAIRequest(id); if (!request) throw new Error('AI request not found');
      if (request.finishedAt || request.status === phase || request.status === 'repairing') return request;
      this.db.prepare('UPDATE ai_requests SET status = ? WHERE id = ?').run(phase, id); return this.getAIRequest(id)!;
    });
  }
  finishAIRequest(id: string, completion: AiRequestCompletion): AiRequestRecord {
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(completion.status)) throw new Error('Invalid AI terminal status');
    if (completion.status === 'completed' ? completion.response === null || completion.error !== null : completion.response !== null || completion.error === null) throw new Error('AI completion must contain a response or structured error');
    return this.transaction(() => { const request = this.getAIRequest(id); if (!request) throw new Error('AI request not found');
      if (request.finishedAt) {
        if (canonical({ status: request.status, response: request.response, error: request.error, usage: request.usage, cachedFromRequestId: request.cachedFromRequestId }) !== canonical(completion)) throw new Error('AI request already has a different terminal result');
        return request;
      }
      // The service refuses help during an active strict interview before it gets here; the store refuses it as well.
      if (completion.status === 'completed' && request.snapshot.mode === 'strict' && request.snapshot.isActive) throw new Error('An active strict interview cannot complete an AI request');
      if (completion.cachedFromRequestId) { const cached = this.getAIRequest(completion.cachedFromRequestId);
        if (!cached || cached.status !== 'completed' || cached.requestHash !== request.requestHash || canonical(cached.response) !== canonical(completion.response)) throw new Error('AI cache reference does not match completed request'); }
      this.db.prepare('UPDATE ai_requests SET status = ?, response_json = ?, error_json = ?, usage_json = ?, cached_from_request_id = ?, finished_at = ? WHERE id = ?')
        .run(completion.status, canonical(completion.response), canonical(completion.error), canonical(completion.usage), completion.cachedFromRequestId, now(), id);
      return this.getAIRequest(id)!;
    });
  }
  recoverInterruptedAIRequests(): number {
    return this.transaction(() => Number(this.db.prepare("UPDATE ai_requests SET status = 'interrupted', error_json = ?, finished_at = ? WHERE status IN ('pending','streaming','repairing')")
      .run(canonical({ code: 'INTERRUPTED', message: 'Application stopped before the AI request finished; no request was repeated.', retryable: true }), now()).changes));
  }
  /** Provider-reported usage of finished requests by day and month of the learning time zone (see AiUsageSummary). */
  getAIUsageSummary(at = now()): AiUsageSummary {
    const timeZone = this.getLearningSettings().timeZone, today = localDate(at, timeZone), month = today.slice(0, 7);
    const empty = (): AiUsageTotals => ({ requests: 0, calls: 0, tokens: 0, unreported: 0 });
    const summary: AiUsageSummary = { timeZone, today: empty(), month: empty(), all: empty(), monthByModel: [] };
    const models = new Map<string, AiUsageTotals>();
    const add = (totals: AiUsageTotals, calls: number, tokens: number | null) => {
      totals.requests++; totals.calls += calls; if (tokens === null) totals.unreported++; else totals.tokens += tokens;
    };
    for (const row of this.db.prepare(`SELECT created_at, json_extract(snapshot_json, '$.provider.model') AS model,
        json_extract(usage_json, '$.calls') AS calls, json_extract(usage_json, '$.totalTokens') AS tokens
      FROM ai_requests WHERE finished_at IS NOT NULL AND created_at <= ?`).all(at) as Row[]) {
      const day = localDate(String(row.created_at), timeZone), calls = Number(row.calls ?? 0), tokens = row.tokens === null ? null : Number(row.tokens);
      add(summary.all, calls, tokens);
      if (day === today) add(summary.today, calls, tokens);
      if (day.slice(0, 7) !== month) continue;
      add(summary.month, calls, tokens);
      const model = typeof row.model === 'string' && row.model ? row.model : '未知模型';
      if (!models.has(model)) models.set(model, empty());
      add(models.get(model)!, calls, tokens);
    }
    summary.monthByModel = [...models].map(([model, totals]) => ({ model, ...totals })).sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
    return summary;
  }
  getAIHelpState(attemptId: string): AiHelpState {
    const row = this.db.prepare('SELECT * FROM ai_help_state WHERE attempt_id = ?').get(attemptId) as Row | undefined;
    return { automaticShownAt: row?.automatic_shown_at as string | null ?? null, dismissedAt: row?.dismissed_at as string | null ?? null };
  }
  markAIHelpShown(attemptId: string): boolean {
    return this.transaction(() => { const attempt = this.db.prepare('SELECT mode FROM attempts WHERE id = ?').get(attemptId) as Row | undefined;
      if (!attempt) throw new Error('Attempt not found'); if (attempt.mode === 'strict') return false;
      const state = this.getAIHelpState(attemptId); if (state.automaticShownAt || state.dismissedAt) return false;
      this.db.prepare('INSERT INTO ai_help_state VALUES (?, ?, NULL) ON CONFLICT(attempt_id) DO UPDATE SET automatic_shown_at = excluded.automatic_shown_at').run(attemptId, now()); return true;
    });
  }
  dismissAIHelp(attemptId: string): void {
    this.transaction(() => { this.db.prepare('INSERT INTO ai_help_state VALUES (?, NULL, ?) ON CONFLICT(attempt_id) DO UPDATE SET dismissed_at = COALESCE(dismissed_at, excluded.dismissed_at)').run(attemptId, now()); });
  }
}
