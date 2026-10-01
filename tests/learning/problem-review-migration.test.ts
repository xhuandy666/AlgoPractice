import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { advanceReviewCard, FSRS_PARAMETERS, FSRS_VERSION, newReviewCard, PROBLEM_FSRS_PARAMETERS, PROBLEM_FSRS_VERSION } from '../../src/learning/fsrs.ts';
import { REVIEW_MERGE_STRATEGY } from '../../src/learning/problem-review-repository.ts';
import { stripProblemReviewSchema } from '../storage/fixtures/pre-v9.ts';
import type { ReviewRating } from '../../src/shared/learning.ts';

type Row = Record<string, string | number | null>;
const anchor = '2026-01-01T00:00:00.000Z';
function hash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex');
}
function legacyRows(db: DatabaseSync) {
  return Object.fromEntries(['review_items', 'review_events', 'review_requests'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(anchor) });
  const directory = mkdtempSync(join(tmpdir(), 'tilian-review-legacy-')), path = join(directory, 'practice.sqlite');
  const old = new PracticeStore(path);
  old.updateLearningSettings({ timeZone: 'UTC' });
  for (const id of ['merged', 'nulls', 'paused', 'empty', 'tie']) {
    old.upsertProblem({ id, title: `旧题 ${id}`, source: 'local', difficulty: '简单', tags: [], description: '',
      descriptionFormat: 'plain', constraints: [], mode: 'function', cases: [], starter: { python: 'pass', java: 'class Solution {}' } });
  }
  const attempts = ['one', 'two'].map((_value, index) => {
    const attempt = old.startAttempt({ problemId: 'merged', problemVersion: 'v1', language: index === 0 ? 'python' : 'java' });
    old.finishAttempt(attempt.id, { code: index === 0 ? 'pass' : 'class Solution {}' }); return attempt.id;
  });
  old.close();
  const raw = new DatabaseSync(path); stripProblemReviewSchema(raw);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  let upgraded: PracticeStore | null = null;
  t.after(() => { upgraded?.close(); raw.close(); rmSync(directory, { recursive: true, force: true }); });
  const item = (id: string, problemId: string, target: 'understanding' | 'rewrite', language: 'none' | 'python' | 'java',
    suspended = false, scheduledAt: string | null = null, version = FSRS_VERSION, parameters = FSRS_PARAMETERS) => {
    const initial = newReviewCard(anchor), card = advanceReviewCard(initial, '2026-01-02T12:00:00.000Z', 3, FSRS_VERSION, FSRS_PARAMETERS);
    raw.prepare('INSERT INTO review_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, problemId, target, language,
      JSON.stringify(initial), JSON.stringify(card), version, JSON.stringify(parameters), card.due, scheduledAt, Number(suspended), anchor, anchor);
  };
  const review = (id: string, itemId: string, grade: ReviewRating, at: string, attemptId: string | null = null) => {
    const requestId = `old-${id}`;
    const input = { requestId, itemId, rating: grade, reviewedAt: at, ...(attemptId ? { attemptId } : {}) };
    raw.prepare("INSERT INTO review_events VALUES (?,?,?,'review',?,?,?,NULL,?,?)").run(id, requestId, itemId, grade, at, at, FSRS_VERSION, attemptId);
    raw.prepare('INSERT INTO review_requests VALUES (?,?,?)').run(requestId, hash(input), id); return input;
  };
  const correction = (id: string, sourceId: string, grade: ReviewRating, createdAt: string) => {
    const source = raw.prepare('SELECT * FROM review_events WHERE id=?').get(sourceId) as Row;
    const input = { requestId: `old-${id}`, eventId: sourceId, rating: grade };
    raw.prepare("INSERT INTO review_events VALUES (?,?,?,'correction',?,?,?,?,?,?)").run(id, input.requestId, source.item_id, grade,
      source.reviewed_at, createdAt, sourceId, FSRS_VERSION, source.attempt_id);
    raw.prepare('INSERT INTO review_requests VALUES (?,?,?)').run(input.requestId, hash({ operation: 'correction', ...input }), id); return input;
  };
  const upgrade = () => { upgraded = new PracticeStore(path); return upgraded; };
  const reopen = () => { upgraded?.close(); upgraded = new PracticeStore(path); return upgraded; };
  return { raw, directory, path, attempts, item, review, correction, upgrade, reopen };
}

