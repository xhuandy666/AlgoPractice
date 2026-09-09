import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import { PracticeStore, hashCode } from '../../src/storage/practice-store.ts';
import { FSRS_PARAMETERS, FSRS_VERSION } from '../../src/learning/fsrs.ts';
import type { AiRequestSeed, AiRequestSnapshot, AiResponse } from '../../src/shared/ai.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice p3 学习 ')), dbPath = join(directory, 'practice.sqlite');
  const store = new PracticeStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const attempt = store.startAttempt({ problemId: 'p1', language: 'python', problemVersion: 'v1' });
  return { directory, dbPath, store, attempt };
}
function attachment(store: PracticeStore, name = '附件.txt', body = 'content') {
  const hash = createHash('sha256').update(body).digest('hex');
  return store.registerAttachment({ hash, name, size: Buffer.byteLength(body), mimeType: 'text/plain', createdAt: new Date().toISOString() });
}
function seed(attemptId: string, id = 'ai-1'): AiRequestSeed {
  const snapshot: AiRequestSnapshot = { policyVersion: 'test-policy', promptVersion: 'test-prompt', attemptId, problemId: 'p1', problemVersion: 'v1',
    language: 'python', mode: 'practice', isActive: true, draftScopeId: 'practice', draftRevision: 1, code: 'print(1)', codeHash: hashCode('print(1)'),
    kind: 'hint', level: 'L1', question: '给我方向', unlockCompleteSolution: false, runId: null, run: null,
    provider: { id: 'local-fixture', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', temperature: 0, maxOutputTokens: 100, timeoutMs: 1000, jsonMode: true, includeUsage: false },
    messages: [{ role: 'user', content: '给我方向' }], selectedNoteIds: [], selectedConversationIds: [], clippedFields: [] };
  return { id, attemptId, snapshot, requestHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}
const response: AiResponse = { schemaVersion: 1, kind: 'hint', level: 'L1', title: '方向', explanation: '先观察输入', nextSteps: [], evidence: [], inferences: [], patch: null, completeSolution: null, noteDraft: null };
const completed = { status: 'completed' as const, response, error: null, usage: null, cachedFromRequestId: null };

test('notes preserve confirmed versions across AI drafts, enforce CAS, and freeze the confirmed version in an ended attempt', t => {
  const { store, attempt, dbPath } = fixture(t), file = attachment(store);
  const input = { requestId: 'note-1', kind: 'problem' as const, subjectId: 'p1', title: '思路', markdown: '自己确认的思路',
    tags: ['数组'], state: 'confirmed' as const, attachmentHashes: [file.hash], expectedVersion: 0 };
  const first = store.saveNote(input);
  assert.equal(first.confirmedVersion, 1);
  assert.equal(store.saveNote(input).id, first.id);
  store.finishAttempt(attempt.id, { code: 'print(1)' });
  const ai = store.saveNote({ ...input, requestId: 'ai-draft', noteId: first.id, markdown: 'AI 尚未确认', state: 'draft', origin: 'ai', expectedVersion: 1, attachmentHashes: [] });
  assert.equal(ai.current.version, 2); assert.equal(ai.current.state, 'draft');
  assert.equal(ai.confirmed?.markdown, first.current.markdown);
  assert.deepEqual(store.getAttemptNoteVersions(attempt.id), [first.current]);
  assert.throws(() => store.saveNote({ ...input, requestId: 'late', noteId: first.id, expectedVersion: 1 }), /version conflict/);
  assert.throws(() => store.saveNote({ ...input, requestId: 'auto-confirm', origin: 'ai' }), /explicitly confirmed/);
  const confirmed = store.confirmNote({ requestId: 'confirm', noteId: first.id, version: 2, expectedVersion: 2 });
  assert.equal(confirmed.confirmedVersion, 3); assert.equal(confirmed.confirmed?.origin, 'ai');
  assert.deepEqual(store.getAttemptNoteVersions(attempt.id), [first.current]);
  assert.deepEqual(store.listAttachmentReferences(), [file], 'old attachment remains referenced by version 1');
  assert.equal(store.listNotes({ tag: '数组', search: '自己确认' })[0].id, first.id, 'search finds historical text and tags');
  assert.equal(store.listNotes({ search: '%' }).length, 0, 'search wildcards are literal text');
  const raw = new DatabaseSync(dbPath); try {
    assert.throws(() => raw.prepare('UPDATE note_versions SET markdown = ?').run('overwrite'), /immutable/);
    assert.throws(() => raw.prepare('UPDATE note_attachment_refs SET hash = hash').run(), /immutable/);
  } finally { raw.close(); }
  assert.throws(() => store.deleteNote(first.id, 2), /version conflict/);
  assert.equal(store.deleteNote(first.id, 3), true);
  assert.equal(store.getNote(first.id), undefined); assert.deepEqual(store.getAttemptNoteVersions(attempt.id), []);
  assert.deepEqual(store.listAttachmentReferences(), []); assert.equal(store.getAttachment(file.hash)?.hash, file.hash, 'unreferenced file metadata is conservatively retained');
  store.integrityCheck();
});

test('note write failures roll back the new version, confirmed head and attachment links together', t => {
  const { store, dbPath } = fixture(t), file = attachment(store);
  const first = store.saveNote({ requestId: 'n1', kind: 'topic', subjectId: '双指针', title: '不变量', markdown: 'KEEP', state: 'confirmed' });
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec("CREATE TRIGGER injected_disk_failure BEFORE INSERT ON note_attachment_refs BEGIN SELECT RAISE(ABORT, 'injected disk full'); END");
    assert.throws(() => store.saveNote({ requestId: 'n2', noteId: first.id, kind: first.kind, subjectId: first.subjectId, title: '新版本', markdown: 'lost', state: 'confirmed', expectedVersion: 1, attachmentHashes: [file.hash] }), /injected disk full/);
    assert.deepEqual(store.getNote(first.id), first); assert.equal(store.listNoteVersions(first.id).length, 1);
    assert.deepEqual(store.listAttachmentReferences(), []);
    raw.exec('DROP TRIGGER injected_disk_failure');
    assert.throws(() => store.saveNote({ requestId: 'missing-file', kind: 'topic', subjectId: 'x', title: 'x', markdown: '', attachmentHashes: ['f'.repeat(64)] }), /written and registered/);
    assert.equal(store.listNotes().length, 1);
  } finally { raw.close(); }
  store.integrityCheck();
});

test('real FSRS ratings and historical correction replay preserve original review times and isolate languages', t => {
  const { store } = fixture(t), createdAt = '2026-01-01T00:00:00.000Z';
  const py = store.addReviewItem({ problemId: 'p1', target: 'rewrite', language: 'python', now: createdAt });
  const java = store.addReviewItem({ problemId: 'p1', target: 'rewrite', language: 'java', now: createdAt });
  const concept = store.addReviewItem({ problemId: 'p1', target: 'understanding', language: 'none', now: createdAt });
  assert.equal(store.addReviewItem({ problemId: 'p1', target: 'rewrite', language: 'python' }).id, py.id);
  assert.throws(() => store.addReviewItem({ problemId: 'p1', target: 'understanding', language: 'python' }), /do not match/);
  const times = ['2026-01-02T12:00:00.000Z', '2026-01-10T12:00:00.000Z', '2026-02-01T12:00:00.000Z'];
  const original = times.map((reviewedAt, index) => store.recordReview({ requestId: `r${index}`, itemId: py.id, rating: [1, 3, 2][index] as 1 | 2 | 3, reviewedAt }).event);
  const before = store.getReviewItem(py.id)!;
  assert.deepEqual(store.recordReview({ requestId: 'r2', itemId: py.id, rating: 2, reviewedAt: times[2] }).item, before);
  assert.throws(() => store.recordReview({ requestId: 'r2', itemId: py.id, rating: 4, reviewedAt: times[2] }), /conflicts/);
  const correction = store.correctReview({ requestId: 'correct-1', eventId: original[0].id, rating: 4 });
  const scheduler = fsrs(FSRS_PARAMETERS); let expected = createEmptyCard(new Date(createdAt));
  for (const [index, at] of times.entries()) expected = scheduler.next(expected, new Date(at), ([Rating.Easy, Rating.Good, Rating.Hard] as const)[index]).card;
  assert.deepEqual(correction.item.card, JSON.parse(JSON.stringify(expected)));
  assert.equal(correction.item.algorithmVersion, FSRS_VERSION);
  assert.equal(correction.event.reviewedAt, original[0].reviewedAt);
  assert.deepEqual(store.listReviewEvents(py.id).slice(0, 3), original);
  assert.deepEqual(store.correctReview({ requestId: 'correct-1', eventId: original[0].id, rating: 4 }), correction);
  assert.deepEqual(store.getReviewItem(java.id), java); assert.deepEqual(store.getReviewItem(concept.id), concept);
  assert.equal(correction.item.card.reps, 3, 'correction does not count as a fourth review');
});

test('one attempt produces one feedback per review item even when reopened with a new request id', t => {
  const { store, attempt } = fixture(t);
  store.finishAttempt(attempt.id, { code: 'print(1)' });
  const item = store.addReviewItem({ problemId: 'p1', target: 'rewrite', language: 'python' });
  const first = store.recordReview({ requestId: 'rate-1', itemId: item.id, attemptId: attempt.id, rating: 3 });
  assert.deepEqual(store.recordReview({ requestId: 'rate-2', itemId: item.id, attemptId: attempt.id, rating: 3 }), first);
  assert.throws(() => store.recordReview({ requestId: 'rate-3', itemId: item.id, attemptId: attempt.id, rating: 4 }), /use rating correction/);
  assert.equal(store.listReviewEvents(item.id).length, 1);
  const java = store.addReviewItem({ problemId: 'p1', target: 'rewrite', language: 'java' });
  assert.throws(() => store.recordReview({ requestId: 'wrong-language', itemId: java.id, attemptId: attempt.id, rating: 3 }), /does not match/);
  store.correctReview({ requestId: 'change', eventId: first.event.id, rating: 4 });
  const retried = store.recordReview({ requestId: 'rate-4', itemId: item.id, attemptId: attempt.id, rating: 4 });
  assert.equal(retried.item.card.reps, 1); assert.equal(retried.event.rating, 4);
});

test('unsupported historical FSRS versions reject correction without appending an event or changing the card', t => {
  const { store, dbPath } = fixture(t);
  const item = store.addReviewItem({ problemId: 'p1', target: 'understanding', language: 'none' });
  const review = store.recordReview({ requestId: 'one', itemId: item.id, rating: 3 });
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('DROP TRIGGER immutable_review_identity');
    raw.prepare('UPDATE review_items SET algorithm_version = ? WHERE id = ?').run('unsupported-historical-version', item.id);
    const before = store.getReviewItem(item.id);
    assert.throws(() => store.correctReview({ requestId: 'unsupported', eventId: review.event.id, rating: 1 }), /Unsupported historical FSRS/);
    assert.deepEqual(store.getReviewItem(item.id), before); assert.equal(store.listReviewEvents(item.id).length, 1);
  } finally { raw.close(); }
});

