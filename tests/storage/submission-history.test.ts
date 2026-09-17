import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { PracticeStore, type Attempt } from '../../src/storage/practice-store.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-submission-history-')), dbPath = join(directory, 'practice.sqlite');
  const store = new PracticeStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const problem = store.upsertProblem({ id: 'leetcode:history-example', source: 'leetcode-cn', sourceUrl: 'https://leetcode.cn/problems/two-sum/', sourceId: '1',
    title: '历史对照', difficulty: '简单', tags: [], description: '仅用于测试', descriptionFormat: 'plain', constraints: [], mode: 'function', cases: [],
    starter: { python: 'pass', java: 'class Solution {}' } });
  const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language: 'python', problemSnapshot: problem.content as never });
  const draft = store.saveDraft({ problemId: problem.id, language: 'python', code: 'CURRENT UNSUBMITTED ANSWER' });
  return { directory, dbPath, store, problem, attempt, draft };
}
function local(store: PracticeStore, attempt: Attempt, id: string, code = `# ${id}`) {
  return store.saveRun({ id, attemptId: attempt.id, code, testSuiteVersion: 'suite', adapterVersion: 'adapter', runtimeVersion: 'python', status: 'passed',
    result: { status: 'passed', caseResults: [{ actual: 'payload'.repeat(10_000) }] } });
}
function official(store: PracticeStore, attempt: Attempt, id: string) {
  const draft = store.getDraft(attempt.problemId, attempt.language, attempt.draftScopeId)!;
  const record = store.beginOfficialSubmission({ requestId: id, attemptId: attempt.id, code: draft.code, expectedDraftRevision: draft.revision, slug: 'two-sum', sourceId: '1' });
  store.updateOfficialSubmission(record.id, { status: 'judging', submissionId: String(1000 + store.listOfficialSubmissions(attempt.id).length) });
  return store.updateOfficialSubmission(record.id, { status: 'completed', result: { status: 'accepted', statusMessage: 'Accepted', passedCases: 65, totalCases: 65 } });
}
const key = (item: { source: string; id: string }) => `${item.source}:${item.id}`;

test('history combines attempts and sources in stable pages, filtered by problem and language, with no code or judge bodies', t => {
  const { store, attempt, problem, draft } = fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-15T08:00:00Z') });
  for (let i = 0; i < 35; i++) local(store, attempt, `old-${String(i).padStart(3, '0')}`);
  official(store, attempt, 'official-old'); store.finishAttempt(attempt.id);
  const current = store.startAttempt({ problemId: problem.id, language: 'python', problemVersion: problem.version });
  for (let i = 0; i < 35; i++) local(store, current, `new-${String(i).padStart(3, '0')}`);
  const accepted = official(store, current, 'official-new');
  const pending = store.beginOfficialSubmission({ requestId: 'official-pending', attemptId: current.id, code: draft.code, expectedDraftRevision: draft.revision, slug: 'two-sum', sourceId: '1' });
  const queued = store.saveRun({ id: 'queued', attemptId: current.id, code: 'unexecuted', testSuiteVersion: 'suite', adapterVersion: 'adapter', runtimeVersion: 'python' });
  const java = store.startAttempt({ problemId: problem.id, language: 'java', problemVersion: problem.version }); local(store, java, 'java');
  const other = store.startAttempt({ problemId: 'other', language: 'python', problemVersion: 'v1' }); local(store, other, 'other');
  const filter = { problemId: problem.id, language: 'python' as const };
  const first = store.listSubmissionHistory({ ...filter, limit: 20 }), next = store.listSubmissionHistory({ ...filter, offset: 20, limit: 100 });
  assert.equal(first.total, 73); assert.equal(first.items.length, 20); assert.equal(first.hasMore, true);
  assert.equal(next.items.length, 53); assert.equal(next.hasMore, false);
  const all = [...first.items, ...next.items]; assert.equal(new Set(all.map(key)).size, 73);
  assert.deepEqual(store.listSubmissionHistory({ ...filter, limit: 100 }).items, all, 'equal-time order remains stable across page boundaries');
  assert.ok(all.some(item => item.attemptId === attempt.id)); assert.ok(all.some(item => item.attemptId === current.id));
  assert.ok(all.some(item => item.id === pending.id && item.status === 'submitting'));
  assert.ok(all.some(item => item.id === accepted.id && item.verdict === 'accepted'));
  assert.ok(all.every(item => !('code' in item) && !('result' in item) && !('testSnapshot' in item)));
  assert.ok(JSON.stringify(all).length < 50_000, 'large run output never crosses the summary API');
  assert.throws(() => store.getSubmissionHistoryDetail('local', queued.id), /尚未完成/);
  assert.equal(store.getSubmissionHistoryDetail('official', pending.id).code, pending.code);
  assert.deepEqual(store.getDraft(problem.id, 'python'), draft, 'opening history does not restore or overwrite the working answer');
  assert.equal(store.listSubmissionHistory({ ...filter, offset: 1000 }).items.length, 0);
  assert.equal(store.listSubmissionHistory({ ...filter, problemId: 'missing' }).total, 0);
  for (const invalid of [{ ...filter, limit: 101 }, { ...filter, offset: -1 }, { ...filter, language: 'go' }, { ...filter, problemId: '' }, null]) {
    assert.throws(() => store.listSubmissionHistory(invalid as never));
  }
});

