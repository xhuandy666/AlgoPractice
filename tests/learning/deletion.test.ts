import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { PracticeStore, hashCode, type Attempt } from '../../src/storage/practice-store.ts';
import type { AiRequestSeed, AiResponse } from '../../src/shared/ai.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice-p3-deletion-')), dbPath = join(directory, 'practice.sqlite');
  const store = new PracticeStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, dbPath, store };
}
function addAttachment(store: PracticeStore, name = '历史附件.txt') {
  return store.registerAttachment({ hash: hashCode(name), name, mimeType: 'text/plain', size: Buffer.byteLength(name), createdAt: new Date().toISOString() });
}
const answer: AiResponse = { schemaVersion: 1, kind: 'hint', level: 'L1', title: '提示', explanation: '保持循环不变量。', nextSteps: [], evidence: [], inferences: [], patch: null, completeSolution: null, noteDraft: null };
const completed = { status: 'completed' as const, response: answer, error: null, usage: null, cachedFromRequestId: null };
function aiSeed(attempt: Attempt, id: string): AiRequestSeed {
  const snapshot: AiRequestSeed['snapshot'] = {
    policyVersion: 'test-policy', promptVersion: 'test-prompt', attemptId: attempt.id, problemId: attempt.problemId, problemVersion: attempt.problemVersion,
    language: attempt.language, mode: attempt.mode, isActive: true, draftScopeId: attempt.draftScopeId, draftRevision: 1, code: 'print(1)', codeHash: hashCode('print(1)'),
    kind: 'hint', level: 'L1', question: '给我方向', unlockCompleteSolution: false, runId: null, run: null,
    provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', temperature: 0, maxOutputTokens: 100, timeoutMs: 1000, jsonMode: true, includeUsage: false },
    messages: [{ role: 'user', content: '给我方向' }], selectedNoteIds: [], selectedConversationIds: [], clippedFields: [],
  };
  return { id, attemptId: attempt.id, snapshot, requestHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}
function graph(store: PracticeStore) {
  const original = store.startAttempt({ problemId: 'p1', language: 'python', problemVersion: 'v1' }), file = addAttachment(store);
  const sourceSeed = aiSeed(original, 'source-ai'); store.beginAIRequest(sourceSeed); store.finishAIRequest(sourceSeed.id, completed);
  store.beginAIRequest({ ...sourceSeed, id: 'source-ai-cached' }); store.finishAIRequest('source-ai-cached', { ...completed, cachedFromRequestId: sourceSeed.id });
  const draftNote = store.saveNote({ requestId: 'note-create', kind: 'problem', subjectId: 'p1', title: '独立保留的笔记', markdown: '确认过的不变量', attachmentHashes: [file.hash], origin: 'ai', state: 'draft', aiRequestId: sourceSeed.id });
  const note = store.confirmNote({ requestId: 'note-confirm', noteId: draftNote.id, version: 1, expectedVersion: 1 });
  store.recordActivity({ requestId: 'active-sample', attemptId: original.id, durationMs: 10000, occurredAt: new Date().toISOString() });
  store.markAIHelpShown(original.id); store.dismissAIHelp(original.id);
  const run = store.saveRun({ id: 'source-run', attemptId: original.id, code: 'print(1)', testSuiteVersion: 'suite', adapterVersion: 'adapter', runtimeVersion: 'python', status: 'passed', result: { status: 'passed' } });
  const ended = store.finishAttempt(original.id, { code: 'print(1)' });
  const item = store.addReviewItem({ problemId: 'p1', target: 'rewrite', language: 'python' });
  const reviewInput = { requestId: 'original-rating', itemId: item.id, attemptId: original.id, rating: 3 as const };
  const review = store.recordReview(reviewInput); store.correctReview({ requestId: 'correct-rating', eventId: review.event.id, rating: 4 });
  const child = store.restoreRunAsDraft(run.id, { requestId: 'child-finished' }), finishedChild = store.finishAttempt(child.attempt.id, { code: child.draft.code });
  const activeChild = store.restoreRunAsDraft(run.id, { requestId: 'child-active' });
  const cachedSeed = { ...aiSeed(activeChild.attempt, 'other-attempt-cache'), requestHash: sourceSeed.requestHash };
  store.beginAIRequest(cachedSeed); const cached = store.finishAIRequest(cachedSeed.id, { ...completed, cachedFromRequestId: sourceSeed.id });
  return { ended, run, note, file, reviewItem: store.getReviewItem(item.id)!, reviewInput, review, finishedChild, activeChild, cached };
}
function rows(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
function legacyV3(dbPath: string, populatedPath: string) {
  const db = new DatabaseSync(dbPath); db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA wal_autocheckpoint = 0;');
  db.exec(readFileSync(new URL('../storage/fixtures/p3-schema.sql', import.meta.url), 'utf8'));
  db.prepare('ATTACH DATABASE ? AS populated').run(populatedPath); db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON;');
  for (const { name } of db.prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) db.exec(`INSERT INTO main."${name}" SELECT * FROM populated."${name}"`);
  db.exec('COMMIT; DETACH DATABASE populated;'); return db;
}

test('deleting a finished archive detaches provenance and preserves every rating, note version and draft', t => {
  const { store, dbPath } = fixture(t), value = graph(store), raw = new DatabaseSync(dbPath);
  try {
    const drafts = raw.prepare('SELECT * FROM drafts ORDER BY scope_id').all(), events = store.listReviewEvents(value.reviewItem.id), notes = store.listNoteVersions(value.note.id);
    assert.equal(store.deleteEndedAttempt(value.ended.id), true); assert.equal(store.deleteEndedAttempt(value.ended.id), false, 'a lost deletion response can be retried safely');
    assert.equal(store.getAttempt(value.ended.id), undefined); assert.equal(store.getRun(value.run.id), undefined);
    assert.deepEqual(store.listAIRequests(value.ended.id), []); assert.deepEqual(store.getAttemptNoteVersions(value.ended.id), []);
    assert.deepEqual(store.getReviewItem(value.reviewItem.id), value.reviewItem, 'deletion must never reschedule FSRS');
    assert.deepEqual(store.listReviewEvents(value.reviewItem.id), events.map(event => ({ ...event, attemptId: null })));
    assert.deepEqual(store.recordReview(value.reviewInput).event, { ...value.review.event, attemptId: null }, 'feedback request deduplication survives source deletion');
    assert.deepEqual(store.listNoteVersions(value.note.id), notes.map(note => ({ ...note, aiRequestId: null })));
    assert.equal(store.getNote(value.note.id)?.confirmed?.origin, 'ai'); assert.deepEqual(store.listAttachmentReferences(), [value.file]);
    assert.deepEqual(store.getAttempt(value.finishedChild.id), { ...value.finishedChild, restoredFromRunId: null });
    assert.deepEqual(store.getAttempt(value.activeChild.attempt.id), { ...value.activeChild.attempt, restoredFromRunId: null });
    assert.deepEqual(store.getAIRequest(value.cached.id), { ...value.cached, cachedFromRequestId: null });
    assert.deepEqual(raw.prepare('SELECT * FROM drafts ORDER BY scope_id').all(), drafts);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM draft_restorations').get()?.count, 0);
    assert.equal(store.getArchiveStatistics().activeMs, 0); assert.equal(store.getArchiveStatistics().reviewedItems, 1);
    assert.deepEqual(store.listAttachmentDeletionCandidates(), [], 'archive note links do not own independent note files');
    const corrected = store.correctReview({ requestId: 'after-delete-correction', eventId: value.review.event.id, rating: 3 });
    assert.equal(corrected.event.attemptId, null); assert.equal(corrected.item.card.reps, 1); store.integrityCheck();
  } finally { raw.close(); }
});

test('active archives and unfinished AI requests cannot be deleted', t => {
  const { store } = fixture(t), attempt = store.startAttempt({ problemId: 'p1', language: 'python', problemVersion: 'v1' });
  assert.throws(() => store.deleteEndedAttempt(attempt.id), /Finish the attempt/);
  const pending = aiSeed(attempt, 'pending'); store.beginAIRequest(pending); store.finishAttempt(attempt.id, { code: 'print(1)' });
  assert.throws(() => store.deleteEndedAttempt(attempt.id), /unfinished runs and AI/); assert.equal(store.getAIRequest(pending.id)?.status, 'pending');
  store.finishAIRequest(pending.id, { status: 'cancelled', response: null, error: { code: 'CANCELLED', message: 'Stopped', retryable: true }, usage: null, cachedFromRequestId: null });
  assert.equal(store.deleteEndedAttempt(attempt.id), true); store.integrityCheck();
});

test('archive deletion rolls back all detachments on a write error and on a deferred FK failure', t => {
  const { store, dbPath } = fixture(t), value = graph(store), raw = new DatabaseSync(dbPath);
  try {
    raw.exec("CREATE TRIGGER injected_archive_failure BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;");
    const before = rows(raw); assert.throws(() => store.deleteEndedAttempt(value.ended.id), /injected delete failure/); assert.deepEqual(rows(raw), before);
    raw.exec('DROP TRIGGER injected_archive_failure; CREATE TABLE extra_archive_reference (attempt_id TEXT REFERENCES attempts(id));'); raw.prepare('INSERT INTO extra_archive_reference VALUES (?)').run(value.ended.id);
    const withReference = rows(raw); assert.throws(() => store.deleteEndedAttempt(value.ended.id), /FOREIGN KEY constraint failed/);
    assert.deepEqual(rows(raw), withReference, 'COMMIT must enforce FKs and roll back detached provenance');
    raw.exec('DROP TABLE extra_archive_reference'); assert.equal(store.deleteEndedAttempt(value.ended.id), true); store.integrityCheck();
  } finally { raw.close(); }
});

test('schema 4 permits only nonempty provenance to become null while all immutable content stays protected', t => {
  const { store, dbPath } = fixture(t), value = graph(store), raw = new DatabaseSync(dbPath);
  try {
    const cases = [
      { table: 'review_events', key: 'id', id: value.review.event.id, field: 'attempt_id', source: value.ended.id, protected: 'rating' },
      { table: 'note_versions', key: 'note_id', id: value.note.id, field: 'ai_request_id', source: 'source-ai', protected: 'markdown' },
      { table: 'attempts', key: 'id', id: value.finishedChild.id, field: 'restored_from_run_id', source: value.run.id, protected: 'final_code' },
      { table: 'ai_requests', key: 'id', id: value.cached.id, field: 'cached_from_request_id', source: 'source-ai', protected: 'response_json' },
    ];
    for (const item of cases) {
      assert.throws(() => raw.prepare(`UPDATE ${item.table} SET ${item.field} = NULL, ${item.protected} = ${item.protected} WHERE ${item.key} = ?`).run(item.id), /immutable/);
      assert.throws(() => raw.prepare(`UPDATE ${item.table} SET ${item.field} = ? WHERE ${item.key} = ?`).run(item.source, item.id), /only be detached/);
      raw.prepare(`UPDATE ${item.table} SET ${item.field} = NULL WHERE ${item.key} = ?`).run(item.id);
      assert.throws(() => raw.prepare(`UPDATE ${item.table} SET ${item.field} = ? WHERE ${item.key} = ?`).run(item.source, item.id), /only be detached/);
      assert.throws(() => raw.prepare(`UPDATE ${item.table} SET ${item.field} = NULL WHERE ${item.key} = ?`).run(item.id), /only be detached/);
    }
    assert.throws(() => raw.prepare('UPDATE attempts SET problem_version = problem_version WHERE id = ?').run(value.finishedChild.id), /immutable/);
    assert.throws(() => raw.prepare('UPDATE ai_requests SET snapshot_json = snapshot_json WHERE id = ?').run(value.cached.id), /immutable/); store.integrityCheck();
  } finally { raw.close(); }
});

test('a real schema 3 WAL database upgrades to 7 only after an unchanged schema 3 backup is published', t => {
  const { store, directory, dbPath } = fixture(t), value = graph(store), legacyPath = join(directory, 'legacy-v3.sqlite'), legacy = legacyV3(legacyPath, dbPath);
  try {
    const before = rows(legacy), upgraded = new PracticeStore(legacyPath);
    try {
      assert.ok(upgraded.migrationBackupPath?.includes('.before-v7-')); assert.equal(legacy.prepare('PRAGMA user_version').get()?.user_version, 7);
      const after = rows(legacy); delete after.attachment_deletion_candidates; delete after.company_datasets; delete after.interview_sessions; delete after.interview_attempts; delete after.official_submissions; delete after.submission_remarks; assert.deepEqual(after, before);
      const backup = new DatabaseSync(upgraded.migrationBackupPath!, { readOnly: true });
      try { assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 3); assert.deepEqual(rows(backup), before); } finally { backup.close(); }
      assert.equal(PracticeStore.inspectBackupSnapshot(upgraded.migrationBackupPath!).schemaVersion, 3); assert.deepEqual(PracticeStore.inspectBackupSnapshot(upgraded.migrationBackupPath!).attachments, [value.file]);
      assert.equal(upgraded.deleteEndedAttempt(value.ended.id), true); upgraded.integrityCheck();
      const restoredPath = join(directory, 'restored-v3.sqlite'); PracticeStore.restoreBackup(upgraded.migrationBackupPath!, restoredPath); const restored = new PracticeStore(restoredPath);
      try { assert.ok(restored.migrationBackupPath); assert.equal(restored.getAttempt(value.ended.id)?.id, value.ended.id); restored.integrityCheck(); } finally { restored.close(); }
    } finally { upgraded.close(); }
  } finally { legacy.close(); }
});

test('a failed schema 3 to 7 migration restores every original trigger and row and keeps its pre-migration backup', t => {
  const { store, directory, dbPath } = fixture(t); graph(store);
  const legacyPath = join(directory, 'failed-v3.sqlite'), legacy = legacyV3(legacyPath, dbPath);
  try {
    legacy.exec('CREATE TABLE attachment_deletion_candidates (injected_conflict TEXT)');
    const beforeRows = rows(legacy), beforeSchema = legacy.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all();
    assert.throws(() => new PracticeStore(legacyPath), /Schema v7 migration failed/); assert.equal(legacy.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.deepEqual(rows(legacy), beforeRows); assert.deepEqual(legacy.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all(), beforeSchema);
    const backupName = readdirSync(directory).find(name => name.startsWith('failed-v3.sqlite.before-v7-') && name.endsWith('.sqlite')); assert.ok(backupName);
    const backup = new DatabaseSync(join(directory, backupName!), { readOnly: true });
    try { assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 3); assert.deepEqual(rows(backup), beforeRows); } finally { backup.close(); }
  } finally { legacy.close(); }
});

test('a deleted archive stays deleted after schema 4 backup and restore while retained learning data remains exact', async t => {
  const { store, directory } = fixture(t), value = graph(store); store.deleteEndedAttempt(value.ended.id);
  const note = store.getNote(value.note.id), card = store.getReviewItem(value.reviewItem.id), backupPath = join(directory, 'after-delete.sqlite'); await store.backupTo(backupPath);
  assert.equal(PracticeStore.inspectBackupSnapshot(backupPath).schemaVersion, 7); assert.deepEqual(PracticeStore.inspectBackupSnapshot(backupPath).attachments, [value.file]);
  const restoredPath = join(directory, 'restored.sqlite'); PracticeStore.restoreBackup(backupPath, restoredPath); const restored = new PracticeStore(restoredPath);
  try {
    assert.equal(restored.migrationBackupPath, null); assert.equal(restored.getAttempt(value.ended.id), undefined);
    assert.deepEqual(restored.getNote(value.note.id), note); assert.deepEqual(restored.getReviewItem(value.reviewItem.id), card);
    assert.deepEqual(restored.getDraft('p1', 'python', value.activeChild.draft.scopeId), value.activeChild.draft); restored.integrityCheck();
  } finally { restored.close(); }
});

test('note deletion persists only its own released attachment hashes and file cleanup remains retryable across reopen', t => {
  const { store, dbPath } = fixture(t), own = addAttachment(store, '旧版本独有.txt'), shared = addAttachment(store, '其他笔记仍引用.txt'), untouched = addAttachment(store, '刚添加尚未保存.txt');
  const note = store.saveNote({ requestId: 'own-1', kind: 'topic', subjectId: '主题', title: '旧版本', markdown: '', attachmentHashes: [own.hash, shared.hash] });
  store.saveNote({ requestId: 'own-2', noteId: note.id, expectedVersion: 1, kind: 'topic', subjectId: '主题', title: '新版本', markdown: '', attachmentHashes: [] });
  store.saveNote({ requestId: 'shared-1', kind: 'topic', subjectId: '另一个主题', title: '仍有引用', markdown: '', attachmentHashes: [shared.hash] });
  assert.deepEqual(store.deleteNoteWithAttachmentCandidates(note.id, 2), { deleted: true, attachments: [own] });
  assert.deepEqual(store.deleteNoteWithAttachmentCandidates(note.id, 2), { deleted: false, attachments: [] });
  assert.deepEqual(store.listAttachmentDeletionCandidates(), [own]); assert.deepEqual(store.getAttachment(own.hash), own);
  store.close(); const reopened = new PracticeStore(dbPath);
  try {
    assert.deepEqual(reopened.listAttachmentDeletionCandidates(), [own]); assert.equal(reopened.purgeAttachmentMetadataIfUnreferenced({ ...own, name: 'stale.txt' }), false);
    assert.equal(reopened.purgeAttachmentMetadataIfUnreferenced(own), true); assert.equal(reopened.getAttachment(own.hash), undefined); assert.deepEqual(reopened.listAttachmentDeletionCandidates(), [own]);
    assert.equal(reopened.purgeAttachmentMetadataIfUnreferenced(own), true, 'a failed unlink can retry with metadata already removed');
    assert.equal(reopened.purgeAttachmentMetadataIfUnreferenced(untouched), false, 'an unreferenced fresh file is not a deletion candidate');
    reopened.close(); const retried = new PracticeStore(dbPath);
    try {
      assert.deepEqual(retried.listAttachmentDeletionCandidates(), [own]); assert.equal(retried.purgeAttachmentMetadataIfUnreferenced(own), true);
      retried.finishAttachmentDeletionCandidate(own.hash); assert.deepEqual(retried.listAttachmentDeletionCandidates(), []);
      assert.deepEqual(retried.getAttachment(shared.hash), shared); assert.deepEqual(retried.getAttachment(untouched.hash), untouched); retried.integrityCheck();
    } finally { retried.close(); }
  } finally { reopened.close(); }
});

test('new references, re-registration and metadata CAS changes cancel stale attachment deletion candidates', t => {
  const { store, dbPath } = fixture(t), file = addAttachment(store), raw = new DatabaseSync(dbPath); let serial = 0;
  const enqueue = () => { const note = store.saveNote({ requestId: `note-${++serial}`, kind: 'topic', subjectId: 'x', title: 'x', markdown: '', attachmentHashes: [file.hash] }); store.deleteNoteWithAttachmentCandidates(note.id, 1); };
  try {
    enqueue(); store.registerAttachment(file); assert.equal(store.purgeAttachmentMetadataIfUnreferenced(file), false); assert.deepEqual(store.getAttachment(file.hash), file);
    enqueue(); const retained = store.saveNote({ requestId: 'reattached', kind: 'topic', subjectId: 'x', title: '保留', markdown: '', attachmentHashes: [file.hash] });
    assert.equal(store.purgeAttachmentMetadataIfUnreferenced(file), false); assert.deepEqual(store.listAttachmentDeletionCandidates(), []); store.deleteNoteWithAttachmentCandidates(retained.id, 1);
    assert.equal(store.purgeAttachmentMetadataIfUnreferenced(file), true);
    raw.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?)').run(file.hash, 'new-name.txt', file.mimeType, file.size, '2026-01-01T00:00:00.000Z');
    assert.equal(store.purgeAttachmentMetadataIfUnreferenced(file), false); assert.deepEqual(store.listAttachmentDeletionCandidates(), []); assert.equal(store.getAttachment(file.hash)?.name, 'new-name.txt'); store.integrityCheck();
  } finally { raw.close(); }
});