test('v8 WAL migration merges only a shared nonnull attempt, applies last inserted corrections before conservative min and replays stable original times', t => {
  const f = fixture(t), firstAt = '2026-01-02T10:00:00.000Z', laterAt = '2026-01-02T11:00:00.000Z';
  f.item('py', 'merged', 'rewrite', 'python', false, '2026-02-10T12:00:00.000Z');
  f.item('java', 'merged', 'rewrite', 'java', false, '2026-02-20T12:00:00.000Z');
  f.item('concept', 'merged', 'understanding', 'none', true, '2026-03-20T12:00:00.000Z');
  const retryInput = f.review('py-origin', 'py', 4, laterAt, f.attempts[0]);
  f.review('java-origin', 'java', 3, firstAt, f.attempts[0]);
  f.review('concept-origin', 'concept', 4, laterAt, f.attempts[0]);
  f.correction('py-correction-first', 'py-origin', 1, '2026-01-06T12:00:00.000Z');
  // Deliberately earlier timestamp but later insertion: insertion sequence is the old authority.
  const correctionRetry = f.correction('py-correction-last', 'py-origin', 2, '2026-01-05T12:00:00.000Z');
  f.review('different-attempt', 'py', 4, laterAt, f.attempts[1]);
  f.item('null-concept', 'nulls', 'understanding', 'none'); f.item('null-py', 'nulls', 'rewrite', 'python');
  f.review('null-one', 'null-concept', 3, firstAt); f.review('null-two', 'null-py', 2, firstAt);
  const before = legacyRows(f.raw), store = f.upgrade();
  assert.equal(f.raw.prepare('PRAGMA user_version').get()!.user_version, 9);
  assert.ok(store.migrationBackupPath?.includes('.before-v9-'));
  const backup = new DatabaseSync(store.migrationBackupPath!, { readOnly: true });
  try { assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 8); assert.deepEqual(legacyRows(backup), before); }
  finally { backup.close(); }
  assert.deepEqual(legacyRows(f.raw), before, 'old card states, full parameters, events and request hashes remain byte-value exact');
  assert.equal(store.listProblemReviews().length, 2); assert.equal(store.listReviewItems().length, 2);
  const merged = store.getProblemReviewDetail('merged'), legacy = merged.events.items.filter(event => event.kind === 'review');
  assert.equal(legacy.length, 2, 'three shared-attempt cards merge once while another attempt stays independent');
  const shared = legacy.find(event => event.attemptId === f.attempts[0])!;
  assert.equal(shared.rating, 2); assert.equal(shared.observedAt, firstAt); assert.equal(shared.source, 'legacy');
  assert.equal(shared.isInitialAssessment, false, 'migration retains historical review semantics');
  assert.deepEqual(new Set(shared.legacySourceEventIds), new Set(['py-origin', 'java-origin', 'concept-origin', 'py-correction-first', 'py-correction-last']));
  assert.equal(merged.plan.suspended, false); assert.equal(merged.plan.scheduledAt, '2026-02-20T12:00:00.000Z', 'inactive-card deferral does not postpone an active unified plan');
  assert.equal(merged.migration.conflict, true); assert.equal(merged.migration.strategy, REVIEW_MERGE_STRATEGY);
  assert.equal(merged.legacySources!.total, 6); assert.equal(merged.legacySources!.items.filter(event => event.kind === 'correction').length, 2);
  assert.equal(merged.legacyPlans!.length, 3);
  for (const old of before.review_items as Row[]) {
    if (old.problem_id!=='merged') continue; const audit = merged.legacyPlans!.find(plan => plan.id===old.id)!;
    assert.deepEqual(audit.parameters, JSON.parse(String(old.parameters_json)));
    assert.deepEqual(audit.initialCard, JSON.parse(String(old.initial_card_json))); assert.deepEqual(audit.card, JSON.parse(String(old.card_json)));
    assert.equal(audit.dueAt, old.due_at); assert.equal(audit.algorithmVersion, old.algorithm_version);
  }
  assert.equal(store.getProblemReview('nulls')!.observationCount, 2, 'null provenance is never guessed to be the same attempt');
  assert.equal(store.getProblemReviewDetail('nulls').events.items.every(event => event.sourceDeleted === false), true, 'unassociated manual history is not falsely marked deleted');
  let expected = newReviewCard(anchor);
  for (const [at, grade] of [[firstAt, 2], [laterAt, 4]] as const) expected = advanceReviewCard(expected, at, grade, PROBLEM_FSRS_VERSION, PROBLEM_FSRS_PARAMETERS);
  assert.deepEqual(merged.plan.card, expected); assert.equal(merged.plan.algorithmVersion, PROBLEM_FSRS_VERSION);
  const slot = f.raw.prepare("SELECT event_id FROM problem_review_day_assessments WHERE problem_id='merged' AND learning_date='2026-01-02'").get()!;
  assert.equal(slot.event_id, legacy.find(event => event.attemptId === f.attempts[1])!.id, 'compatibility slot selects the most recent observation, not an arbitrary card');
  const daily = store.getReviewPlanSnapshot({}, '2026-01-02T23:00:00.000Z').summary;
  assert.equal(daily.reviewedToday, 2, 'multiple historical observations count as two distinct problems'); assert.equal(daily.firstAssessedToday, 0);
  assert.equal(store.getLearningDashboard('2026-01', '2026-01-02T23:00:00.000Z').days.at(-1)!.reviewCount, 2);
  assert.equal(store.recordReview(retryInput).event.id, shared.id, 'old request and old item ID resolve without another observation');
  assert.equal(store.correctReview(correctionRetry).event.id, shared.id, 'old correction request hash uses the exact original old-event input');
  assert.equal(store.getProblemReview('merged')!.observationCount, 2);
  assert.throws(() => store.recordReview({ ...retryInput, rating: 1 }), /不同输入/);
  assert.throws(() => store.correctReview({ ...correctionRetry, rating: 4 }), /不同输入/);
  t.mock.timers.setTime(Date.parse('2026-01-02T23:00:00.000Z'));
  assert.throws(() => store.recordProblemReview({ requestId: 'same-migration-day', problemId: 'merged', rating: 4 }), /当天已有自评/);
  const changed = store.correctProblemReview({ requestId: 'new-correction', eventId: 'py-origin', rating: 4 });
  assert.equal(changed.event.correctsEventId, shared.id); assert.equal(changed.plan.observationCount, 2);
  assert.deepEqual(legacyRows(f.raw), before, 'new unified corrections never rewrite any legacy source');
  assert.equal(store.getProblemReviewDetail('merged', { limit: 1 }).legacySources!.items.length, 1);
  assert.equal(store.getProblemReviewDetail('merged', { limit: 1 }).legacySources!.hasMore, true);
  store.integrityCheck();
});

