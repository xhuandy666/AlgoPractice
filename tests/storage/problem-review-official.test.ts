import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PracticeStore, hashCode } from '../../src/storage/practice-store.ts';
import type { BeginOfficialSubmissionInput } from '../../src/shared/official.ts';
import { stripProblemReviewSchema } from './fixtures/pre-v9.ts';

const accepted = { status: 'accepted' as const, statusCode: 10, statusMessage: 'Accepted' };
const wrongAnswer = { status: 'wrong_answer' as const, statusMessage: 'Wrong Answer' };

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-problem-review-official-'));
  const dbPath = join(directory, 'practice.sqlite');
  const store = new PracticeStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.updateLearningSettings({ timeZone: 'UTC' });
  const problem = store.upsertProblem({ id: 'leetcode:two-sum', source: 'leetcode-cn', sourceUrl: 'https://leetcode.cn/problems/two-sum/', sourceId: '987',
    title: '两数之和', difficulty: '简单', tags: [], description: '测试题面', descriptionFormat: 'plain', constraints: [], mode: 'function', cases: [],
    starter: { python: 'class Solution:\n    pass', java: 'class Solution {}' } });
  const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language: 'python', problemSnapshot: problem.content as never });
  const draft = store.saveDraft({ problemId: problem.id, language: 'python', code: problem.content.starter.python! });
  const input: BeginOfficialSubmissionInput = { requestId: 'first-submission', attemptId: attempt.id, code: draft.code,
    expectedDraftRevision: draft.revision, slug: 'two-sum', sourceId: '987' };
  const begin = (requestId: string, submissionId: string, source = input) => {
    const record = store.beginOfficialSubmission({ ...source, requestId });
    return store.updateOfficialSubmission(record.id, { status: 'judging', submissionId });
  };
  return { directory, dbPath, store, problem, attempt, input, begin };
}

test('only newly confirmed official Accepted creates eligibility, failure does not occupy it or finish the attempt', t => {
  const f = fixture(t);
  f.begin('wrong', '101');
  f.store.updateOfficialSubmission('wrong', { status: 'completed', result: wrongAnswer });
  assert.equal(f.store.reviewOpportunities().total, 0);
  f.begin('accepted', '102');
  const record = f.store.updateOfficialSubmission('accepted', { status: 'completed', result: accepted });
  const opportunity = f.store.getReviewOpportunityForSubmission(record.id)!;
  assert.equal(opportunity.state, 'pending');
  assert.equal(opportunity.problemId, f.problem.id);
  assert.equal(opportunity.acceptedAt, record.finishedAt);
  assert.equal(opportunity.officialSubmissionId, '102');
  assert.equal(opportunity.codeHash, hashCode(f.input.code));
  assert.equal(opportunity.problemVersion, f.problem.version);
  assert.equal(f.store.getAttempt(f.attempt.id)?.endedAt, null);
  assert.equal(f.store.getProblemReview(f.problem.id)?.dueAt, null, 'AC alone is not a rating');
  assert.equal(f.store.getProblemReview(f.problem.id)?.observationCount, 0);
  assert.deepEqual(f.store.updateOfficialSubmission('accepted', { status: 'completed', result: accepted }), record);
  f.store.listOfficialSubmissions(f.attempt.id);
  f.store.getSubmissionHistoryDetail('official', record.id);
  assert.equal(f.store.reviewOpportunities().total, 1, 'terminal retry and history reads never create another opportunity');
  f.store.integrityCheck();
});

test('local passes and ending an attempt never create official assessment eligibility', t => {
  const f = fixture(t);
  const run = f.store.saveRun({ attemptId: f.attempt.id, code: f.input.code,
    testSuiteVersion: 'local-samples', adapterVersion: 'local-function-v1', runtimeVersion: 'test-runtime' });
  f.store.finishRun(run.id, { status: 'passed', result: { passed: 1, total: 1 } });
  f.store.finishAttempt(f.attempt.id);
  assert.equal(f.store.reviewOpportunities().total, 0);
  assert.equal(f.store.getProblemReview(f.problem.id), undefined);
});

