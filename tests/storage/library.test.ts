import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PracticeStore, hashCode } from '../../src/storage/practice-store.ts';
import type { SaveRunInput } from '../../src/storage/practice-store.ts';
import type { CreateImportJobInput, ListSnapshotInput, ProblemContent } from '../../src/shared/library.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice-p2-storage '));
  const dbPath = join(directory, 'practice.sqlite');
  const store = new PracticeStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, dbPath, store };
}

function problem(id = 'local:sum', description = '返回数组元素之和。'): ProblemContent {
  return { id, title: `题目 ${id}`, difficulty: '简单', tags: ['数组'], source: 'local',
    description, descriptionFormat: 'plain', constraints: ['可为空数组'], mode: 'function',
    adapter: { method: 'sum', params: [{ array: 'int' }], returns: 'int' },
    cases: [{ args: [[1, 2]], expected: 3 }], starter: { python: 'class Solution:\n    def sum(self, nums):\n        return 0' } };
}

function list(items = ['local:a', 'local:b']): ListSnapshotInput {
  return { id: 'list-1', title: '练习清单', source: 'local', membershipComplete: true,
    chapters: [{ id: 'root', title: '算法', position: 0 }, { id: 'arrays', title: '数组', parentId: 'root', position: 1 }],
    items: items.map((problemId, index) => ({ key: problemId, problemId, chapterId: 'arrays', position: index })) };
}

function runInput(attemptId: string, code = 'return 3'): SaveRunInput {
  return { attemptId, code, testSuiteVersion: 'test-v1', testSnapshot: [{ args: [[1, 2]], expected: 3 }],
    adapterVersion: 'adapter-v2', runtimeVersion: 'Python 3.14.7' };
}

function importInput(): CreateImportJobInput {
  return { requestKey: 'import-request-1', title: '导入清单', input: 'https://example.invalid/my-own-list', source: 'file',
    list: list(['file:a', 'file:b']), items: [
      { key: 'a', problemId: 'file:a', title: '第一题', position: 0 },
      { key: 'b', problemId: 'file:b', title: '第二题', position: 1 },
    ] };
}

test('today new problems apply current runnable capability before the three-item limit', t => {
  const { store } = fixture(t);
  const attempted = store.upsertProblem(problem('0-attempted')); store.startAttempt({ problemId: attempted.id, language: 'python', problemVersion: attempted.version });
  const reviewed = store.upsertProblem(problem('0-reviewed')); store.addReviewItem({ problemId: reviewed.id, target: 'understanding', language: 'none' });
  store.upsertProblem({ ...problem('a-link'), description: '', adapter: undefined, starter: {}, cases: [] });
  store.upsertProblem({ ...problem('b-no-adapter'), adapter: undefined });
  store.upsertProblem({ ...problem('c-no-tests'), cases: [] });
  store.upsertProblem(problem('d-python'));
  store.upsertProblem({ ...problem('e-java'), starter: { java: 'class Solution { public int sum(int[] nums) { return 0; } }' } });
  store.upsertProblem({ ...problem('f-acm'), mode: 'acm', adapter: undefined, cases: [{ stdin: '1', expected: '1' }], starter: { python: 'print(input())' } });
  store.upsertProblem(problem('g-extra'));
  assert.deepEqual(store.getTodayQueue().newProblemIds, ['d-python', 'e-java', 'f-acm']);
  store.upsertProblem(problem('a-link'));
  assert.deepEqual(store.getTodayQueue().newProblemIds, ['a-link', 'd-python', 'e-java'], 'the current cached version decides capability');
});