test('daily budgets, DST timezone boundaries, suspension and postponement never rewrite FSRS due dates', t => {
  const { store } = fixture(t), start = '2026-03-08T04:00:00.000Z', at = '2026-03-08T07:30:00.000Z';
  store.updateLearningSettings({ timeZone: 'America/New_York' });
  const items = Array.from({ length: 5 }, (_, index) => {
    const id = `queue-${index}`; store.startAttempt({ problemId: id, language: 'python', problemVersion: 'v1' });
    return store.addReviewItem({ problemId: id, target: 'understanding', language: 'none', now: start });
  });
  const initial = store.getTodayQueue(at); assert.equal(initial.date, '2026-03-08'); assert.equal(initial.items.length, 3);
  assert.equal(initial.overdueCount, 5, '04:00 UTC is the previous local day');
  store.recordReview({ requestId: 'queue-review', itemId: items[0].id, rating: 3, reviewedAt: '2026-03-08T05:30:00.000Z' });
  store.setReviewPlan(items[1].id, { scheduledAt: '2026-03-09T12:00:00.000Z' });
  store.setReviewPlan(items[2].id, { suspended: true });
  const savedDue = store.listReviewItems().map(item => [item.id, item.dueAt]);
  const queue = store.getTodayQueue(at); assert.equal(queue.reviewedToday, 1); assert.equal(queue.remainingBudget, 2);
  assert.equal(queue.deferredCount, 1); assert.equal(queue.suspendedCount, 1); assert.equal(queue.items.length, 3, 'same-day relearning does not consume another problem slot');
  store.updateLearningSettings({ dailyReviewBudget: 0, timeZone: 'Asia/Shanghai' });
  assert.equal(store.getTodayQueue(at).items.length, 1);
  store.updateLearningSettings({ dailyReviewBudget: null }); assert.equal(store.getTodayQueue(at).remainingBudget, null);
  assert.deepEqual(store.listReviewItems().map(item => [item.id, item.dueAt]), savedDue);
  assert.throws(() => store.updateLearningSettings({ timeZone: 'Not/AZone' }));
  assert.throws(() => store.updateLearningSettings({ dailyReviewBudget: -1 }));
});