test('unknown submits, authentication failures and paused results do not consume the daily opportunity', t => {
  const f = fixture(t);
  f.store.beginOfficialSubmission({ ...f.input, requestId: 'unknown-post' });
  f.store.updateOfficialSubmission('unknown-post', { status: 'unknown', error: { code: 'network', message: '送达状态不确定' } });
  f.store.beginOfficialSubmission({ ...f.input, requestId: 'authentication-failed' });
  f.store.updateOfficialSubmission('authentication-failed', { status: 'error', error: { code: 'authentication', message: '需要登录' } });
  f.begin('known-paused', '103');
  f.store.updateOfficialSubmission('known-paused', { status: 'paused' });
  assert.equal(f.store.reviewOpportunities().total, 0);
  f.store.updateOfficialSubmission('known-paused', { status: 'judging' });
  f.store.updateOfficialSubmission('known-paused', { status: 'completed', result: accepted });
  assert.equal(f.store.reviewOpportunities().total, 1);
});

test('same-day Accepted across language and changed problem versions uses one immutable first-confirmed opportunity', t => {
  const f = fixture(t);
  f.begin('python-ac', '201');
  f.store.updateOfficialSubmission('python-ac', { status: 'completed', result: accepted });
  const first = f.store.reviewOpportunities().items[0];
  const javaAttempt = f.store.startAttempt({ problemId: f.problem.id, problemVersion: f.problem.version, language: 'java', problemSnapshot: f.problem.content as never });
  const javaDraft = f.store.saveDraft({ problemId: f.problem.id, language: 'java', code: f.problem.content.starter.java! });
  f.begin('java-ac', '202', { ...f.input, attemptId: javaAttempt.id, code: javaDraft.code, expectedDraftRevision: javaDraft.revision });
  f.store.updateOfficialSubmission('java-ac', { status: 'completed', result: accepted });
  f.store.finishAttempt(f.attempt.id);
  const changed = f.store.upsertProblem({ ...f.problem.content, description: '更新后的测试题面' });
  const another = f.store.startAttempt({ problemId: changed.id, problemVersion: changed.version, language: 'python', problemSnapshot: changed.content as never });
  const anotherDraft = f.store.saveDraft({ problemId: changed.id, language: 'python', code: 'class Solution:\n    pass' });
  f.begin('new-version-ac', '203', { ...f.input, attemptId: another.id, expectedDraftRevision: anotherDraft.revision });
  f.store.updateOfficialSubmission('new-version-ac', { status: 'completed', result: accepted });
  assert.equal(f.store.reviewOpportunities().total, 1);
  assert.deepEqual(f.store.reviewOpportunities().items[0], first);
  assert.equal(f.store.listProblemReviews().length, 1);
});

test('learning date follows terminal confirmation, and timezone changes do not re-bucket existing submissions', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T15:59:00.000Z') });
  const f = fixture(t);
  f.store.updateLearningSettings({ timeZone: 'Asia/Shanghai' });
  f.begin('before-midnight', '301');
  t.mock.timers.setTime(Date.parse('2026-10-01T16:01:00.000Z'));
  const completed = f.store.updateOfficialSubmission('before-midnight', { status: 'completed', result: accepted });
  const frozen = f.store.getReviewOpportunityForSubmission(completed.id)!;
  assert.equal(frozen.learningDate, '2026-10-02');
  assert.equal(frozen.timeZone, 'Asia/Shanghai');
  assert.equal(frozen.acceptedAt, completed.finishedAt);
  f.store.updateLearningSettings({ timeZone: 'UTC' });
  f.store.updateOfficialSubmission(completed.id, { status: 'completed', result: accepted });
  assert.deepEqual(f.store.getReviewOpportunityForSubmission(completed.id), frozen);
  f.begin('new-timezone-ac', '302');
  f.store.updateOfficialSubmission('new-timezone-ac', { status: 'completed', result: accepted });
  const next = f.store.getReviewOpportunityForSubmission('new-timezone-ac')!;
  assert.equal(next.learningDate, '2026-10-01');
  assert.equal(next.timeZone, 'UTC');
  assert.equal(f.store.reviewOpportunities().total, 2);
});

