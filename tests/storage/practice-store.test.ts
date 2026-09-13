import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PracticeStore, hashCode } from '../../src/storage/practice-store.ts';
import type { SaveRunInput } from '../../src/storage/practice-store.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice-storage 中文 '));
  const dbPath = join(directory, 'practice.sqlite');
  const store = new PracticeStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, dbPath, store };
}

function runInput(attemptId: string, code = 'print(1)'): SaveRunInput {
  return { attemptId, code, testSuiteVersion: 'tests-v1',
    testSnapshot: { source: 'self-authored', cases: [{ stdin: '', expected: '1' }] },
    adapterVersion: 'acm-v1', runtimeVersion: 'CPython-probe-v1' };
}

test('draft upsert preserves language and scope, revisions reject stale writes', (t) => {
  const { store, dbPath } = fixture(t);
  assert.equal(store.getDraft('p1', 'python'), undefined);
  const first = store.saveDraft({ problemId: 'p1', language: 'python', code: '初始代码', expectedRevision: 0 });
  assert.equal(first.revision, 1);
  assert.deepEqual(store.saveDraft({ problemId: 'p1', language: 'python', code: first.code }), first);
  const updated = store.saveDraft({ problemId: 'p1', language: 'python', code: '修改代码', expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.throws(() => store.saveDraft({ problemId: 'p1', language: 'python', code: 'stale', expectedRevision: 1 }), /revision conflict/);
  store.saveDraft({ problemId: 'p1', language: 'java', code: 'class Solution {}' });
  store.saveDraft({ problemId: 'p1', language: 'python', scopeId: 'interview-1', code: '面试草稿' });
  assert.equal(store.getDraft('p1', 'python')?.code, '修改代码');
  assert.equal(store.getDraft('p1', 'java')?.code, 'class Solution {}');
  assert.equal(store.getDraft('p1', 'python', 'interview-1')?.code, '面试草稿');
  store.close();
  const reopened = new PracticeStore(dbPath);
  try { assert.deepEqual(reopened.getDraft('p1', 'python'), updated); } finally { reopened.close(); }
});

test('one attempt retains three immutable run snapshots across edits and source refresh', (t) => {
  const { store, dbPath } = fixture(t);
  const attempt = store.startAttempt({ id: 'attempt-1', problemId: 'p1', language: 'python',
    problemVersion: 'statement-v1', problemSnapshot: { title: '原题', version: 1 } });
  assert.deepEqual(store.startAttempt({ id: attempt.id, problemId: 'p1', language: 'python', problemVersion: 'statement-v1' }), attempt);
  for (let index = 0; index < 3; index++) {
    const code = `print(${index})`;
    store.saveDraft({ problemId: 'p1', language: 'python', code });
    const input = { ...runInput(attempt.id, code), id: `run-${index}` };
    const run = store.saveRun(input);
    assert.equal(run.status, 'queued');
    const result = store.finishRun(run.id, { status: index === 1 ? 'passed' : 'wrong_answer', result: { actual: String(index) } });
    assert.deepEqual(store.saveRun(input), result, 'retrying the original request must not duplicate a run');
  }
  store.saveDraft({ problemId: 'p1', language: 'python', code: '尚未运行的新代码' });
  store.startAttempt({ problemId: 'p1', language: 'java', problemVersion: 'statement-v2', problemSnapshot: { title: '刷新题面' } });
  const runs = store.listRuns(attempt.id);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((run) => run.code), ['print(0)', 'print(1)', 'print(2)']);
  assert.ok(runs.every((run) => run.problemVersion === 'statement-v1' && run.codeHash === hashCode(run.code)));
  assert.deepEqual(store.getAttempt(attempt.id)?.problemSnapshot, { title: '原题', version: 1 });
  assert.throws(() => store.startAttempt({ problemId: 'p1', language: 'python', problemVersion: 'statement-v1',
    problemSnapshot: { title: '不能覆盖旧题面' } }), /immutable snapshot/);
  const raw = new DatabaseSync(dbPath);
  try {
    assert.throws(() => raw.prepare('UPDATE runs SET code = ? WHERE id = ?').run('overwrite', runs[0].id), /immutable/);
    assert.throws(() => raw.prepare('UPDATE problem_versions SET snapshot_json = ?').run('{}'), /immutable/);
  } finally { raw.close(); }
  store.integrityCheck();
});

test('run terminal results are idempotent and reject conflicting or late completion', (t) => {
  const { store } = fixture(t);
  const attempt = store.startAttempt({ problemId: 'p1', language: 'java', problemVersion: 'v1' });
  const run = store.saveRun(runInput(attempt.id, 'class Main {}'));
  const completion = { status: 'completed' as const, result: { stdout: '1', checked: false } };
  const finished = store.finishRun(run.id, completion);
  assert.deepEqual(store.finishRun(run.id, completion), finished);
  assert.equal(finished.status, 'completed', 'unjudged execution must remain distinct from passed');
  assert.throws(() => store.finishRun(run.id, { status: 'passed', result: {} }), /different terminal/);
  assert.throws(() => store.saveRun({ ...runInput(attempt.id, 'different code'), id: run.id }), /immutable snapshot/);
  assert.throws(() => store.saveRun({ ...runInput(attempt.id), result: {} }), /Queued run/);
  assert.equal(store.listRuns(attempt.id).length, 1);
});

test('runtime inspection is finalized atomically with completion and terminal retries cannot overwrite it', (t) => {
  const { store, dbPath } = fixture(t);
  const attempt = store.startAttempt({ problemId: 'p1', language: 'python', problemVersion: 'v1' });
  const run = store.beginRun({ ...runInput(attempt.id), runtimeVersion: 'pending-inspection' });
  const completion = { status: 'passed' as const, result: { stdout: '1' }, runtimeVersion: 'Python 3.14.7' };
  assert.throws(() => store.finishRun(run.id, { ...completion, runtimeVersion: ' ' }), /runtimeVersion/);
  assert.deepEqual(store.getRun(run.id), run, 'invalid metadata must leave the queued snapshot unchanged');
  const raw = new DatabaseSync(dbPath);
  try {
    assert.throws(() => raw.prepare('UPDATE runs SET runtime_version = ? WHERE id = ?').run('early override', run.id), /terminal result/);
    for (const column of ['id', 'attempt_id', 'code', 'code_hash', 'test_suite_version', 'test_snapshot_json', 'adapter_version', 'created_at']) {
      assert.throws(() => raw.prepare(`UPDATE runs SET ${column} = ${column}, status = 'passed',
        result_json = '{}', finished_at = ?, runtime_version = ? WHERE id = ?`)
        .run(new Date().toISOString(), completion.runtimeVersion, run.id), /immutable/);
    }
    assert.deepEqual(store.getRun(run.id), run, 'rejected snapshot writes must also roll back runtime finalization');
    const finished = store.finishRun(run.id, completion);
    assert.deepEqual(finished, { ...run, status: completion.status, result: completion.result,
      runtimeVersion: completion.runtimeVersion, finishedAt: finished.finishedAt });
    assert.ok(finished.finishedAt);
    assert.deepEqual(store.finishRun(run.id, completion), finished);
    assert.deepEqual(store.finishRun(run.id, { ...completion, runtimeVersion: 'late different runtime' }), finished);
    assert.deepEqual(store.finishRun(run.id, { status: completion.status, result: completion.result }), finished);
    assert.throws(() => raw.prepare('UPDATE runs SET runtime_version = ? WHERE id = ?').run('late override', run.id), /immutable|terminal result/);
    assert.deepEqual(store.getRun(run.id), finished);
  } finally { raw.close(); }
  store.integrityCheck();
});

test('legacy runtime trigger update in an existing current-schema database preserves all tables and stored snapshots', (t) => {
  const { store, dbPath } = fixture(t);
  const attempt = store.startAttempt({ problemId: 'p1', language: 'python', problemVersion: 'v1' });
  const pending = store.beginRun({ ...runInput(attempt.id), runtimeVersion: 'pending-inspection' });
  const terminal = store.saveRun({ ...runInput(attempt.id, 'print(2)'), status: 'passed', result: { stdout: '2' } });
  store.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec(`DROP TRIGGER immutable_run_runtime;
    DROP TRIGGER immutable_run_snapshot;
    CREATE TRIGGER immutable_run_snapshot BEFORE UPDATE OF
      id, attempt_id, code, code_hash, test_suite_version, test_snapshot_json,
      adapter_version, runtime_version, created_at ON runs
    BEGIN SELECT RAISE(ABORT, 'run snapshot is immutable'); END;`);
  const tables = raw.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
  const rows = raw.prepare('SELECT * FROM runs ORDER BY rowid').all();
  const reopened = new PracticeStore(dbPath);
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 6);
    assert.equal(reopened.migrationBackupPath, null);
    assert.deepEqual(raw.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(), tables);
    assert.deepEqual(raw.prepare('SELECT * FROM runs ORDER BY rowid').all(), rows);
    assert.deepEqual(reopened.getRun(terminal.id), terminal);
    assert.equal(reopened.finishRun(pending.id, { status: 'passed', result: {}, runtimeVersion: 'Python 3.14.7' }).runtimeVersion, 'Python 3.14.7');
    assert.throws(() => raw.prepare('UPDATE runs SET runtime_version = ? WHERE id = ?').run('overwrite', terminal.id), /immutable|terminal result/);
    reopened.integrityCheck();
  } finally { reopened.close(); raw.close(); }
  const again = new PracticeStore(dbPath);
  try { assert.equal(again.getRun(pending.id)?.runtimeVersion, 'Python 3.14.7'); } finally { again.close(); }
});

