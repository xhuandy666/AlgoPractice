import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import { PracticeStore, hashCode } from '../../src/storage/practice-store.ts';
import { PROBLEM_FSRS_PARAMETERS, PROBLEM_FSRS_VERSION } from '../../src/learning/fsrs.ts';
import type { AiRequestSeed, AiRequestSnapshot, AiResponse } from '../../src/shared/ai.ts';
import { restoreBackup } from '../restore-backup.ts';
import { SCHEMA_VERSION } from '../../src/storage/schema.ts';

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
    kind: 'hint', question: '给我方向', runId: null, run: null,
    provider: { id: 'local-fixture', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', temperature: 0, maxOutputTokens: 100, timeoutMs: 1000, jsonMode: true, includeUsage: false },
    messages: [{ role: 'user', content: '给我方向' }], clippedFields: [] };
  return { id, attemptId, snapshot, requestHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}
const response: AiResponse = { schemaVersion: 2, kind: 'hint', title: '方向', explanation: '先观察输入', nextSteps: [], evidence: [], inferences: [], patch: null, completeSolution: null, noteDraft: null };
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

/** The problem's review journal, oldest first. */
const reviewEvents = (store: PracticeStore, problemId: string) => store.getProblemReviewDetail(problemId, { limit: 100 }).events.items
  .slice().sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.createdAt.localeCompare(b.createdAt));

test('problem-level FSRS ratings and correction replay preserve original times', t => {
  const { store } = fixture(t);
  const plan = store.addProblemReview('p1');
  assert.equal(store.addProblemReview('p1').id, plan.id); assert.equal(plan.card, null); assert.equal(plan.dueAt, null);
  const times = ['2026-01-02T12:00:00.000Z', '2026-01-10T12:00:00.000Z', '2026-02-01T12:00:00.000Z'];
  const original = times.map((at, index) => store.recordProblemReview({ requestId: `r${index}`, problemId: 'p1', rating: [1, 3, 2][index] as 1 | 2 | 3 }, at).event);
  const before = store.getProblemReview('p1')!;
  assert.deepEqual(store.recordProblemReview({ requestId: 'r2', problemId: 'p1', rating: 2 }, times[2]).plan, before);
  assert.throws(() => store.recordProblemReview({ requestId: 'r2', problemId: 'p1', rating: 4 }, times[2]), /不同输入/);
  const correction = store.correctProblemReview({ requestId: 'correct-1', eventId: original[0].id, rating: 4 });
  const scheduler = fsrs(PROBLEM_FSRS_PARAMETERS); let expected = createEmptyCard(new Date(times[0]));
  for (const [index, at] of times.entries()) expected = scheduler.next(expected, new Date(at), ([Rating.Easy, Rating.Good, Rating.Hard] as const)[index]).card;
  assert.deepEqual(correction.plan.card, JSON.parse(JSON.stringify(expected)));
  assert.equal(correction.plan.algorithmVersion, PROBLEM_FSRS_VERSION);
  assert.equal(correction.event.observedAt, original[0].observedAt);
  assert.deepEqual(reviewEvents(store, 'p1').filter(event => event.kind === 'review').map(event => event.id), original.map(event => event.id));
  assert.deepEqual(store.correctProblemReview({ requestId: 'correct-1', eventId: original[0].id, rating: 4 }), correction);
  assert.ok(correction.plan.card); assert.equal(correction.plan.card.reps, 3, 'correction does not count as a fourth review');
});

test('one problem has one daily assessment while only the same request retries without a new observation', t => {
  const { store, attempt } = fixture(t);
  store.finishAttempt(attempt.id, { code: 'print(1)' });
  store.addProblemReview('p1');
  const first = store.recordProblemReview({ requestId: 'rate-1', problemId: 'p1', attemptId: attempt.id, rating: 3 });
  assert.deepEqual(store.recordProblemReview({ requestId: 'rate-1', problemId: 'p1', attemptId: attempt.id, rating: 3 }), first);
  assert.throws(() => store.recordProblemReview({ requestId: 'rate-2', problemId: 'p1', attemptId: attempt.id, rating: 3 }), /当天已有自评/);
  assert.throws(() => store.recordProblemReview({ requestId: 'rate-3', problemId: 'p1', attemptId: attempt.id, rating: 4 }), /当天已有自评/);
  assert.equal(reviewEvents(store, 'p1').length, 1);
  store.correctProblemReview({ requestId: 'change', eventId: first.event.id, rating: 4 });
  const retried = store.recordProblemReview({ requestId: 'rate-1', problemId: 'p1', attemptId: attempt.id, rating: 3 });
  assert.ok(retried.plan.card); assert.equal(retried.plan.card.reps, 1); assert.equal(retried.event.rating, 3, 'journal original remains immutable');
  assert.equal(store.getProblemReview('p1')!.latestRating, 4);
});