test('the next learning day has a new opportunity while an unclaimed old-day result remains manual-only', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T12:00:00.000Z') });
  const f = fixture(t);
  f.begin('day-one', '303');
  f.store.updateOfficialSubmission('day-one', { status: 'completed', result: accepted });
  const old = f.store.getReviewOpportunityForSubmission('day-one')!;
  t.mock.timers.setTime(Date.parse('2026-10-02T12:00:00.000Z'));
  assert.equal(f.store.claimReviewOpportunity(old.id), null);
  f.begin('day-two', '304');
  f.store.updateOfficialSubmission('day-two', { status: 'completed', result: accepted });
  const today = f.store.getReviewOpportunityForSubmission('day-two')!;
  assert.notEqual(today.id, old.id);
  assert.equal(today.learningDate, '2026-10-02');
  assert.ok(f.store.claimReviewOpportunity(today.id));
  assert.equal(f.store.reviewOpportunities({ pendingOnly: true }).total, 2, 'the previous day is still available for explicit delayed assessment');
});

test('a late result cannot replace the submission that first committed Accepted', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T12:00:00.000Z') });
  const f = fixture(t);
  f.begin('early-post-late-result', '401');
  const javaAttempt = f.store.startAttempt({ problemId: f.problem.id, problemVersion: f.problem.version, language: 'java', problemSnapshot: f.problem.content as never });
  const draft = f.store.saveDraft({ problemId: f.problem.id, language: 'java', code: f.problem.content.starter.java! });
  f.begin('late-post-first-result', '402', { ...f.input, attemptId: javaAttempt.id, code: draft.code, expectedDraftRevision: draft.revision });
  const first = f.store.updateOfficialSubmission('late-post-first-result', { status: 'completed', result: accepted });
  t.mock.timers.setTime(Date.parse('2026-10-01T12:05:00.000Z'));
  f.store.updateOfficialSubmission('early-post-late-result', { status: 'completed', result: accepted });
  const opportunities = f.store.reviewOpportunities();
  assert.equal(opportunities.total, 1);
  assert.equal(opportunities.items[0].submissionRecordId, first.id);
  assert.equal(opportunities.items[0].officialSubmissionId, '402');
  assert.equal(opportunities.items[0].acceptedAt, first.finishedAt);
});

test('an eligibility write failure rolls official completion and plan creation back in the same transaction', t => {
  const f = fixture(t);
  f.begin('atomic-result', '501');
  const raw = new DatabaseSync(f.dbPath);
  try {
    raw.exec(`CREATE TRIGGER test_refuse_ac_opportunity BEFORE INSERT ON review_daily_ac_opportunities
      BEGIN SELECT RAISE(ABORT, 'injected opportunity failure'); END;`);
    assert.throws(() => f.store.updateOfficialSubmission('atomic-result', { status: 'completed', result: accepted }), /injected opportunity failure/);
    assert.equal(f.store.getOfficialSubmission('atomic-result')?.status, 'judging');
    assert.equal(f.store.getOfficialSubmission('atomic-result')?.result, null);
    assert.equal(f.store.getOfficialSubmission('atomic-result')?.finishedAt, null);
    assert.equal(f.store.reviewOpportunities().total, 0);
    assert.equal(f.store.getProblemReview(f.problem.id), undefined);
    raw.exec('DROP TRIGGER test_refuse_ac_opportunity');
    f.store.updateOfficialSubmission('atomic-result', { status: 'completed', result: accepted });
    assert.equal(f.store.reviewOpportunities().total, 1);
  } finally { raw.close(); }
  f.store.integrityCheck();
});