test('AI completion and help references commit together, interrupted calls recover once, and credentials are rejected', t => {
  const { store, attempt, dbPath } = fixture(t), input = seed(attempt.id);
  assert.equal(store.beginAIRequest(input).status, 'pending'); assert.equal(store.beginAIRequest(input).id, input.id);
  assert.throws(() => store.markAIHelpUsed(attempt.id, input.id, 'L1'), /completed request/);
  assert.throws(() => store.beginAIRequest({ ...input, requestHash: 'f'.repeat(64) }), /conflicts/);
  assert.throws(() => store.beginAIRequest({ ...seed(attempt.id, 'secret'), snapshot: { ...input.snapshot, provider: { ...input.snapshot.provider, apiKey: 'never-store-this' } } } as AiRequestSeed), /Credentials/);
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec("CREATE TRIGGER injected_help_failure BEFORE INSERT ON ai_help_used BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
    assert.throws(() => store.finishAIRequest(input.id, completed), /injected write failure/);
    assert.equal(store.getAIRequest(input.id)?.status, 'pending'); assert.equal(store.getAIRequest(input.id)?.response, null);
    raw.exec('DROP TRIGGER injected_help_failure');
    const saved = store.finishAIRequest(input.id, completed);
    assert.deepEqual(store.finishAIRequest(input.id, completed), saved);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM ai_help_used').get()?.n, 1);
    assert.deepEqual(store.setAIRequestPhase(input.id, 'streaming'), saved);
    assert.throws(() => raw.prepare('UPDATE ai_requests SET response_json = ? WHERE id = ?').run('{}', input.id), /immutable/);
  } finally { raw.close(); }
  for (const [index, phase] of ['pending', 'streaming', 'repairing'].entries()) {
    const entry = seed(attempt.id, `pending-${index}`); store.beginAIRequest(entry); if (phase !== 'pending') store.setAIRequestPhase(entry.id, phase as 'streaming' | 'repairing');
  }
  assert.equal(store.recoverInterruptedAIRequests(), 3); assert.equal(store.recoverInterruptedAIRequests(), 0);
  assert.equal(store.findCompletedAIRequest(input.requestHash)?.id, input.id);
  assert.equal(store.getAIRequest('pending-1')?.status, 'interrupted');
  assert.equal(store.markAIHelpShown(attempt.id), true); assert.equal(store.markAIHelpShown(attempt.id), false);
  store.dismissAIHelp(attempt.id); assert.equal(store.markAIHelpShown(attempt.id), false);
  const help = store.getAIHelpState(attempt.id); store.close();
  const reopened = new PracticeStore(dbPath); try { assert.deepEqual(reopened.getAIHelpState(attempt.id), help); assert.equal(reopened.getAIRequest(input.id)?.status, 'completed'); } finally { reopened.close(); }
});