test('same-time null observations use stable original IDs, all-paused conflicts keep the latest deferral, and old empty cards remain unassessed', t => {
  const f = fixture(t), time = '2026-01-02T12:00:00.000Z';
  f.item('tie-py', 'tie', 'rewrite', 'python'); f.item('tie-concept', 'tie', 'understanding', 'none');
  f.review('z-original', 'tie-py', 4, time); f.review('a-original', 'tie-concept', 1, time);
  f.item('paused-py', 'paused', 'rewrite', 'python', true, '2026-02-01T12:00:00.000Z');
  f.item('paused-java', 'paused', 'rewrite', 'java', true, '2026-03-01T12:00:00.000Z');
  f.item('empty-concept', 'empty', 'understanding', 'none');
  const before = legacyRows(f.raw), store = f.upgrade();
  let expected = newReviewCard(anchor);
  expected = advanceReviewCard(expected, time, 1, PROBLEM_FSRS_VERSION, PROBLEM_FSRS_PARAMETERS);
  expected = advanceReviewCard(expected, time, 4, PROBLEM_FSRS_VERSION, PROBLEM_FSRS_PARAMETERS);
  assert.deepEqual(store.getProblemReview('tie')!.card, expected, 'stable a-before-z ordering wins over insertion order');
  const tieEvents = store.getProblemReviewDetail('tie').events.items.filter(event => event.kind === 'review');
  const slot = f.raw.prepare("SELECT event_id FROM problem_review_day_assessments WHERE problem_id='tie'").get()!;
  assert.equal(slot.event_id, tieEvents.find(event => event.legacySourceEventIds.includes('z-original'))!.id);
  const paused = store.getProblemReviewDetail('paused');
  assert.equal(paused.plan.suspended, true); assert.equal(paused.plan.scheduledAt, '2026-03-01T12:00:00.000Z'); assert.equal(paused.migration.conflict, true);
  assert.equal(paused.plan.card, null); assert.equal(paused.plan.dueAt, null);
  const empty = store.getProblemReview('empty')!; assert.equal(empty.card, null); assert.equal(empty.dueAt, null); assert.equal(empty.observationCount, 0);
  assert.deepEqual(legacyRows(f.raw), before);
  const report = f.raw.prepare('SELECT report_json FROM problem_review_migrations').get()!.report_json;
  const planRows = f.raw.prepare('SELECT * FROM problem_review_plans ORDER BY id').all();
  const eventRows = f.raw.prepare('SELECT * FROM problem_review_events ORDER BY sequence').all();
  const mappings = f.raw.prepare('SELECT * FROM review_legacy_links ORDER BY old_item_id,old_event_id').all();
  const reopened = f.reopen();
  assert.equal(reopened.migrationBackupPath, null); assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM problem_review_migrations').get()!.n, 1);
  assert.equal(f.raw.prepare('SELECT report_json FROM problem_review_migrations').get()!.report_json, report);
  assert.deepEqual(f.raw.prepare('SELECT * FROM problem_review_plans ORDER BY id').all(), planRows);
  assert.deepEqual(f.raw.prepare('SELECT * FROM problem_review_events ORDER BY sequence').all(), eventRows);
  assert.deepEqual(f.raw.prepare('SELECT * FROM review_legacy_links ORDER BY old_item_id,old_event_id').all(), mappings);
  assert.throws(() => f.raw.prepare('UPDATE review_items SET scheduled_at=NULL').run(), /read.only/);
  assert.throws(() => f.raw.prepare("INSERT INTO review_requests VALUES ('illegal','hash','a-original')").run(), /use problem review requests/);
  reopened.integrityCheck();
});