test('manual assessment before Accepted resolves eligibility without changing its rating or adding a pending task', t => {
  const f = fixture(t);
  const assessment = f.store.recordProblemReview({ requestId: 'manual-first', problemId: f.problem.id, rating: 2 });
  f.begin('already-assessed-ac', '601');
  f.store.updateOfficialSubmission('already-assessed-ac', { status: 'completed', result: accepted });
  const opportunity = f.store.getReviewOpportunityForSubmission('already-assessed-ac')!;
  assert.equal(opportunity.state, 'assessed');
  assert.equal(opportunity.assessmentEventId, assessment.event.id);
  assert.equal(f.store.reviewOpportunities({ pendingOnly: true }).total, 0);
  assert.equal(f.store.claimReviewOpportunity(opportunity.id), null);
  const details = f.store.getProblemReviewDetail(f.problem.id);
  assert.equal(details.events.total, 1);
  assert.equal(details.events.items[0].source, 'manual');
  assert.equal(details.events.items[0].effectiveRating, 2);
});

test('explicit resume after an ended attempt can register Accepted; deleting its archive retains minimal eligibility and permits delayed assessment', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T12:00:00.000Z') });
  const f = fixture(t);
  f.begin('resumed-after-end', '701');
  f.store.updateOfficialSubmission('resumed-after-end', { status: 'paused' });
  f.store.finishAttempt(f.attempt.id);
  f.store.updateOfficialSubmission('resumed-after-end', { status: 'judging' });
  const completed = f.store.updateOfficialSubmission('resumed-after-end', { status: 'completed', result: accepted });
  const original = f.store.getReviewOpportunityForSubmission(completed.id)!;
  assert.equal(original.state, 'pending');
  f.store.deleteEndedAttempt(f.attempt.id);
  assert.equal(f.store.getOfficialSubmission(completed.id), undefined);
  const preserved = f.store.reviewOpportunities().items[0];
  assert.equal(preserved.id, original.id);
  assert.equal(preserved.attemptId, null);
  assert.equal(preserved.submissionRecordId, null);
  assert.equal(preserved.sourceDeleted, true);
  assert.equal(preserved.officialSubmissionId, '701');
  assert.equal(preserved.codeHash, original.codeHash);
  assert.equal(preserved.problemVersion, original.problemVersion);
  const nextAttempt = f.store.startAttempt({ problemId: f.problem.id, problemVersion: f.problem.version,
    language: 'python', problemSnapshot: f.problem.content as never });
  f.begin('after-source-deletion', '702', { ...f.input, attemptId: nextAttempt.id });
  f.store.updateOfficialSubmission('after-source-deletion', { status: 'completed', result: accepted });
  assert.equal(f.store.reviewOpportunities().total, 1, 'source deletion must not delete or rebind the daily ledger');
  assert.equal(f.store.reviewOpportunities().items[0].officialSubmissionId, '701');
  t.mock.timers.setTime(Date.parse('2026-10-03T12:00:00.000Z'));
  f.store.updateLearningSettings({ timeZone: 'Pacific/Kiritimati' });
  const result = f.store.submitReviewOpportunity({ requestId: 'delayed-deleted-source', opportunityId: preserved.id, rating: 3 });
  assert.equal(result.event.observedAt, completed.finishedAt);
  assert.equal(result.event.learningDate, original.learningDate);
  assert.equal(result.event.timeZone, original.timeZone);
  assert.equal(result.event.source, 'official');
  assert.equal(result.event.sourceDeleted, true);
  assert.equal(f.store.reviewOpportunities({ pendingOnly: true }).total, 0);
  f.store.integrityCheck();
});