test('foreign keys and unsupported schema versions fail instead of creating orphan data', (t) => {
  const { store, dbPath, directory } = fixture(t);
  assert.throws(() => store.saveRun(runInput('missing-attempt')), /Attempt not found/);
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA foreign_keys = ON');
    assert.throws(() => raw.prepare('INSERT INTO attempts (id, problem_id, language, problem_version, mode, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('orphan', 'missing-problem', 'python', 'missing-version', 'practice', new Date().toISOString()), /FOREIGN KEY/);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM attempts').get()?.count, 0);
  } finally { raw.close(); }
  const futurePath = join(directory, 'future.sqlite');
  const future = new DatabaseSync(futurePath);
  future.exec('PRAGMA user_version = 999');
  future.close();
  const before = readFileSync(futurePath);
  assert.throws(() => new PracticeStore(futurePath), /Unsupported schema version/);
  assert.deepEqual(readFileSync(futurePath), before);
});

test('SIGKILL during a real multi-table transaction preserves committed data and rolls back uncommitted writes', { timeout: 20000 }, async (t) => {
  const { store, dbPath } = fixture(t);
  store.close();
  const worker = fork(fileURLToPath(new URL('./fixtures/crash-worker.ts', import.meta.url)), [dbPath], {
    execArgv: process.execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  worker.stderr?.on('data', (chunk) => { errors += chunk.toString(); });
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); });
  const ready = await Promise.race([
    once(worker, 'message').then(([message]) => message),
    once(worker, 'exit').then(([code, signal]) => { throw new Error(`Worker exited before transaction opened: ${code}/${signal} ${errors}`); }),
  ]);
  assert.equal((ready as { state: string }).state, 'transaction-open');
  const exited = once(worker, 'exit');
  assert.equal(worker.kill('SIGKILL'), true);
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  const recovered = new PracticeStore(dbPath);
  try {
    recovered.integrityCheck();
    assert.equal(recovered.getDraft('crash-problem', 'python')?.code, 'COMMITTED');
    assert.equal(recovered.getDraft('crash-problem', 'python')?.revision, 1);
    assert.equal(recovered.getAttempt('rolledback-attempt'), undefined);
    assert.equal(recovered.listRuns('rolledback-attempt').length, 0);
    assert.equal(recovered.listRuns('committed-attempt').length, 1);
    assert.equal(recovered.getRun('committed-run')?.runtimeVersion, 'pending-inspection');
    assert.equal(recovered.recoverInterruptedRuns(), 1);
    assert.equal(recovered.recoverInterruptedRuns(), 0);
    const run = recovered.listRuns('committed-attempt')[0];
    assert.equal(run.status, 'interrupted');
    assert.equal(run.code, 'COMMITTED');
    assert.equal(run.runtimeVersion, 'pending-inspection', 'a hard exit before inspection must not invent runtime metadata');
    assert.throws(() => recovered.finishRun(run.id, { status: 'passed', result: {} }), /different terminal/);
  } finally { recovered.close(); }
});