test('activity is an idempotent bounded sample, not wall-clock attempt duration; sleep-sized samples are rejected', t => {
  const { store, attempt } = fixture(t), at = new Date().toISOString();
  const input = { requestId: 'pulse-1', attemptId: attempt.id, durationMs: 10000, occurredAt: at };
  const first = store.recordActivity(input); assert.deepEqual(store.recordActivity(input), first);
  assert.throws(() => store.recordActivity({ ...input, durationMs: 11000 }), /conflicts/);
  assert.throws(() => store.recordActivity({ ...input, requestId: 'slept', durationMs: 3600000 }), /activity duration/);
  assert.throws(() => store.recordActivity({ ...input, requestId: 'before', occurredAt: '2020-01-01T00:00:00Z' }), /outside the attempt/);
  store.recordActivity({ ...input, requestId: 'pulse-2', durationMs: 5000 });
  const statistics = store.getArchiveStatistics({ attemptId: attempt.id, timeZone: 'Asia/Shanghai' });
  assert.equal(statistics.activeMs, 15000); assert.equal(statistics.attempts, 1); assert.equal(statistics.days[0].activeMs, 15000);
  store.finishAttempt(attempt.id, { code: '' });
  assert.throws(() => store.recordActivity({ ...input, requestId: 'after', occurredAt: new Date(Date.now() + 60000).toISOString() }), /outside the attempt/);
});