test('archive learning-day lookup uses the frozen new review observation date instead of re-bucketing after a timezone change', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-27T12:00:00.000Z') });
  const f = fixture(t);
  f.begin('archive-source', '703');
  f.store.updateOfficialSubmission('archive-source', { status: 'paused' });
  f.store.finishAttempt(f.attempt.id);
  t.mock.timers.setTime(Date.parse('2026-10-01T12:00:00.000Z'));
  f.store.updateOfficialSubmission('archive-source', { status: 'judging' });
  f.store.updateOfficialSubmission('archive-source', { status: 'completed', result: accepted });
  const opportunity = f.store.getReviewOpportunityForSubmission('archive-source')!;
  t.mock.timers.setTime(Date.parse('2026-10-03T12:00:00.000Z'));
  f.store.updateLearningSettings({ timeZone: 'Pacific/Kiritimati' });
  f.store.submitReviewOpportunity({ requestId: 'archive-delayed-assessment', opportunityId: opportunity.id, rating: 3 });
  assert.deepEqual(f.store.listAttemptPage({ learningDate: '2026-10-01' }).items.map(item => item.attempt.id), [f.attempt.id]);
  assert.equal(f.store.listAttemptPage({ learningDate: '2026-10-02' }).total, 0);
});

test('claimed display attempts and skipped pending assessments survive backup and restart without replaying results', async t => {
  const f = fixture(t);
  f.begin('backup-ac', '801');
  f.store.updateOfficialSubmission('backup-ac', { status: 'completed', result: accepted });
  const opportunity = f.store.getReviewOpportunityForSubmission('backup-ac')!;
  assert.ok(f.store.claimReviewOpportunity(opportunity.id));
  assert.equal(f.store.claimReviewOpportunity(opportunity.id), null);
  f.store.skipReviewOpportunity(opportunity.id);
  const before = f.store.reviewOpportunities().items[0];
  const backup = join(f.directory, 'new-schema-backup.sqlite');
  await f.store.backupTo(backup);
  assert.equal(PracticeStore.inspectBackupSnapshot(backup).schemaVersion, 9);
  const restoredPath = join(f.directory, 'restored.sqlite');
  PracticeStore.restoreBackup(backup, restoredPath);
  const restored = new PracticeStore(restoredPath);
  try {
    assert.equal(restored.migrationBackupPath, null);
    assert.deepEqual(restored.reviewOpportunities().items[0], before);
    assert.equal(restored.claimReviewOpportunity(before.id), null);
    assert.equal(restored.reviewOpportunities({ pendingOnly: true }).total, 1);
    restored.updateOfficialSubmission('backup-ac', { status: 'completed', result: accepted });
    assert.equal(restored.reviewOpportunities().total, 1);
    restored.integrityCheck();
  } finally { restored.close(); }
});

test('independent consumers compete through the persisted claim rather than their own memory', t => {
  const f = fixture(t);
  f.begin('two-consumers-ac', '802');
  f.store.updateOfficialSubmission('two-consumers-ac', { status: 'completed', result: accepted });
  const second = new PracticeStore(f.dbPath);
  try {
    const firstView = f.store.getReviewOpportunityForSubmission('two-consumers-ac')!;
    const secondView = second.getReviewOpportunityForSubmission('two-consumers-ac')!;
    assert.equal(firstView.state, 'pending');
    assert.equal(secondView.state, 'pending');
    assert.ok(f.store.claimReviewOpportunity(firstView.id));
    assert.equal(second.claimReviewOpportunity(secondView.id), null);
    assert.equal(second.reviewOpportunities().items[0].state, 'claimed');
  } finally { second.close(); }
});