test('content hashes are canonical, preserve media/comparators, and never replace a pinned attempt version', (t) => {
  const { store } = fixture(t);
  const content = { ...problem(), media: { complete: false, missingUrls: ['https://assets.leetcode.com/example.png'] },
    acmCompare: 'exact' as const };
  const first = store.upsertProblem(content);
  assert.match(first.version, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(store.upsertProblem(Object.fromEntries(Object.entries(content).reverse()) as unknown as ProblemContent), first);
  const attempt = store.startAttempt({ problemId: first.id, language: 'python', problemVersion: first.version, problemSnapshot: first.content as never });
  const draft = store.saveDraft({ problemId: first.id, language: 'python', code: 'preserve my draft' });
  const changed = store.upsertProblem({ ...content, description: '上游修订题面', media: { complete: true, missingUrls: [] } });
  assert.notEqual(changed.version, first.version);
  assert.equal(store.getProblem(first.id)?.version, changed.version);
  assert.deepEqual(store.getProblem(first.id, first.version)?.content, content);
  assert.equal(store.getProblem(first.id)?.content.acmCompare, 'exact');
  assert.equal(store.getActiveAttempt(first.id, 'python')?.problemVersion, first.version);
  assert.deepEqual(store.getDraft(first.id, 'python'), draft);
  assert.equal(store.getAttempt(attempt.id)?.problemSnapshot && (store.getAttempt(attempt.id)!.problemSnapshot as { description: string }).description, content.description);
  assert.equal(store.listProblems({ search: '上游' }).length, 0, 'search covers metadata, not arbitrary statement body');
});

test('confirmed list refresh preserves chapter order, removed problems, drafts and immutable run history', (t) => {
  const { store } = fixture(t);
  for (const id of ['local:a', 'local:b', 'local:c']) store.upsertProblem(problem(id));
  const initial = store.applyListRefresh(store.previewListRefresh(list()).id);
  assert.equal(initial.revision, 1);
  assert.deepEqual(initial.chapters.map((chapter) => chapter.id), ['root', 'arrays']);
  const old = store.getProblem('local:b')!;
  const attempt = store.startAttempt({ problemId: old.id, language: 'python', problemVersion: old.version });
  const saved = store.beginRun(runInput(attempt.id, 'old B code'));
  store.finishRun(saved.id, { status: 'passed', result: { status: 'passed' } });
  store.saveDraft({ problemId: old.id, language: 'python', code: 'B unfinished edits' });
  const input = list(['local:c', 'local:a']);
  input.chapters = [{ id: 'arrays', title: '数组新章节名', position: 0 }];
  const preview = store.previewListRefresh(input);
  assert.deepEqual(preview.added.map((item) => item.problemId), ['local:c']);
  assert.deepEqual(preview.removed.map((item) => item.problemId), ['local:b']);
  assert.equal(preview.moved[0].after.problemId, 'local:a');
  const updated = store.applyListRefresh(preview.id);
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.items.map((item) => item.problemId), ['local:c', 'local:a']);
  assert.deepEqual(store.applyListRefresh(preview.id), updated, 'repeat apply is idempotent');
  assert.equal(store.getProblem('local:b')?.version, old.version);
  assert.equal(store.getDraft('local:b', 'python')?.code, 'B unfinished edits');
  assert.equal(store.getRun(saved.id)?.code, 'old B code');
  assert.deepEqual(store.listProblems({ listId: 'list-1' }).map((entry) => entry.id), ['local:a', 'local:c']);
  store.integrityCheck();
});

test('incomplete membership and stale refresh previews cannot clear or roll back a list', (t) => {
  const { store } = fixture(t);
  store.applyListRefresh(store.previewListRefresh(list()).id);
  const partial = store.previewListRefresh({ ...list([]), membershipComplete: false });
  assert.equal(partial.canApply, false);
  assert.throws(() => store.applyListRefresh(partial.id), /Incomplete/);
  assert.equal(store.getList('list-1')?.items.length, 2);
  const stale = store.previewListRefresh(list(['local:a']));
  const fresh = store.previewListRefresh(list(['local:a', 'local:b', 'local:c']));
  store.applyListRefresh(fresh.id);
  assert.throws(() => store.applyListRefresh(stale.id), /changed after preview/);
  assert.equal(store.getList('list-1')?.items.length, 3);
  assert.throws(() => store.previewListRefresh({ ...list(), chapters: [
    { id: 'x', title: '循环', parentId: 'y', position: 0 }, { id: 'y', title: '循环', parentId: 'x', position: 1 },
  ] }), /cycle/);
});