for (const invalid of ['version', 'parameters'] as const) test(`unsupported old ${invalid} rolls the whole v9 migration back and publishes an unchanged v8 WAL backup`, t => {
  const f = fixture(t); f.item('valid-first', 'empty', 'understanding', 'none');
  f.item('unsupported', 'merged', 'rewrite', 'python', false, null,
    invalid === 'version' ? 'unknown-fsrs' : FSRS_VERSION,
    invalid === 'parameters' ? { ...FSRS_PARAMETERS, request_retention: 0.8 } : FSRS_PARAMETERS);
  f.review('valid-original', 'valid-first', 3, '2026-01-02T12:00:00.000Z');
  const before = legacyRows(f.raw), schema = f.raw.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  assert.throws(() => f.upgrade(), /Schema v9 migration failed/);
  assert.equal(f.raw.prepare('PRAGMA user_version').get()!.user_version, 8);
  assert.deepEqual(legacyRows(f.raw), before); assert.deepEqual(f.raw.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
  assert.equal(f.raw.prepare("SELECT 1 FROM sqlite_schema WHERE name='problem_review_plans'").get(), undefined);
  const backupName = readdirSync(f.directory).find(name => name.includes('.before-v9-') && name.endsWith('.sqlite')); assert.ok(backupName);
  const backup = new DatabaseSync(join(f.directory, backupName), { readOnly: true });
  try { assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 8); assert.deepEqual(legacyRows(backup), before); }
  finally { backup.close(); }
});

test('new backup restore preserves canonical projections, raw old history, compatibility mappings and day deduplication', async t => {
  const f = fixture(t); f.item('backup-old', 'merged', 'understanding', 'none');
  const input = f.review('backup-rating', 'backup-old', 3, '2026-01-02T12:00:00.000Z', f.attempts[0]);
  const store = f.upgrade(), detail = store.getProblemReviewDetail('merged'), before = legacyRows(f.raw);
  const target = join(f.directory, 'new-v9-backup.sqlite'); await store.backupTo(target);
  assert.equal(PracticeStore.inspectBackupSnapshot(target).schemaVersion, 9);
  const restoredPath = join(f.directory, 'restored.sqlite'); PracticeStore.restoreBackup(target, restoredPath);
  const restored = new PracticeStore(restoredPath), copy = new DatabaseSync(restoredPath);
  try {
    assert.equal(restored.migrationBackupPath, null); assert.deepEqual(restored.getProblemReviewDetail('merged'), detail);
    assert.deepEqual(legacyRows(copy), before); assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM review_legacy_links').get()!.n, 2);
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM problem_review_day_assessments').get()!.n, 1);
    assert.equal(restored.recordReview(input).event.id, detail.events.items[0].id); assert.equal(restored.getProblemReview('merged')!.observationCount, 1);
    restored.integrityCheck();
  } finally { restored.close(); copy.close(); }
});