test('note deletion and its explicit file-cleanup candidates roll back together when queuing fails', t => {
  const { store, dbPath } = fixture(t), file = addAttachment(store), raw = new DatabaseSync(dbPath);
  const note = store.saveNote({ requestId: 'note-to-delete', kind: 'topic', subjectId: '主题', title: '需要保留', markdown: 'KEEP', attachmentHashes: [file.hash] });
  try {
    raw.exec("CREATE TRIGGER injected_cleanup_failure BEFORE INSERT ON attachment_deletion_candidates BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END");
    assert.throws(() => store.deleteNoteWithAttachmentCandidates(note.id, 1), /injected queue failure/);
    assert.deepEqual(store.getNote(note.id), note); assert.deepEqual(store.listAttachmentReferences(), [file]); assert.deepEqual(store.listAttachmentDeletionCandidates(), []);
    raw.exec('DROP TRIGGER injected_cleanup_failure'); assert.deepEqual(store.deleteNoteWithAttachmentCandidates(note.id, 1).attachments, [file]); store.integrityCheck();
  } finally { raw.close(); }
});

test('copied Markdown attachment URLs protect the other note and are included in backups without explicit hashes', async t => {
  const { store, directory } = fixture(t), file = addAttachment(store), url = `algopractice://app/attachment/${file.hash}`;
  const original = store.saveNote({ requestId: 'linked-original', kind: 'topic', subjectId: 'A', title: '原笔记', markdown: `![附件](${url})`, attachmentHashes: [file.hash] });
  const unknownHash = hashCode('later-registered');
  const copiedInput = { requestId: 'copied-link', kind: 'topic' as const, subjectId: 'B', title: '复制链接', markdown: `![同一附件](${url})\n[以后提供](algopractice://app/attachment/${unknownHash})` };
  const copied = store.saveNote(copiedInput);
  assert.deepEqual(copied.current.attachmentHashes, [file.hash]);
  assert.equal(store.saveNote(copiedInput).latestVersion, 1);
  assert.deepEqual(store.deleteNoteWithAttachmentCandidates(original.id, 1), { deleted: true, attachments: [] });
  assert.deepEqual(store.getAttachment(file.hash), file); assert.deepEqual(store.listAttachmentDeletionCandidates(), []);
  const backupPath = join(directory, 'copied-markdown.sqlite'); await store.backupTo(backupPath);
  assert.deepEqual(PracticeStore.inspectBackupSnapshot(backupPath).attachments, [file]);
  const later = store.registerAttachment({ hash: unknownHash, name: 'later.txt', mimeType: 'text/plain', size: 1, createdAt: new Date().toISOString() });
  assert.deepEqual(store.getNote(copied.id)?.current.attachmentHashes, [file.hash, later.hash].sort(), 'a previously unknown URL is indexed once its file is registered');
  assert.equal(store.saveNote(copiedInput).latestVersion, 1, 'registration must not change request idempotency');
  const extra = store.saveNote({ requestId: 'non-exact-url', kind: 'topic', subjectId: 'C', title: '只是文本', markdown: `[不是内部附件](${url}/extra) [未知](algopractice://app/attachment/${'f'.repeat(64)})` });
  assert.deepEqual(extra.current.attachmentHashes, []); assert.match(extra.current.markdown, /extra/);
});