test('import retries resume only unfinished items and successful completions survive reopening', (t) => {
  const { store, dbPath } = fixture(t);
  const input = importInput();
  const job = store.createImportJob(input);
  assert.equal(store.createImportJob(input).id, job.id);
  assert.throws(() => store.createImportJob({ ...input, title: 'different request' }), /conflicts/);
  store.updateImportJob(job.id, { status: 'running' });
  store.updateImportItem(job.id, 'a', { status: 'running' });
  const firstContent = { ...problem('file:a'), source: 'file' as const };
  const first = store.updateImportItem(job.id, 'a', { status: 'imported', content: firstContent });
  assert.equal(first.status, 'imported');
  store.updateImportItem(job.id, 'b', { status: 'running' });
  store.close();
  const reopened = new PracticeStore(dbPath);
  try {
    assert.equal(reopened.recoverImportJobs(), 1);
    assert.equal(reopened.recoverImportJobs(), 0);
    const recovered = reopened.getImportJob(job.id)!;
    assert.equal(recovered.status, 'paused');
    assert.deepEqual(recovered.items[0], first);
    assert.equal(recovered.items[1].status, 'pending');
    assert.equal(recovered.items[1].attempts, 1);
    assert.throws(() => reopened.updateImportItem(job.id, 'b', { status: 'imported', content: problem('file:b') }), /must be running/);
    reopened.updateImportJob(job.id, { status: 'running' });
    reopened.updateImportItem(job.id, 'b', { status: 'running' });
    reopened.updateImportItem(job.id, 'b', { status: 'failed', error: { code: 'NETWORK', message: '本次网络不可达', retryable: true } });
    const withErrors = reopened.updateImportJob(job.id, { status: 'completed' });
    assert.equal(withErrors.status, 'completed_with_errors');
    assert.deepEqual(withErrors.items[0], first);
    reopened.updateImportJob(job.id, { status: 'running', retryFailed: true });
    assert.equal(reopened.getImportJob(job.id)?.items[0].status, 'imported');
    reopened.updateImportItem(job.id, 'b', { status: 'running' });
    reopened.updateImportItem(job.id, 'b', { status: 'imported', content: { ...problem('file:b'), source: 'file' } });
    const complete = reopened.updateImportJob(job.id, { status: 'completed' });
    assert.equal(complete.status, 'completed');
    assert.equal(complete.counts.imported, 2);
    assert.equal(complete.items[1].attempts, 3);
    assert.equal(Object.values(complete.counts).reduce((sum, count) => sum + count, 0), complete.total);
    assert.equal(reopened.updateImportItem(job.id, 'a', { status: 'imported', content: firstContent }).version, first.version);
    assert.equal(reopened.listImportJobs().length, 1);
    assert.equal(reopened.listProblems().length, 2);
  } finally { reopened.close(); }
});