test('remarks are independent by source, versioned, clearable, bounded, and never change snapshots or drafts', t => {
  const { store, dbPath, attempt, problem, draft } = fixture(t);
  const run = local(store, attempt, 'same-id'), submission = official(store, attempt, 'same-id');
  assert.equal(store.getSubmissionHistoryDetail('local', run.id).remarkRevision, 0);
  const saved = store.saveSubmissionRemark({ source: 'local', id: run.id, remark: '  双指针，先排序  ', expectedRevision: 0 });
  assert.deepEqual(saved, { source: 'local', id: run.id, remark: '双指针，先排序', remarkRevision: 1 });
  store.saveSubmissionRemark({ source: 'official', id: submission.id, remark: '哈希表，一次遍历', expectedRevision: 0 });
  assert.equal(store.getSubmissionHistoryDetail('official', submission.id).remark, '哈希表，一次遍历');
  assert.deepEqual(store.saveSubmissionRemark({ source: 'local', id: run.id, remark: saved.remark, expectedRevision: 1 }), saved);
  const otherConnection = new PracticeStore(dbPath);
  try {
    assert.throws(() => otherConnection.saveSubmissionRemark({ source: 'local', id: run.id, remark: '旧页面', expectedRevision: 0 }), /其他位置更新/);
    assert.equal(otherConnection.saveSubmissionRemark({ source: 'local', id: run.id, remark: '', expectedRevision: 1 }).remarkRevision, 2);
    assert.throws(() => store.saveSubmissionRemark({ source: 'local', id: run.id, remark: '清空前的旧内容', expectedRevision: 1 }), /其他位置更新/);
  } finally { otherConnection.close(); }
  const input = { source: 'local' as const, id: run.id, expectedRevision: 2 };
  assert.equal(store.saveSubmissionRemark({ ...input, remark: '😀'.repeat(240) }).remarkRevision, 3);
  for (const invalid of [{ ...input, remark: '字'.repeat(241) }, { ...input, remark: null }, { ...input, remark: 'x\0y' },
    { ...input, remark: '备注', expectedRevision: -1 }, { ...input, remark: '备注', expectedRevision: undefined },
    { ...input, remark: '备注', source: 'forged' }, { ...input, remark: '备注', id: 'missing' }]) assert.throws(() => store.saveSubmissionRemark(invalid as never));
  assert.deepEqual(store.getRun(run.id), run); assert.deepEqual(store.getOfficialSubmission(submission.id), submission);
  assert.deepEqual(store.getDraft(problem.id, 'python'), draft);
  const raw = new DatabaseSync(dbPath);
  try {
    assert.throws(() => raw.prepare('UPDATE runs SET code = ? WHERE id = ?').run('replace', run.id), /immutable/);
    assert.throws(() => raw.prepare('UPDATE official_submissions SET result_json = ? WHERE id = ?').run('{}', submission.id), /immutable/);
  } finally { raw.close(); }
});