test('schema 3 migration and existing schema 4 reopening repair historical Markdown-only references idempotently', t => {
  const { store, directory, dbPath } = fixture(t), file = addAttachment(store), raw = new DatabaseSync(dbPath);
  const note = store.saveNote({ requestId: 'historical-url', kind: 'topic', subjectId: 'B', title: '历史复制', markdown: `[附件](algopractice://app/attachment/${file.hash})` });
  const legacyPath = join(directory, 'markdown-v3.sqlite'), legacy = legacyV3(legacyPath, dbPath);
  try {
    legacy.prepare('DELETE FROM note_attachment_refs WHERE note_id = ?').run(note.id);
    assert.deepEqual(PracticeStore.inspectBackupSnapshot(legacyPath).attachments, [file], 'old snapshots must inspect actual historical Markdown too');
    const upgraded = new PracticeStore(legacyPath);
    try {
      assert.deepEqual(upgraded.getNote(note.id)?.current.attachmentHashes, [file.hash]);
      assert.deepEqual(PracticeStore.inspectBackupSnapshot(upgraded.migrationBackupPath!).attachments, [file]);
      assert.deepEqual(upgraded.deleteNoteWithAttachmentCandidates(note.id, 1).attachments, [file]); upgraded.integrityCheck();
    } finally { upgraded.close(); }
    raw.prepare('DELETE FROM note_attachment_refs WHERE note_id = ?').run(note.id);
    raw.prepare('INSERT INTO attachment_deletion_candidates VALUES (?, ?, ?, ?, ?)').run(file.hash, file.name, file.mimeType, file.size, file.createdAt);
    raw.close(); store.close(); const repaired = new PracticeStore(dbPath);
    try {
      assert.equal(repaired.migrationBackupPath, null); assert.deepEqual(repaired.getNote(note.id)?.current.attachmentHashes, [file.hash]);
      assert.deepEqual(repaired.listAttachmentDeletionCandidates(), []); repaired.integrityCheck();
    } finally { repaired.close(); }
    const again = new PracticeStore(dbPath);
    try { assert.deepEqual(again.getNote(note.id)?.current.attachmentHashes, [file.hash]); again.integrityCheck(); } finally { again.close(); }
  } finally { if (raw.isOpen) raw.close(); legacy.close(); }
});