test('content upsert and import item completion commit atomically; a failure cannot leave a newer head', (t) => {
  const { store, dbPath } = fixture(t);
  const job = store.createImportJob(importInput());
  store.updateImportJob(job.id, { status: 'running' });
  store.updateImportItem(job.id, 'a', { status: 'running' });
  const before = store.getProblem('file:a')!;
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TRIGGER reject_import_completion BEFORE UPDATE ON import_items WHEN NEW.status = 'imported'
    BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;`);
  try {
    assert.throws(() => store.updateImportItem(job.id, 'a', { status: 'imported', content: problem('file:a') }), /injected storage failure/);
    assert.equal(store.getProblem('file:a')?.version, before.version);
    assert.equal(store.getImportJob(job.id)?.items[0].status, 'running');
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM problem_versions WHERE problem_id = ?').get('file:a')?.count, 1);
  } finally { raw.exec('DROP TRIGGER reject_import_completion'); raw.close(); }
  store.updateImportItem(job.id, 'a', { status: 'imported', content: problem('file:a') });
  assert.throws(() => store.updateImportJob(job.id, { status: 'completed' }), /unfinished items/);
  assert.equal(store.getImportJob(job.id)?.status, 'running');
});

test('duplicate imports reuse one version and unavailable refresh cannot replace a cached statement', (t) => {
  const { store } = fixture(t);
  const content = problem('file:a');
  const saved = store.upsertProblem(content);
  const job = store.createImportJob(importInput());
  store.updateImportJob(job.id, { status: 'running' });
  const item = store.updateImportItem(job.id, 'a', { status: 'imported', content });
  assert.equal(item.status, 'reused');
  assert.equal(item.version, saved.version);
  const refresh = store.createImportJob({ ...importInput(), requestKey: 'refresh-request' });
  store.updateImportJob(refresh.id, { status: 'running' });
  store.updateImportItem(refresh.id, 'a', { status: 'restricted', content: { ...content, description: '', cases: [], starter: {} },
    error: { code: 'AUTH', message: '当前来源不可读取', retryable: true } });
  assert.equal(store.getProblem(content.id)?.version, saved.version);
  assert.equal(store.getProblem(content.id)?.content.description, content.description);
  store.updateImportJob(refresh.id, { status: 'cancelled' });
  assert.throws(() => store.updateImportItem(refresh.id, 'b', { status: 'imported', content: problem('file:b') }), /must be running/);
});

test('an aborted item can return to pending and link-only metadata enriches an initial placeholder', (t) => {
  const { store } = fixture(t);
  const job = store.createImportJob(importInput());
  store.updateImportJob(job.id, { status: 'running' });
  store.updateImportItem(job.id, 'a', { status: 'running' });
  const pending = store.updateImportItem(job.id, 'a', { status: 'pending' });
  assert.equal(pending.attempts, 1);
  assert.equal(pending.status, 'pending');
  store.updateImportItem(job.id, 'a', { status: 'running' });
  const linkOnly: ProblemContent = { ...problem('file:a'), title: '已发现的真实题名', tags: ['哈希表'],
    sourceUrl: 'https://leetcode.cn/problems/example/', description: '', cases: [], starter: {},
    supportReason: '仅链接，题面不可获取' };
  const result = store.updateImportItem(job.id, 'a', { status: 'link_only', content: linkOnly });
  assert.equal(result.status, 'link_only');
  assert.equal(result.attempts, 2);
  assert.equal(store.getProblem('file:a')?.content.title, linkOnly.title);
  assert.deepEqual(store.getProblem('file:a')?.content.tags, linkOnly.tags);
  assert.equal(store.getProblem('file:a')?.content.supportReason, linkOnly.supportReason);
});

test('finish is idempotent and explicitly records when the final draft was never run', (t) => {
  const { store, dbPath } = fixture(t);
  const firstVersion = store.upsertProblem(problem());
  const attempt = store.startAttempt({ problemId: firstVersion.id, language: 'python', problemVersion: firstVersion.version });
  assert.equal(store.startAttempt({ problemId: firstVersion.id, language: 'python', problemVersion: firstVersion.version }).id, attempt.id);
  const run = store.beginRun(runInput(attempt.id, 'tested code'));
  assert.throws(() => store.finishAttempt(attempt.id, { code: 'new code' }), /unfinished/);
  assert.equal(store.getDraft(firstVersion.id, 'python')?.code, 'tested code');
  store.finishRun(run.id, { status: 'passed', result: { status: 'passed' } });
  const finished = store.finishAttempt(attempt.id, { code: 'new code not yet run' });
  assert.equal(finished.lastRunMatchesFinal, false);
  assert.equal(finished.lastRunId, run.id);
  assert.equal(finished.finalCode, 'new code not yet run');
  assert.equal(finished.finalCodeHash, hashCode(finished.finalCode!));
  assert.equal(finished.isActive, false);
  assert.equal(store.getActiveAttempt(firstVersion.id, 'python'), undefined);
  assert.deepEqual(store.finishAttempt(attempt.id), finished);
  assert.deepEqual(store.finishAttempt(attempt.id, { code: finished.finalCode! }), finished);
  assert.throws(() => store.finishAttempt(attempt.id, { code: 'different final' }), /different final/);
  assert.throws(() => store.beginRun(runInput(attempt.id, 'after finish')), /finished attempt/);
  assert.equal(store.getDraft(firstVersion.id, 'python')?.code, finished.finalCode, 'failed beginRun rolls back its draft update');
  const secondVersion = store.upsertProblem(problem(firstVersion.id, 'new statement'));
  const next = store.startAttempt({ problemId: firstVersion.id, language: 'python', problemVersion: secondVersion.version });
  assert.notEqual(next.id, attempt.id);
  assert.equal(store.listAttempts(firstVersion.id, 'python').length, 2);
  assert.equal(store.getAttempt(attempt.id)?.problemVersion, firstVersion.version);
  const raw = new DatabaseSync(dbPath);
  try { assert.throws(() => raw.prepare('UPDATE attempts SET final_code = ? WHERE id = ?').run('overwrite', attempt.id), /immutable/); }
  finally { raw.close(); }
});

test('beginRun is an atomic draft and snapshot boundary, and retries never roll a newer draft back', (t) => {
  const { store, dbPath } = fixture(t);
  const content = store.upsertProblem(problem());
  const attempt = store.startAttempt({ problemId: content.id, language: 'python', problemVersion: content.version });
  const before = store.saveDraft({ problemId: content.id, language: 'python', code: 'before' });
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TRIGGER reject_new_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'injected run failure'); END;`);
  try {
    assert.throws(() => store.beginRun(runInput(attempt.id, 'must roll back')), /injected run failure/);
    assert.deepEqual(store.getDraft(content.id, 'python'), before);
    assert.equal(store.listRuns(attempt.id).length, 0);
  } finally { raw.exec('DROP TRIGGER reject_new_run'); raw.close(); }
  const input = { ...runInput(attempt.id, 'first run'), id: 'run-request-stable' };
  const saved = store.beginRun(input);
  store.saveDraft({ problemId: content.id, language: 'python', code: 'newer edits' });
  assert.deepEqual(store.beginRun(input), saved);
  assert.equal(store.getDraft(content.id, 'python')?.code, 'newer edits');
  assert.equal(store.listRuns(attempt.id).length, 1);
});

