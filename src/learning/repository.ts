import { createHash, randomUUID } from 'node:crypto';
import { pageBounds, pageResult, searchText, SQL_TRIM_WHITESPACE } from '../storage/pagination.ts';
import type { NoteListItem, NotePageFilter, PageResult } from '../shared/learning.ts';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ActivityDay, ActivitySample, ActivitySampleInput, AddReviewItemInput, ArchiveStatistics, Attachment,
  ConfirmNoteInput, CorrectReviewInput, LearningSettings, LearningSettingsInput, Note, NoteDeletionResult, NoteFilter, NoteVersion, ReviewEvent,
  ReviewFeedbackInput, ReviewFeedbackResult, ReviewFilter, ReviewItem, SaveNoteInput, TodayQueue,
} from '../shared/learning.ts';
import type { AiHelpState, AiLevel, AiRequestCompletion, AiRequestRecord, AiRequestSeed } from '../shared/ai.ts';
import { learningDashboard } from './dashboard.ts';
import { archiveDateBoundary } from '../shared/archive-date.ts';
import { advanceReviewCard, FSRS_PARAMETERS, FSRS_VERSION, localDate, newReviewCard } from './fsrs.ts';

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
const like = (value: string) => `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%`;
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
/** Idempotent reference-index repair, also run for development schema 4 databases from before URL tracking. */
export function backfillNoteAttachmentReferences(db: DatabaseSync): void {
  const insert = db.prepare('INSERT OR IGNORE INTO note_attachment_refs VALUES (?, ?, ?)');
  for (const ref of registeredMarkdownReferences(db)) insert.run(ref.noteId, ref.version, ref.hash);
  db.exec('DELETE FROM attachment_deletion_candidates WHERE EXISTS(SELECT 1 FROM note_attachment_refs r WHERE r.hash = attachment_deletion_candidates.hash)');
}
export function defaultLearningSettings(): LearningSettings {
  return { dailyReviewBudget: 3, dailyPracticeGoal: 3, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', updatedAt: '1970-01-01T00:00:00.000Z' };
}

/** Shares the PracticeStore connection and transaction boundary; never opens another live writer. */
export class LearningRepository {
  private db: DatabaseSync;
  private transaction: Transaction;
  constructor(db: DatabaseSync, transaction: Transaction, private readonly interviewMode?: (attemptId: string) => string | undefined) { this.db = db; this.transaction = transaction; }

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
    // Older snapshots may predate URL tracking. Inspect their actual historical Markdown as well.
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
    if (filter.search) { clauses.push("EXISTS(SELECT 1 FROM note_versions v WHERE v.note_id = n.id AND (v.title LIKE ? ESCAPE '\\' OR v.markdown LIKE ? ESCAPE '\\'))"); values.push(like(filter.search), like(filter.search)); }
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
    if (search) { clauses.push("EXISTS(SELECT 1 FROM note_versions v WHERE v.note_id = n.id AND (v.title LIKE ? ESCAPE '\\' OR v.markdown LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(v.tags_json) tag WHERE tag.value LIKE ? ESCAPE '\\')))"); values.push(like(search), like(search), like(search)); }
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
    this.db.prepare('UPDATE review_events SET attempt_id = NULL WHERE attempt_id = ?').run(attemptId);
    this.db.prepare('UPDATE note_versions SET ai_request_id = NULL WHERE ai_request_id IN (SELECT id FROM ai_requests WHERE attempt_id = ?)').run(attemptId);
    this.db.prepare(`UPDATE ai_requests SET cached_from_request_id = NULL
      WHERE attempt_id <> ? AND cached_from_request_id IN (SELECT id FROM ai_requests WHERE attempt_id = ?)`).run(attemptId, attemptId);
    this.db.prepare('DELETE FROM ai_help_used WHERE attempt_id = ?').run(attemptId);
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
    if (Object.keys(input).some(key => !['dailyReviewBudget', 'dailyPracticeGoal', 'timeZone'].includes(key))) throw new Error('Unknown learning setting');
    if (input.dailyReviewBudget !== undefined && input.dailyReviewBudget !== null) integer(input.dailyReviewBudget, 'daily review budget', 0, 1000);
    if (input.dailyPracticeGoal !== undefined) integer(input.dailyPracticeGoal, 'daily practice goal', 1, 1000);
    if (input.timeZone !== undefined) zone(input.timeZone);
    return this.transaction(() => {
      const settings = { ...this.getLearningSettings(), ...input, updatedAt: now() };
      this.db.prepare('INSERT INTO learning_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json').run(canonical(settings));
      return settings;
    });
  }
  addReviewItem(input: AddReviewItemInput): ReviewItem {
    text(input.problemId, 'problem id', 200);
    if (!((input.target === 'understanding' && input.language === 'none') || (input.target === 'rewrite' && ['python', 'java'].includes(input.language)))) throw new Error('Review target and language do not match');
    const at = timestamp(input.now ?? now());
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM review_items WHERE problem_id = ? AND target = ? AND language = ?').get(input.problemId, input.target, input.language) as Row | undefined;
      if (existing) return this.getReviewItem(existing.id as string)!;
      const id = randomUUID(), card = canonical(newReviewCard(at));
      this.db.prepare('INSERT INTO review_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)')
        .run(id, input.problemId, input.target, input.language, card, card, FSRS_VERSION, JSON.stringify(FSRS_PARAMETERS), at, at, at);
      return this.getReviewItem(id)!;
    });
  }
  getReviewItem(id: string): ReviewItem | undefined {
    const row = this.db.prepare('SELECT * FROM review_items WHERE id = ?').get(id) as Row | undefined;
    return row ? { id, problemId: row.problem_id as string, target: row.target as ReviewItem['target'], language: row.language as ReviewItem['language'],
      card: JSON.parse(row.card_json as string), dueAt: row.due_at as string, scheduledAt: row.scheduled_at as string | null, suspended: row.suspended === 1,
      algorithmVersion: row.algorithm_version as string, createdAt: row.created_at as string, updatedAt: row.updated_at as string } : undefined;
  }
  listReviewItems(filter: ReviewFilter = {}): ReviewItem[] {
    const clauses: string[] = [], values: string[] = [];
    for (const [field, column] of [['problemId', 'problem_id'], ['target', 'target'], ['language', 'language']] as const) {
      if (filter[field]) { clauses.push(`${column} = ?`); values.push(filter[field]!); }
    }
    return (this.db.prepare(`SELECT id FROM review_items ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY due_at, created_at, id`).all(...values) as Row[]).map(row => this.getReviewItem(row.id as string)!);
  }
  private reviewEvent(row: Row): ReviewEvent {
    return { id: row.id as string, requestId: row.request_id as string, itemId: row.item_id as string, kind: row.kind as ReviewEvent['kind'], rating: row.rating as ReviewEvent['rating'],
      reviewedAt: row.reviewed_at as string, createdAt: row.created_at as string, correctsEventId: row.corrects_event_id as string | null, algorithmVersion: row.algorithm_version as string, attemptId: row.attempt_id as string | null };
  }
  listReviewEvents(itemId: string): ReviewEvent[] { return (this.db.prepare('SELECT * FROM review_events WHERE item_id = ? ORDER BY rowid').all(itemId) as Row[]).map(row => this.reviewEvent(row)); }
  private priorReviewRequest(requestId: string, requestHash: string): ReviewFeedbackResult | undefined {
    const row = this.db.prepare('SELECT r.input_hash, e.* FROM review_requests r JOIN review_events e ON e.id = r.event_id WHERE r.request_id = ?').get(requestId) as Row | undefined;
    if (!row) return undefined;
    if (row.input_hash !== requestHash) throw new Error('Review request id conflicts with different input');
    return { item: this.getReviewItem(row.item_id as string)!, event: this.reviewEvent(row) };
  }
  recordReview(input: ReviewFeedbackInput): ReviewFeedbackResult {
    text(input.requestId, 'request id', 200); integer(input.rating, 'review rating', 1, 4);
    const requestHash = hash(input);
    return this.transaction(() => {
      const prior = this.priorReviewRequest(input.requestId, requestHash); if (prior) return prior;
      const item = this.getReviewItem(input.itemId); if (!item) throw new Error('Review item not found');
      if (input.attemptId) {
        const attempt = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(input.attemptId) as Row | undefined;
        if (!attempt || attempt.problem_id !== item.problemId || (item.language !== 'none' && attempt.language !== item.language)) throw new Error('Review attempt does not match item and language');
        if (attempt.ended_at === null) throw new Error('Finish the attempt before recording review feedback');
        const same = this.db.prepare("SELECT * FROM review_events WHERE item_id = ? AND attempt_id = ? AND kind = 'review'").get(item.id, input.attemptId) as Row | undefined;
        if (same) {
          const lastCorrection = this.db.prepare("SELECT * FROM review_events WHERE corrects_event_id = ? ORDER BY rowid DESC LIMIT 1").get(same.id) as Row | undefined;
          if ((lastCorrection?.rating ?? same.rating) !== input.rating) throw new Error('This attempt already has review feedback; use rating correction');
          this.db.prepare('INSERT INTO review_requests VALUES (?, ?, ?)').run(input.requestId, requestHash, lastCorrection?.id ?? same.id);
          return { item, event: this.reviewEvent(lastCorrection ?? same) };
        }
      }
      const at = timestamp(input.reviewedAt ?? now());
      if (at < item.createdAt) throw new Error('Review time precedes item creation');
      const id = randomUUID();
      this.db.prepare("INSERT INTO review_events VALUES (?, ?, ?, 'review', ?, ?, ?, NULL, ?, ?)")
        .run(id, input.requestId, item.id, input.rating, at, now(), item.algorithmVersion, input.attemptId ?? null);
      this.db.prepare('INSERT INTO review_requests VALUES (?, ?, ?)').run(input.requestId, requestHash, id);
      this.replayReview(item.id);
      return { item: this.getReviewItem(item.id)!, event: this.listReviewEvents(item.id).find(event => event.id === id)! };
    });
  }
  correctReview(input: CorrectReviewInput): ReviewFeedbackResult {
    text(input.requestId, 'request id', 200); integer(input.rating, 'review rating', 1, 4);
    const requestHash = hash({ operation: 'correction', ...input });
    return this.transaction(() => {
      const prior = this.priorReviewRequest(input.requestId, requestHash); if (prior) return prior;
      const original = this.db.prepare("SELECT * FROM review_events WHERE id = ? AND kind = 'review'").get(input.eventId) as Row | undefined;
      if (!original) throw new Error('Original review event not found');
      const id = randomUUID();
      this.db.prepare("INSERT INTO review_events VALUES (?, ?, ?, 'correction', ?, ?, ?, ?, ?, ?)")
        .run(id, input.requestId, original.item_id, input.rating, original.reviewed_at, now(), original.id, original.algorithm_version, original.attempt_id);
      this.db.prepare('INSERT INTO review_requests VALUES (?, ?, ?)').run(input.requestId, requestHash, id);
      this.replayReview(original.item_id as string);
      return { item: this.getReviewItem(original.item_id as string)!, event: this.listReviewEvents(original.item_id as string).find(event => event.id === id)! };
    });
  }
  private replayReview(itemId: string): void {
    const item = this.db.prepare('SELECT * FROM review_items WHERE id = ?').get(itemId) as Row;
    const all = this.listReviewEvents(itemId), corrections = new Map<string, ReviewEvent>();
    for (const event of all) {
      if (event.algorithmVersion !== item.algorithm_version) throw new Error('Unsupported historical FSRS algorithm; review history was not changed');
      if (event.kind === 'correction') corrections.set(event.correctsEventId!, event);
    }
    let card = JSON.parse(item.initial_card_json as string);
    const reviews = all.filter(event => event.kind === 'review').sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
    for (const event of reviews) card = advanceReviewCard(card, event.reviewedAt, corrections.get(event.id)?.rating ?? event.rating,
      item.algorithm_version as string, JSON.parse(item.parameters_json as string));
    this.db.prepare('UPDATE review_items SET card_json = ?, due_at = ?, updated_at = ? WHERE id = ?').run(canonical(card), card.due, now(), itemId);
  }
  setReviewPlan(itemId: string, input: { suspended?: boolean; scheduledAt?: string | null }): ReviewItem {
    if (Object.keys(input).some(key => !['suspended', 'scheduledAt'].includes(key))) throw new Error('Unknown review plan field');
    if (input.suspended !== undefined && typeof input.suspended !== 'boolean') throw new Error('Invalid suspended flag');
    const scheduled = input.scheduledAt === undefined ? undefined : input.scheduledAt === null ? null : timestamp(input.scheduledAt);
    return this.transaction(() => { const item = this.getReviewItem(itemId); if (!item) throw new Error('Review item not found');
      this.db.prepare('UPDATE review_items SET suspended = ?, scheduled_at = ?, updated_at = ? WHERE id = ?')
        .run(input.suspended === undefined ? Number(item.suspended) : Number(input.suspended), scheduled === undefined ? item.scheduledAt : scheduled, now(), itemId);
      return this.getReviewItem(itemId)!;
    });
  }
  getTodayQueue(at = now()): TodayQueue {
    at = timestamp(at); const settings = this.getLearningSettings(), date = localDate(at, settings.timeZone);
    const done = new Set((this.db.prepare("SELECT item_id, reviewed_at FROM review_events WHERE kind = 'review'").all() as Row[])
      .filter(row => localDate(row.reviewed_at as string, settings.timeZone) === date).map(row => row.item_id as string));
    const remaining = settings.dailyReviewBudget === null ? null : Math.max(0, settings.dailyReviewBudget - done.size);
    const all = this.listReviewItems(), due = all.filter(item => !item.suspended && item.dueAt <= at);
    const eligible = due.filter(item => !item.scheduledAt || item.scheduledAt <= at);
    let admitted = 0;
    const items = eligible.filter(item => done.has(item.id) || remaining === null || admitted++ < remaining);
    const fresh = (this.db.prepare(`SELECT h.problem_id FROM library_problem_heads h
      JOIN problem_versions v ON v.problem_id = h.problem_id AND v.version = h.version
      WHERE NOT EXISTS(SELECT 1 FROM attempts a WHERE a.problem_id = h.problem_id)
      AND NOT EXISTS(SELECT 1 FROM review_items r WHERE r.problem_id = h.problem_id)
      AND (length(trim(COALESCE(json_extract(v.snapshot_json, '$.starter.python'), ''), ${SQL_TRIM_WHITESPACE})) > 0
        OR length(trim(COALESCE(json_extract(v.snapshot_json, '$.starter.java'), ''), ${SQL_TRIM_WHITESPACE})) > 0)
      AND (json_extract(v.snapshot_json, '$.mode') = 'acm' OR json_type(v.snapshot_json, '$.adapter') = 'object')
      AND json_array_length(v.snapshot_json, '$.cases') > 0
      ORDER BY h.created_at, h.problem_id LIMIT 3`).all() as Row[]).map(row => row.problem_id as string);
    return { date, timeZone: settings.timeZone, budget: settings.dailyReviewBudget, reviewedToday: done.size, remainingBudget: remaining,
      items, dueCount: due.length, overdueCount: due.filter(item => localDate(item.dueAt, settings.timeZone) < date).length,
      deferredCount: due.length - eligible.length, suspendedCount: all.filter(item => item.suspended).length, newProblemIds: fresh };
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
  getLearningDashboard(month?: string, at = now()) {
    return learningDashboard(this.db, this.getLearningSettings(), () => this.listReviewItems(), month, timestamp(at));
  }
  getArchiveStatistics(input: { attemptId?: string; from?: string; to?: string; timeZone?: string } = {}): ArchiveStatistics {
    const timeZone = input.timeZone ?? this.getLearningSettings().timeZone; zone(timeZone);
    const from = input.from ? timestamp(input.from) : '', to = input.to ? timestamp(input.to) : '9999';
    // Reuse one formatter and let SQLite aggregate small date/count rows, never Run code or results.
    const formatter = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    type DayRange = { date: string; start: number; end: number };
    const ranges = new Map<string, DayRange>(); let recent: DayRange | undefined;
    const rangeAt = (at: number): DayRange => {
      if (recent && at >= recent.start && at < recent.end) return recent;
      const parts = formatter.formatToParts(new Date(at));
      const date = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
      let range = ranges.get(date);
      if (!range) { range = { date, start: Date.parse(archiveDateBoundary(date, timeZone)), end: Date.parse(archiveDateBoundary(date, timeZone, true)) }; ranges.set(date, range); }
      recent = range; return range;
    };
    this.db.function('practice_local_date', { deterministic: true }, at => rangeAt(Date.parse(String(at))).date);
    let cachedSample: { at: string; duration: number; parts: [string, number, string, number] } | undefined;
    this.db.function('practice_activity_part', { deterministic: true }, (value, durationValue, part) => {
      const at = String(value), duration = Number(durationValue);
      if (!cachedSample || cachedSample.at !== at || cachedSample.duration !== duration) {
        const end = Date.parse(at), start = end - duration;
        // A pulse describes [end-duration, end), so exactly-midnight samples belong to yesterday.
        const first = rangeAt(start), last = rangeAt(duration > 0 ? end - 1 : end);
        const previous = first.date === last.date ? 0 : Math.max(0, last.start - start);
        cachedSample = { at, duration, parts: [last.date, duration - previous, first.date, previous] };
      }
      return cachedSample.parts[Number(part)];
    });
    const days = new Map<string, ActivityDay>();
    const day = (date: string) => { if (!days.has(date)) days.set(date, { date, activeMs: 0, attempts: 0, runs: 0, passedRuns: 0, reviewCount: 0 }); return days.get(date)!; };
    const condition = input.attemptId ? ' AND attempt_id = ?' : '', args = input.attemptId ? [from, to, input.attemptId] : [from, to];
    let activeMs = 0, attempts = 0, runs = 0, passedRuns = 0;
    const activityWhere = `occurred_at >= ? AND occurred_at <= ?${condition}`;
    for (const row of this.db.prepare(`SELECT practice_activity_part(occurred_at, duration_ms, 0) AS date,
      SUM(practice_activity_part(occurred_at, duration_ms, 1)) AS duration FROM activity_samples WHERE ${activityWhere} GROUP BY date
      UNION ALL SELECT practice_activity_part(occurred_at, duration_ms, 2) AS date,
      SUM(practice_activity_part(occurred_at, duration_ms, 3)) AS duration FROM activity_samples
      WHERE ${activityWhere} AND practice_activity_part(occurred_at, duration_ms, 3) > 0 GROUP BY date`).all(...args, ...args) as Row[]) {
      activeMs += row.duration as number; day(row.date as string).activeMs += row.duration as number;
    }
    for (const row of this.db.prepare(`SELECT practice_local_date(started_at) AS date, COUNT(*) AS count
      FROM attempts WHERE started_at >= ? AND started_at <= ?${input.attemptId ? ' AND id = ?' : ''} GROUP BY date`).all(...args) as Row[]) {
      attempts += row.count as number; day(row.date as string).attempts = row.count as number;
    }
    for (const row of this.db.prepare(`SELECT practice_local_date(created_at) AS date, COUNT(*) AS count, SUM(status = 'passed') AS passed
      FROM runs WHERE created_at >= ? AND created_at <= ?${condition} GROUP BY date`).all(...args) as Row[]) {
      runs += row.count as number; passedRuns += row.passed as number; day(row.date as string).runs = row.count as number; day(row.date as string).passedRuns = row.passed as number;
    }
    for (const row of this.db.prepare(`SELECT practice_local_date(reviewed_at) AS date, COUNT(*) AS count
      FROM review_events WHERE kind = 'review' AND reviewed_at >= ? AND reviewed_at <= ?${condition} GROUP BY date`).all(...args) as Row[]) day(row.date as string).reviewCount = row.count as number;
    const reviewedItems = this.db.prepare(`SELECT COUNT(DISTINCT item_id) AS count FROM review_events WHERE kind = 'review' AND reviewed_at >= ? AND reviewed_at <= ?${condition}`).get(...args)!.count as number;
    return { activeMs, attempts, runs, passedRuns, reviewedItems, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
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
      if (completion.cachedFromRequestId) { const cached = this.getAIRequest(completion.cachedFromRequestId);
        if (!cached || cached.status !== 'completed' || cached.requestHash !== request.requestHash || canonical(cached.response) !== canonical(completion.response)) throw new Error('AI cache reference does not match completed request'); }
      this.db.prepare('UPDATE ai_requests SET status = ?, response_json = ?, error_json = ?, usage_json = ?, cached_from_request_id = ?, finished_at = ? WHERE id = ?')
        .run(completion.status, canonical(completion.response), canonical(completion.error), canonical(completion.usage), completion.cachedFromRequestId, now(), id);
      if (completion.status === 'completed') this.markAIHelpUsed(request.attemptId, id, request.snapshot.level);
      return this.getAIRequest(id)!;
    });
  }
  recoverInterruptedAIRequests(): number {
    return this.transaction(() => Number(this.db.prepare("UPDATE ai_requests SET status = 'interrupted', error_json = ?, finished_at = ? WHERE status IN ('pending','streaming','repairing')")
      .run(canonical({ code: 'INTERRUPTED', message: 'Application stopped before the AI request finished; no request was repeated.', retryable: true }), now()).changes));
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
  markAIHelpUsed(attemptId: string, requestId: string, legacyLevel?: AiLevel): void {
    this.transaction(() => { const request = this.getAIRequest(requestId);
      if (!request || request.status !== 'completed' || request.attemptId !== attemptId || (legacyLevel !== undefined && request.snapshot.level !== legacyLevel) || (request.snapshot.mode === 'strict' && request.snapshot.isActive)) throw new Error('AI help record does not match a completed request and mode');
      this.db.prepare('INSERT OR IGNORE INTO ai_help_used VALUES (?, ?, ?, ?)').run(requestId, attemptId, request.snapshot.level ?? 'adaptive', now());
    });
  }
}