test('schema 6 receives a verified original snapshot before upgrading; restoring that snapshot preserves all old data', async t => {
  const { store, dbPath, directory, attempt, problem, draft } = fixture(t);
  const run = local(store, attempt, 'legacy-run'), submission = official(store, attempt, 'legacy-official'); store.close();
  const old = new DatabaseSync(dbPath);
  old.exec('DROP TABLE submission_remarks; DROP INDEX attempts_by_problem_language; PRAGMA user_version=6;'); old.close();
  const upgraded = new PracticeStore(dbPath);
  try {
    assert.ok(upgraded.migrationBackupPath?.includes('.before-v7-')); assert.ok(existsSync(upgraded.migrationBackupPath!));
    assert.equal(PracticeStore.inspectBackupSnapshot(upgraded.migrationBackupPath!).schemaVersion, 6);
    const original = new DatabaseSync(upgraded.migrationBackupPath!, { readOnly: true });
    try { assert.equal(original.prepare("SELECT name FROM sqlite_schema WHERE name='submission_remarks'").get(), undefined); } finally { original.close(); }
    assert.deepEqual(upgraded.getRun(run.id), run); assert.deepEqual(upgraded.getOfficialSubmission(submission.id), submission);
    assert.deepEqual(upgraded.getDraft(problem.id, 'python'), draft);
    assert.equal(upgraded.getSubmissionHistoryDetail('local', run.id).remarkRevision, 0);
    upgraded.saveSubmissionRemark({ source: 'official', id: submission.id, remark: '旧记录也能加备注', expectedRevision: 0 });
    const restoredPath = join(directory, 'restored-schema6.sqlite'); PracticeStore.restoreBackup(upgraded.migrationBackupPath!, restoredPath);
    const restored = new PracticeStore(restoredPath);
    try { assert.deepEqual(restored.getOfficialSubmission(submission.id), submission); assert.equal(restored.getSubmissionHistoryDetail('official', submission.id).remark, ''); restored.integrityCheck(); }
    finally { restored.close(); }
    upgraded.integrityCheck();
  } finally { upgraded.close(); }
});

test('remark backup round trip is exact and deleting an archive cascades only its remarks', async t => {
  const { store, directory, dbPath, attempt, problem } = fixture(t), run = local(store, attempt, 'to-delete'), submission = official(store, attempt, 'official-delete');
  const localRemark = store.saveSubmissionRemark({ source: 'local', id: run.id, remark: '已保存', expectedRevision: 0 });
  const officialRemark = store.saveSubmissionRemark({ source: 'official', id: submission.id, remark: '官方快照', expectedRevision: 0 });
  store.finishAttempt(attempt.id);
  const next = store.startAttempt({ problemId: problem.id, language: 'python', problemVersion: problem.version }), retained = local(store, next, 'retained');
  store.saveSubmissionRemark({ source: 'local', id: retained.id, remark: '保留', expectedRevision: 0 });
  const note = store.saveNote({ requestId: 'keep-note', kind: 'problem', subjectId: problem.id, title: '笔记', markdown: '独立内容' });
  const target = join(directory, 'annotated.sqlite'); await store.backupTo(target);
  assert.equal(PracticeStore.inspectBackupSnapshot(target).schemaVersion, 7);
  const copyPath = join(directory, 'restored.sqlite'); PracticeStore.restoreBackup(target, copyPath); const copy = new PracticeStore(copyPath);
  try {
    for (const remark of [localRemark, officialRemark]) { const detail = copy.getSubmissionHistoryDetail(remark.source, remark.id); assert.equal(detail.remark, remark.remark); assert.equal(detail.remarkRevision, remark.remarkRevision); }
    assert.equal(copy.deleteEndedAttempt(attempt.id), true); copy.integrityCheck();
    assert.throws(() => copy.getSubmissionHistoryDetail('local', run.id), /不存在/); assert.throws(() => copy.getSubmissionHistoryDetail('official', submission.id), /不存在/);
    assert.equal(copy.getSubmissionHistoryDetail('local', retained.id).remark, '保留'); assert.deepEqual(copy.getNote(note.id), note);
    const raw = new DatabaseSync(copyPath, { readOnly: true });
    try { assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM submission_remarks').get()?.count, 1); } finally { raw.close(); }
  } finally { copy.close(); }
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try { assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM submission_remarks').get()?.count, 3); } finally { raw.close(); }
});

test('failed schema 7 migration rolls back every change and leaves a usable original backup', t => {
  const { store, dbPath, directory, draft, problem } = fixture(t); store.close();
  const old = new DatabaseSync(dbPath);
  try {
    old.exec('DROP TABLE submission_remarks; DROP INDEX attempts_by_problem_language; CREATE TABLE submission_remarks(conflicting_column TEXT); PRAGMA user_version=6;');
    const before = old.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all();
    assert.throws(() => new PracticeStore(dbPath), /Schema v7 migration failed/);
    assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 6);
    assert.deepEqual(old.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all(), before);
    assert.equal(old.prepare('SELECT code FROM drafts WHERE problem_id=?').get(problem.id)?.code, draft.code);
    const backups = readdirSync(directory).filter(name => name.includes('.before-v7-') && name.endsWith('.sqlite'));
    assert.equal(backups.length, 1); assert.equal(PracticeStore.inspectBackupSnapshot(join(directory, backups[0])).schemaVersion, 6);
    assert.equal(readdirSync(directory).some(name => name.endsWith('.partial')), false);
  } finally { old.close(); }
});