test('online backup while editing restores an internally consistent self-contained database', async (t) => {
  const { store, directory } = fixture(t);
  const attempt = store.startAttempt({ id: 'backup-attempt', problemId: 'p1', language: 'python',
    problemVersion: 'v1', problemSnapshot: { title: '备份题面', padding: 'x'.repeat(3 * 1024 * 1024) } });
  for (let index = 0; index < 3; index++) {
    const run = store.saveRun(runInput(attempt.id, `print(${index})`));
    store.finishRun(run.id, { status: 'completed', result: { stdout: String(index) } });
  }
  store.saveDraft({ problemId: 'p1', language: 'python', code: 'generation-0' });
  const destination = join(directory, '在线 备份.sqlite');
  let completed = false;
  const pending = store.backupTo(destination).then((path) => { completed = true; return path; });
  assert.throws(() => store.close(), /backup is in progress/);
  let editsWhilePending = 0;
  for (let index = 1; index <= 8 && !completed; index++) {
    store.saveDraft({ problemId: 'p1', language: 'python', code: `generation-${index}` });
    editsWhilePending++;
    await nextTurn();
  }
  assert.equal(await pending, destination);
  assert.ok(editsWhilePending > 0, 'exercise writes while online backup is pending');
  const restoredPath = join(directory, '恢复 副本.sqlite');
  PracticeStore.restoreBackup(destination, restoredPath);
  const restored = new PracticeStore(restoredPath);
  try {
    restored.integrityCheck();
    assert.deepEqual(restored.listRuns(attempt.id), store.listRuns(attempt.id));
    assert.deepEqual(restored.getAttempt(attempt.id), store.getAttempt(attempt.id));
    const draft = restored.getDraft('p1', 'python')!;
    const generation = Number(draft.code.replace('generation-', ''));
    assert.equal(generation, 0, 'the dedicated reader pins committed WAL data before later edits');
    assert.equal(draft.revision, generation + 1);
    assert.equal(draft.codeHash, hashCode(draft.code));
  } finally { restored.close(); }
  await assert.rejects(store.backupTo(destination), /must not exist/);
  store.close();
  const closedDestination = join(directory, 'closed-store.sqlite');
  await assert.rejects(store.backupTo(closedDestination), /closed store/);
  assert.equal(existsSync(closedDestination), false);
});

test('corrupt backups and existing restore targets do not overwrite healthy data', (t) => {
  const { store, dbPath, directory } = fixture(t);
  store.saveDraft({ problemId: 'healthy', language: 'python', code: 'KEEP' });
  const corrupt = join(directory, 'corrupt.sqlite');
  writeFileSync(corrupt, 'this is not a sqlite database');
  const target = join(directory, 'rejected.sqlite');
  assert.throws(() => PracticeStore.restoreBackup(corrupt, target));
  assert.equal(existsSync(target), false);
  assert.throws(() => PracticeStore.restoreBackup(corrupt, dbPath), /must not exist/);
  assert.equal(store.getDraft('healthy', 'python')?.code, 'KEEP');
  store.integrityCheck();
});