test('schema8 backup includes committed WAL, upgrades without reapplying v8, and seeds historical Accepted silently', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T12:00:00.000Z') });
  const f = fixture(t);
  f.begin('legacy-ac', '901');
  f.store.updateOfficialSubmission('legacy-ac', { status: 'completed', result: accepted });
  f.store.close();
  const legacy = new DatabaseSync(f.dbPath);
  stripProblemReviewSchema(legacy);
  legacy.exec('PRAGMA journal_mode=WAL;');
  legacy.prepare('UPDATE drafts SET code=?,code_hash=?,revision=revision+1 WHERE problem_id=?').run('committed WAL draft', hashCode('committed WAL draft'), f.problem.id);
  const upgraded = new PracticeStore(f.dbPath);
  try {
    assert.ok(upgraded.migrationBackupPath?.includes('.before-v9-'));
    assert.ok(existsSync(upgraded.migrationBackupPath!));
    assert.equal(PracticeStore.inspectBackupSnapshot(upgraded.migrationBackupPath!).schemaVersion, 8);
    const saved = new DatabaseSync(upgraded.migrationBackupPath!, { readOnly: true });
    try { assert.equal(saved.prepare('SELECT code FROM drafts WHERE problem_id=?').get(f.problem.id)?.code, 'committed WAL draft'); }
    finally { saved.close(); }
    assert.equal(upgraded.getDraft(f.problem.id, 'python')?.code, 'committed WAL draft');
    const historical = upgraded.reviewOpportunities().items[0];
    assert.equal(historical.state, 'historical');
    assert.equal(historical.historicalBaseline, true);
    assert.equal(upgraded.reviewOpportunities({ pendingOnly: true }).total, 0);
    assert.equal(upgraded.claimReviewOpportunity(historical.id), null);
    const currentDraft = upgraded.getDraft(f.problem.id, 'python')!;
    upgraded.beginOfficialSubmission({ ...f.input, requestId: 'post-upgrade-same-day', code: currentDraft.code, expectedDraftRevision: currentDraft.revision });
    upgraded.updateOfficialSubmission('post-upgrade-same-day', { status: 'judging', submissionId: '902' });
    upgraded.updateOfficialSubmission('post-upgrade-same-day', { status: 'completed', result: accepted });
    assert.equal(upgraded.reviewOpportunities().total, 1);
    assert.equal(upgraded.reviewOpportunities({ pendingOnly: true }).total, 0);
    assert.equal(upgraded.reviewOpportunities().items[0].officialSubmissionId, '901');
    const restoredPath = join(f.directory, 'restored-v8.sqlite');
    PracticeStore.restoreBackup(upgraded.migrationBackupPath!, restoredPath);
    const restored = new PracticeStore(restoredPath);
    try {
      assert.ok(restored.migrationBackupPath);
      assert.equal(restored.reviewOpportunities().total, 1);
      assert.equal(restored.reviewOpportunities().items[0].state, 'historical');
      restored.integrityCheck();
    } finally { restored.close(); }
    upgraded.integrityCheck();
  } finally { upgraded.close(); legacy.close(); }
  const reopened = new PracticeStore(f.dbPath);
  try { assert.equal(reopened.migrationBackupPath, null); assert.equal(reopened.reviewOpportunities().total, 1); }
  finally { reopened.close(); }
});

test('failed schema9 migration retains original v8 database and independently inspectable pre-upgrade backup', t => {
  const f = fixture(t);
  f.store.close();
  const old = new DatabaseSync(f.dbPath);
  stripProblemReviewSchema(old);
  old.exec('CREATE TABLE problem_review_plans(unexpected TEXT);');
  old.close();
  assert.throws(() => new PracticeStore(f.dbPath), /Schema v9 migration failed/);
  const raw = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 8);
    assert.equal(raw.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='problem_review_events'").get(), undefined);
    assert.equal(raw.prepare('SELECT answer_format FROM attempts WHERE id=?').get(f.attempt.id)?.answer_format, 'function');
  } finally { raw.close(); }
  const backupName = readdirSync(f.directory).find(name => name.includes('.before-v9-') && name.endsWith('.sqlite'));
  assert.ok(backupName);
  assert.equal(PracticeStore.inspectBackupSnapshot(join(f.directory, backupName)).schemaVersion, 8);
});