test('backup snapshot lists historical attachment and media references with its own settings, independent of live changes', async t => {
  const { store, directory } = fixture(t), firstFile = attachment(store, 'old.txt', 'old'), secondFile = attachment(store, 'new.txt', 'new');
  const mediaHash = 'a'.repeat(64);
  store.upsertProblem({ id: 'media', title: '图示', source: 'local', difficulty: '简单', tags: [], description: `<img src="algopractice://app/media/${mediaHash}">`, descriptionFormat: 'html', constraints: [], mode: 'acm', cases: [], starter: {} });
  const note = store.saveNote({ requestId: 'backup-note', kind: 'topic', subjectId: '备份', title: '快照', markdown: 'old', attachmentHashes: [firstFile.hash], state: 'confirmed' });
  store.saveNote({ requestId: 'backup-note-v2', noteId: note.id, kind: note.kind, subjectId: note.subjectId, title: '快照', markdown: 'new', attachmentHashes: [secondFile.hash], expectedVersion: 1 });
  const settings = store.updateLearningSettings({ dailyReviewBudget: 7, timeZone: 'UTC' });
  const target = join(directory, 'snapshot.sqlite'); await store.backupTo(target);
  store.deleteNote(note.id, 2); store.updateLearningSettings({ dailyReviewBudget: 1 });
  const inspected = PracticeStore.inspectBackupSnapshot(target);
  assert.equal(inspected.schemaVersion, 5); assert.deepEqual(inspected.mediaHashes, [mediaHash]);
  assert.deepEqual(inspected.attachments.map(file => file.hash).sort(), [firstFile.hash, secondFile.hash].sort());
  assert.deepEqual(inspected.learningSettings, settings);
  const restored = join(directory, 'restored.sqlite'); PracticeStore.restoreBackup(target, restored);
  const copy = new PracticeStore(restored); try { assert.equal(copy.listNoteVersions(note.id).length, 2); assert.deepEqual(copy.getLearningSettings(), settings); } finally { copy.close(); }
});

test('schema 2 migration backs up committed WAL data and preserves every P2 row before adding learning tables', t => {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice-v2-migration ')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'practice.sqlite'), legacy = new DatabaseSync(dbPath);
  legacy.exec(readFileSync(new URL('../storage/fixtures/p2-schema.sql', import.meta.url), 'utf8'));
  legacy.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON');
  legacy.prepare('INSERT INTO problems VALUES (?)').run('p2');
  legacy.prepare('INSERT INTO problem_versions VALUES (?, ?, ?)').run('p2', 'v2', '{"title":"P2 原题"}');
  legacy.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?)').run('p2', 'python', 'practice', 'KEEP', hashCode('KEEP'), 9, '2026-09-08T00:00:00.000Z');
  const before = legacy.prepare('SELECT * FROM drafts').all();
  const upgraded = new PracticeStore(dbPath);
  try {
    assert.ok(upgraded.migrationBackupPath?.includes('.before-v5-'));
    assert.deepEqual(legacy.prepare('SELECT * FROM drafts').all(), before); assert.equal(legacy.prepare('PRAGMA user_version').get()?.user_version, 5);
    const backup = new DatabaseSync(upgraded.migrationBackupPath!, { readOnly: true });
    try { assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 2); assert.deepEqual(backup.prepare('SELECT * FROM drafts').all(), before); } finally { backup.close(); }
    assert.equal(upgraded.getDraft('p2', 'python')?.revision, 9); assert.deepEqual(upgraded.listNotes(), []); upgraded.integrityCheck();
    const restorePath = join(directory, 'restored-v2.sqlite'); PracticeStore.restoreBackup(upgraded.migrationBackupPath!, restorePath);
    const restored = new PracticeStore(restorePath); try { assert.equal(restored.getDraft('p2', 'python')?.code, 'KEEP'); } finally { restored.close(); }
  } finally { upgraded.close(); legacy.close(); }
});

test('failed schema 2 to 4 migration rolls back and retains an untouched usable source backup', t => {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice-v3-fail ')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'practice.sqlite'), legacy = new DatabaseSync(dbPath);
  legacy.exec(readFileSync(new URL('../storage/fixtures/p2-schema.sql', import.meta.url), 'utf8'));
  legacy.exec('CREATE TABLE review_items (conflicting_fixture TEXT) STRICT');
  assert.throws(() => new PracticeStore(dbPath), /Schema v5 migration failed/);
  try {
    assert.equal(legacy.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(legacy.prepare("SELECT name FROM sqlite_schema WHERE name = 'notes'").get(), undefined);
    assert.equal(legacy.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    const backup = readdirSync(directory).find(name => name.includes('.before-v5-') && name.endsWith('.sqlite'));
    assert.ok(backup); const archived = new DatabaseSync(join(directory, backup), { readOnly: true });
    try { assert.equal(archived.prepare('PRAGMA user_version').get()?.user_version, 2); } finally { archived.close(); }
  } finally { legacy.close(); }
});