test('unsupported historical FSRS versions reject correction without appending an event or changing the card', t => {
  const { store, dbPath } = fixture(t);
  const plan = store.addProblemReview('p1');
  const review = store.recordProblemReview({ requestId: 'one', problemId: 'p1', rating: 3 });
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('DROP TRIGGER immutable_problem_review_plan');
    raw.prepare('UPDATE problem_review_plans SET algorithm_version = ? WHERE id = ?').run('unsupported-historical-version', plan.id);
    const before = store.getProblemReview('p1');
    assert.throws(() => store.correctProblemReview({ requestId: 'unsupported', eventId: review.event.id, rating: 1 }), /不支持该复习算法/);
    assert.deepEqual(store.getProblemReview('p1'), before); assert.equal(reviewEvents(store, 'p1').length, 1);
  } finally { raw.close(); }
});

test('daily budgets, DST timezone boundaries, suspension and postponement never rewrite FSRS due dates', t => {
  const { store } = fixture(t), start = '2026-03-06T04:00:00.000Z', at = '2026-03-08T07:30:00.000Z';
  store.updateLearningSettings({ timeZone: 'America/New_York' });
  const ids = Array.from({ length: 5 }, (_, index) => {
    const id = `queue-${index}`; store.startAttempt({ problemId: id, language: 'python', problemVersion: 'v1' });
    store.addProblemReview(id);
    store.recordProblemReview({ requestId: `initial-${index}`, problemId: id, rating: 1 }, start); return id;
  });
  const today = () => store.getReviewPlanSnapshot({ view: 'today', limit: 100 }, at).summary;
  const initial = today(); assert.equal(initial.date, '2026-03-08'); assert.equal(initial.plannedCount, 3);
  assert.equal(initial.overdueCount, 5, 'all five initial observations scheduled a prior learning day');
  store.recordProblemReview({ requestId: 'queue-review', problemId: ids[0], rating: 3 }, '2026-03-08T05:30:00.000Z');
  store.updateProblemReviews({ problemIds: [ids[1]], scheduledAt: '2026-03-08T15:00:00.000Z' });
  store.updateProblemReviews({ problemIds: [ids[2]], suspended: true });
  const savedDue = store.listProblemReviews().map(plan => [plan.id, plan.dueAt]);
  const queue = today(); assert.equal(queue.reviewedToday, 1); assert.equal(queue.remainingBudget, 2);
  assert.equal(queue.deferredCount, 1); assert.equal(queue.suspendedCount, 1); assert.equal(queue.plannedCount, 2, 'completed, paused and later-today problems are outside the recommended plan');
  store.updateLearningSettings({ dailyReviewBudget: 0, timeZone: 'Asia/Shanghai' });
  assert.equal(today().plannedCount, 0, 'zero budget does not admit already-assessed same-day relearning');
  store.updateLearningSettings({ dailyReviewBudget: null }); assert.equal(today().remainingBudget, null);
  assert.deepEqual(store.listProblemReviews().map(plan => [plan.id, plan.dueAt]), savedDue);
  assert.throws(() => store.updateLearningSettings({ timeZone: 'Not/AZone' }));
  assert.throws(() => store.updateLearningSettings({ dailyReviewBudget: -1 }));
});