test('restoring history creates a separate scope and pinned attempt without overwriting the normal draft', (t) => {
  const { store } = fixture(t);
  const old = store.upsertProblem(problem());
  const normal = store.startAttempt({ problemId: old.id, language: 'python', problemVersion: old.version });
  const run = store.beginRun(runInput(normal.id, 'historical code'));
  store.finishRun(run.id, { status: 'passed', result: {} });
  store.saveDraft({ problemId: old.id, language: 'python', code: 'normal draft to preserve' });
  store.upsertProblem(problem(old.id, 'current source differs'));
  const restored = store.restoreRunAsDraft(run.id, { requestId: 'restore-one' });
  assert.equal(restored.draft.scopeId, 'restore:restore-one');
  assert.equal(restored.draft.code, 'historical code');
  assert.notEqual(restored.attempt.id, normal.id);
  assert.equal(restored.attempt.problemVersion, old.version);
  assert.equal(restored.attempt.restoredFromRunId, run.id);
  assert.equal(store.getActiveAttempt(old.id, 'python')?.id, normal.id);
  assert.equal(store.getActiveAttempt(old.id, 'python', 'practice', restored.draft.scopeId)?.id, restored.attempt.id);
  assert.equal(store.getDraft(old.id, 'python')?.code, 'normal draft to preserve');
  store.saveDraft({ problemId: old.id, language: 'python', scopeId: restored.draft.scopeId, code: 'edited restored draft' });
  assert.equal(store.restoreRunAsDraft(run.id, { requestId: 'restore-one' }).draft.code, 'edited restored draft');
  assert.throws(() => store.restoreRunAsDraft(run.id, { requestId: 'restore-two', scopeId: 'practice' }), /new draft scope/);
  assert.throws(() => store.beginRun({ ...runInput(restored.attempt.id), scopeId: 'practice' }), /scope does not match/);
  assert.equal(store.listRuns(normal.id).length, 1);
  assert.equal(store.listRuns(restored.attempt.id).length, 0);
});

function createP1Database(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(new URL('./fixtures/p1-schema.sql', import.meta.url), 'utf8'));
  const legacy = { id: 'p1-demo', title: '原型题', topic: '数组', difficulty: '基础', description: '原始题面',
    mode: 'acm', constraints: [], cases: [{ stdin: '1\n', expected: '1\n' }], starter: { python: 'print(0)', java: 'class Main {}' } };
  db.prepare('INSERT INTO problems VALUES (?)').run('p1-demo');
  db.prepare('INSERT INTO problem_versions VALUES (?, ?, ?)').run('p1-demo', 'p1-fixtures-v1', JSON.stringify(legacy));
  db.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('p1-demo', 'python', 'practice', '最新草稿尚未运行', hashCode('最新草稿尚未运行'), 7, '2026-09-05T10:00:00.000Z');
  for (const [id, time] of [['legacy-older', '2026-09-04T10:00:00.000Z'], ['legacy-active', '2026-09-05T10:00:00.000Z']]) {
    db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?)').run(id, 'p1-demo', 'python', 'p1-fixtures-v1', 'practice', time);
  }
  for (let index = 0; index < 4; index++) {
    const queued = index === 3;
    const code = `legacy code ${index}`;
    db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`legacy-run-${index}`, index === 0 ? 'legacy-older' : 'legacy-active', code, hashCode(code), 'tests-v1', '[{"stdin":"1"}]',
        'adapter-v1', 'Python 3.14.7', queued ? 'queued' : 'completed', queued ? 'null' : JSON.stringify({ stdout: String(index) }),
        '2026-09-05T10:00:00.000Z', queued ? null : '2026-09-05T10:00:01.000Z');
  }
  return db;
}

