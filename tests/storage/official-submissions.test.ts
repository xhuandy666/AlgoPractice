import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PracticeStore, hashCode } from '../../src/storage/practice-store.ts';
import type { BeginOfficialSubmissionInput } from '../../src/shared/official.ts';

export function officialFixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-official-store-'));
  const dbPath = join(directory, 'practice.sqlite'); const store = new PracticeStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const problem = store.upsertProblem({ id: 'leetcode:two-sum', source: 'leetcode-cn', sourceUrl: 'https://leetcode.cn/problems/two-sum/', sourceId: '987',
    title: '两数之和', difficulty: '简单', tags: [], description: '题面', descriptionFormat: 'plain', constraints: [], mode: 'function', cases: [],
    starter: { python: 'class Solution:\n    pass', java: 'class Solution {}' } });
  const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language: 'python', problemSnapshot: problem.content as never });
  const draft = store.saveDraft({ problemId: problem.id, language: 'python', code: 'class Solution:\n    pass' });
  const input: BeginOfficialSubmissionInput = { requestId: 'official-request-1', attemptId: attempt.id, code: draft.code, expectedDraftRevision: draft.revision,
    slug: 'two-sum', sourceId: '987' };
  return { store, dbPath, directory, input, attempt, problem, draft };
}

test('official snapshots are immutable, scoped to saved drafts and independent from local runs', t => {
  const { store, input, dbPath, attempt } = officialFixture(t);
  assert.throws(() => store.beginOfficialSubmission({ ...input, sourceId: '1' }), /官方模板|提交信息/);
  assert.throws(() => store.beginOfficialSubmission({ ...input, code: 'unsaved' }), /代码已变化/);
  assert.throws(() => store.beginOfficialSubmission({ ...input, expectedDraftRevision: 55 }), /代码已变化/);
  const record = store.beginOfficialSubmission(input);
  assert.equal(record.codeHash, hashCode(input.code)); assert.equal(record.draftRevision, 1);
  assert.equal(record.problemVersion, attempt.problemVersion); assert.equal(record.resultUrl, null);
  assert.deepEqual(store.beginOfficialSubmission(input), record);
  assert.throws(() => store.beginOfficialSubmission({ ...input, code: 'conflict' }), /conflicts/);
  assert.throws(() => store.beginOfficialSubmission({ ...input, requestId: 'double-click' }), /正在提交/);
  assert.equal(store.listRuns(attempt.id).length, 0);
  assert.throws(() => store.finishAttempt(attempt.id), /unfinished/);
  store.updateOfficialSubmission(record.id, { status: 'judging', submissionId: '123456' });
  const result = store.updateOfficialSubmission(record.id, { status: 'completed', result: { status: 'accepted', statusCode: 10, statusMessage: 'Accepted' } });
  assert.equal(result.resultUrl, 'https://leetcode.cn/submissions/detail/123456/');
  assert.equal(result.result?.totalCases, undefined);
  const raw = new DatabaseSync(dbPath);
  try {
    assert.throws(() => raw.prepare('UPDATE official_submissions SET code=? WHERE id=?').run('tampered', record.id), /immutable/);
    assert.throws(() => raw.prepare('UPDATE official_submissions SET result_json=? WHERE id=?').run('{}', record.id), /immutable/);
  } finally { raw.close(); }
  store.integrityCheck();
});

test('interrupted official submits become unknown and known IDs become resumable without reposting', t => {
  const { store, input } = officialFixture(t);
  const first = store.beginOfficialSubmission(input);
  assert.equal(store.recoverInterruptedOfficialSubmissions(), 1);
  assert.equal(store.getOfficialSubmission(first.id)?.status, 'unknown');
  assert.throws(() => store.updateOfficialSubmission(first.id, { status: 'judging', submissionId: '2' }), /Invalid/);
  const second = store.beginOfficialSubmission({ ...input, requestId: 'second' });
  store.updateOfficialSubmission(second.id, { status: 'judging', submissionId: '2' });
  assert.equal(store.recoverInterruptedOfficialSubmissions(), 1);
  assert.equal(store.getOfficialSubmission(second.id)?.status, 'paused');
  assert.equal(store.hasActiveOfficialSubmission(), false);
  store.updateOfficialSubmission(second.id, { status: 'judging' });
  assert.equal(store.getOfficialSubmission(second.id)?.submissionId, '2');
});

test('official state revisions stay strictly ordered when the wall clock does not advance', t => {
  const { store, input } = officialFixture(t);
  const frozenAt = Date.parse('2026-09-13T12:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: frozenAt });
  const initial = store.beginOfficialSubmission(input);
  const judging = store.updateOfficialSubmission(initial.id, { status: 'judging', submissionId: '42' });
  const paused = store.updateOfficialSubmission(initial.id, { status: 'paused', error: { code: 'timeout', message: '等待继续查询' } });
  const resumed = store.updateOfficialSubmission(initial.id, { status: 'judging' });
  const completion = { status: 'completed' as const, result: { status: 'accepted' as const, statusMessage: 'Accepted' } };
  const completed = store.updateOfficialSubmission(initial.id, completion);
  assert.deepEqual([initial, judging, paused, resumed, completed].map(record => Date.parse(record.updatedAt)),
    [0, 1, 2, 3, 4].map(increment => frozenAt + increment));
  assert.equal(completed.finishedAt, completed.updatedAt);
  assert.deepEqual(store.updateOfficialSubmission(initial.id, completion), completed, 'idempotent acknowledgements do not create a newer state');
});

test('schema 5 is backed up before migration; backup restores official results and archive deletion removes their relationship', async t => {
  const { store, dbPath, input, directory, attempt } = officialFixture(t);
  store.close();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`DROP TABLE submission_remarks; DROP INDEX attempts_by_problem_language; DROP TABLE official_submissions; PRAGMA user_version=5;`); legacy.close();
  const upgraded = new PracticeStore(dbPath);
  try {
    assert.ok(upgraded.migrationBackupPath?.includes('.before-v7-')); assert.ok(existsSync(upgraded.migrationBackupPath!));
    assert.equal(PracticeStore.inspectBackupSnapshot(upgraded.migrationBackupPath!).schemaVersion, 5);
    assert.equal(upgraded.getDraft(attempt.problemId, 'python')?.code, input.code);
    const record = upgraded.beginOfficialSubmission(input);
    upgraded.updateOfficialSubmission(record.id, { status: 'judging', submissionId: '42' });
    const completed = upgraded.updateOfficialSubmission(record.id, { status: 'completed', result: { status: 'wrong_answer', statusMessage: 'Wrong Answer', passedCases: 3, totalCases: 9 } });
    const backup = join(directory, 'backup.sqlite'); await upgraded.backupTo(backup);
    assert.equal(PracticeStore.inspectBackupSnapshot(backup).schemaVersion, 7);
    const restoredPath = join(directory, 'restored.sqlite'); PracticeStore.restoreBackup(backup, restoredPath);
    const restored = new PracticeStore(restoredPath);
    try { assert.deepEqual(restored.getOfficialSubmission(record.id), completed); restored.integrityCheck(); } finally { restored.close(); }
    upgraded.finishAttempt(attempt.id);
    assert.equal(upgraded.deleteEndedAttempt(attempt.id), true);
    assert.equal(upgraded.getOfficialSubmission(record.id), undefined); upgraded.integrityCheck();
  } finally { upgraded.close(); }
});