test('AI completion commits atomically, interrupted calls recover once, and credentials are rejected', t => {
  const { store, attempt, dbPath } = fixture(t), input = seed(attempt.id);
  assert.equal(store.beginAIRequest(input).status, 'pending'); assert.equal(store.beginAIRequest(input).id, input.id);
  assert.throws(() => store.beginAIRequest({ ...input, requestHash: 'f'.repeat(64) }), /conflicts/);
  assert.throws(() => store.beginAIRequest({ ...seed(attempt.id, 'secret'), snapshot: { ...input.snapshot, provider: { ...input.snapshot.provider, apiKey: 'never-store-this' } } } as AiRequestSeed), /Credentials/);
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec("CREATE TRIGGER injected_completion_failure BEFORE UPDATE OF status ON ai_requests BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
    assert.throws(() => store.finishAIRequest(input.id, completed), /injected write failure/);
    assert.equal(store.getAIRequest(input.id)?.status, 'pending'); assert.equal(store.getAIRequest(input.id)?.response, null);
    raw.exec('DROP TRIGGER injected_completion_failure');
    const saved = store.finishAIRequest(input.id, completed);
    assert.deepEqual(store.finishAIRequest(input.id, completed), saved);
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

test('the store refuses to complete AI help during an active strict interview but not after it', t => {
  const { store } = fixture(t);
  const strict = store.startAttempt({ problemId: 'p1', language: 'python', problemVersion: 'v1', mode: 'strict' });
  const request = (id: string, isActive: boolean): AiRequestSeed => {
    const snapshot = { ...seed(strict.id, id).snapshot, mode: 'strict' as const, isActive };
    return { id, attemptId: strict.id, snapshot, requestHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
  };
  const active = request('strict-active', true), ended = request('strict-ended', false);
  store.beginAIRequest(active); store.beginAIRequest(ended);
  assert.throws(() => store.finishAIRequest(active.id, completed), /active strict interview/);
  assert.equal(store.getAIRequest(active.id)?.status, 'pending');
  assert.equal(store.getAIRequest(active.id)?.response, null);
  assert.equal(store.finishAIRequest(ended.id, completed).status, 'completed');
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
  assert.equal(inspected.schemaVersion, SCHEMA_VERSION); assert.deepEqual(inspected.mediaHashes, [mediaHash]);
  assert.deepEqual(inspected.attachments.map(file => file.hash).sort(), [firstFile.hash, secondFile.hash].sort());
  assert.deepEqual(inspected.learningSettings, settings);
  const restored = join(directory, 'restored.sqlite'); restoreBackup(target, restored);
  const copy = new PracticeStore(restored); try { assert.equal(copy.listNoteVersions(note.id).length, 2); assert.deepEqual(copy.getLearningSettings(), settings); } finally { copy.close(); }
});

test('AI usage sums what providers reported per learning day, month and model, and never estimates missing usage', t => {
  const { store, attempt } = fixture(t);
  store.updateLearningSettings({ timeZone: 'Asia/Shanghai' });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T15:30:00.000Z') });
  const ask = (id: string, at: string, usage: { totalTokens: number | null; calls: number } | null, model = 'fixture', finish = true) => {
    t.mock.timers.setTime(Date.parse(at));
    const base = seed(attempt.id, id), snapshot = { ...base.snapshot, provider: { ...base.snapshot.provider, model } };
    store.beginAIRequest({ ...base, snapshot, requestHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') });
    if (finish) store.finishAIRequest(id, { ...completed, usage: usage && { source: 'provider', inputTokens: null, outputTokens: null, ...usage } });
  };
  ask('october', '2026-10-31T15:30:00.000Z', { totalTokens: 100, calls: 1 });
  ask('unreported', '2026-11-05T02:00:00.000Z', null, 'other-model');
  ask('after-midnight', '2026-11-12T16:30:00.000Z', { totalTokens: 300, calls: 2 });
  ask('today', '2026-11-13T03:00:00.000Z', { totalTokens: 50, calls: 1 }, 'other-model');
  ask('pending', '2026-11-13T03:30:00.000Z', null, 'fixture', false);
  const usage = store.getAIUsageSummary('2026-11-13T04:00:00.000Z');
  assert.equal(usage.timeZone, 'Asia/Shanghai');
  assert.deepEqual(usage.today, { requests: 2, calls: 3, tokens: 350, unreported: 0 }, '00:30 in Shanghai already belongs to today');
  assert.deepEqual(usage.month, { requests: 3, calls: 3, tokens: 350, unreported: 1 }, '23:30 on 31 October belongs to October');
  assert.deepEqual(usage.all, { requests: 4, calls: 4, tokens: 450, unreported: 1 }, 'a request still running is not counted');
  assert.deepEqual(usage.monthByModel, [{ model: 'fixture', requests: 1, calls: 2, tokens: 300, unreported: 0 },
    { model: 'other-model', requests: 2, calls: 1, tokens: 50, unreported: 1 }]);
});