test('P1 migration takes a consistent pre-migration WAL snapshot and preserves every draft/run/version', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice-v1-migration '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'practice.sqlite');
  const p1 = createP1Database(dbPath);
  const beforeRuns = p1.prepare('SELECT * FROM runs ORDER BY id').all();
  const beforeSnapshot = p1.prepare('SELECT snapshot_json FROM problem_versions').get();
  assert.ok(existsSync(`${dbPath}-wal`) && statSync(`${dbPath}-wal`).size > 0);
  const upgraded = new PracticeStore(dbPath);
  try {
    assert.ok(upgraded.migrationBackupPath);
    assert.equal(upgraded.getDraft('p1-demo', 'python')?.revision, 7);
    assert.equal(upgraded.listRuns('legacy-active').length, 3);
    assert.equal(upgraded.listAttempts('p1-demo').length, 2);
    assert.equal(upgraded.getActiveAttempt('p1-demo', 'python')?.id, 'legacy-active');
    assert.equal(upgraded.getProblem('p1-demo'), undefined, 'migration does not manufacture a current head from unknown P1 JSON');
    assert.deepEqual(upgraded.getProblem('p1-demo', 'p1-fixtures-v1')?.content.tags, ['数组']);
    assert.deepEqual(p1.prepare('SELECT * FROM runs ORDER BY id').all(), beforeRuns);
    assert.deepEqual(p1.prepare('SELECT snapshot_json FROM problem_versions').get(), beforeSnapshot);
    assert.equal(p1.prepare('PRAGMA user_version').get()?.user_version, 6);
    const backup = new DatabaseSync(upgraded.migrationBackupPath!, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.deepEqual(backup.prepare('SELECT * FROM runs ORDER BY id').all(), beforeRuns);
      assert.equal(backup.prepare('SELECT code FROM drafts').get()?.code, '最新草稿尚未运行');
      assert.equal(backup.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    } finally { backup.close(); }
    const restoredPath = join(directory, 'restored-v1.sqlite');
    PracticeStore.restoreBackup(upgraded.migrationBackupPath!, restoredPath);
    const restored = new PracticeStore(restoredPath);
    try {
      assert.equal(restored.getDraft('p1-demo', 'python')?.code, '最新草稿尚未运行');
      assert.equal(restored.getRun('legacy-run-3')?.status, 'queued');
      assert.equal(restored.recoverInterruptedRuns(), 1);
      assert.equal(restored.getRun('legacy-run-3')?.status, 'interrupted');
      restored.integrityCheck();
    } finally { restored.close(); }
    upgraded.integrityCheck();
  } finally { upgraded.close(); p1.close(); }
  const again = new PracticeStore(dbPath);
  try { assert.equal(again.migrationBackupPath, null); } finally { again.close(); }
});

test('failed v4 migration rolls every schema change back and retains a usable v1 backup', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice-migration-failure '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'practice.sqlite');
  const p1 = createP1Database(dbPath);
  p1.exec('CREATE TABLE library_problem_heads (conflicting_fixture TEXT) STRICT');
  const before = p1.prepare('SELECT * FROM runs ORDER BY id').all();
  assert.throws(() => new PracticeStore(dbPath), /Schema v6 migration failed/);
  try {
    assert.equal(p1.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(p1.prepare('PRAGMA table_info(attempts)').all().length, 6);
    assert.equal(p1.prepare("SELECT name FROM sqlite_master WHERE name = 'active_attempts'").get(), undefined);
    assert.ok(p1.prepare("SELECT name FROM sqlite_master WHERE name = 'immutable_attempt'").get());
    assert.deepEqual(p1.prepare('SELECT * FROM runs ORDER BY id').all(), before);
    assert.equal(p1.prepare('SELECT code FROM drafts').get()?.code, '最新草稿尚未运行');
    const backups = readdirSync(directory).filter((name) => name.includes('.before-v6-') && name.endsWith('.sqlite'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(directory, backups[0]), { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.deepEqual(backup.prepare('SELECT * FROM runs ORDER BY id').all(), before);
      assert.equal(backup.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    } finally { backup.close(); }
  } finally { p1.close(); }
});
