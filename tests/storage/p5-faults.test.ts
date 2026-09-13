import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PracticeStore, hashCode } from '../../src/storage/practice-store.ts';

function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'AlgoPractice P5 存储故障 '));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function fingerprint(path: string) {
  return Object.fromEntries(readdirSync(path).sort().map(name => [name,
    createHash('sha256').update(readFileSync(join(path, name))).digest('hex')]));
}

function createLegacy(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(readFileSync(new URL('./fixtures/p3-v4-schema.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO problems VALUES (?)').run('confirmed');
    db.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'confirmed', 'python', 'practice', 'CONFIRMED', hashCode('CONFIRMED'), 1, '2026-09-01T00:00:00.000Z');
  } finally { db.close(); }
}

function inspectLegacy(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: db.prepare('PRAGMA user_version').get()?.user_version,
      integrity: db.prepare('PRAGMA integrity_check').get()?.integrity_check,
      foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
      schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
      drafts: db.prepare('SELECT * FROM drafts ORDER BY problem_id, language, scope_id').all(),
    };
  } finally { db.close(); }
}

// Each probe runs in its own process. Capture the actual Store connection only
// during construction, restore the native method immediately, then ask SQLite
// itself to reject growth. No Store SQL, error, commit, or rollback is mocked.
// max_page_count is connection-local, so a separate raw connection is insufficient.
const fullProbe = String.raw`
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
const { PracticeStore } = await import(pathToFileURL(process.argv[1]).href);
const dbPath = process.argv[2], scenario = process.argv[3];
let connection, store;
const nativeExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  connection = this;
  return nativeExec.call(this, sql);
};
try { store = new PracticeStore(dbPath); }
finally { DatabaseSync.prototype.exec = nativeExec; }
try {
  if (!connection) throw new Error('Store connection was not captured');
  const confirmed = store.saveDraft({ problemId: 'confirmed', language: 'python', code: 'CONFIRMED', expectedRevision: 0 });
  const attempt = store.startAttempt({ problemId: 'confirmed', language: 'python', problemVersion: 'v1' });
  const note = store.saveNote({ requestId: 'confirmed-note', kind: 'topic', subjectId: 'P5', title: 'Confirmed', markdown: 'CONFIRMED', state: 'confirmed' });
  const runInput = { attemptId: attempt.id, code: 'INCOMPLETE', expectedDraftRevision: 1,
    testSuiteVersion: 'p5-v1', adapterVersion: 'p5-v1', runtimeVersion: 'not-started' };
  const pageCount = connection.prepare('PRAGMA page_count').get().page_count;
  const previousLimit = connection.prepare('PRAGMA max_page_count').get().max_page_count;
  // Give small nested draft changes room; the larger payload cannot fit.
  const limit = connection.prepare('PRAGMA max_page_count=' + (pageCount + 2)).get().max_page_count;
  let failure = null;
  try {
    if (scenario === 'draft') store.saveDraft({ problemId: 'confirmed', language: 'python', code: 'x'.repeat(4 * 1024 * 1024), expectedRevision: 1 });
    else if (scenario === 'run') store.beginRun({ ...runInput, testSnapshot: { padding: 'x'.repeat(4 * 1024 * 1024) } });
    else if (scenario === 'note') store.saveNote({ requestId: 'full-note', noteId: note.id, kind: note.kind, subjectId: note.subjectId,
      title: 'INCOMPLETE', markdown: 'x'.repeat(512 * 1024), state: 'confirmed', expectedVersion: 1 });
    else throw new Error('Unknown scenario: ' + scenario);
  } catch (error) { failure = { message: error.message, code: error.code, errcode: error.errcode, errstr: error.errstr }; }
  const afterFailure = { draft: store.getDraft('confirmed', 'python'), note: store.getNote(note.id),
    runs: store.listRuns(attempt.id), isTransaction: connection.isTransaction };
  store.integrityCheck();
  connection.exec('PRAGMA max_page_count=' + previousLimit);
  const restoredLimit = connection.prepare('PRAGMA max_page_count').get().max_page_count;
  let recovered;
  if (scenario === 'draft') recovered = store.saveDraft({ problemId: 'confirmed', language: 'python', code: 'RECOVERED', expectedRevision: 1 });
  else if (scenario === 'run') recovered = store.beginRun({ ...runInput, testSnapshot: { cases: [] } });
  else recovered = store.saveNote({ requestId: 'full-note', noteId: note.id, kind: note.kind, subjectId: note.subjectId,
    title: 'Recovered', markdown: 'RECOVERED', state: 'confirmed', expectedVersion: 1 });
  store.close();
  store = new PracticeStore(dbPath);
  store.integrityCheck();
  const reopened = { draft: store.getDraft('confirmed', 'python'), note: store.getNote(note.id), runs: store.listRuns(attempt.id) };
  process.stdout.write(JSON.stringify({ scenario, pageCount, limit, previousLimit, restoredLimit, failure, confirmed, note, afterFailure, recovered, reopened }));
} finally { store.close(); }
`;

type FullResult = {
  scenario: string; pageCount: number; limit: number; previousLimit: number; restoredLimit: number;
  failure: { message: string; code: string; errcode: number; errstr: string } | null;
  confirmed: ReturnType<PracticeStore['saveDraft']>;
  note: ReturnType<PracticeStore['saveNote']>;
  afterFailure: { draft: ReturnType<PracticeStore['getDraft']>; note: ReturnType<PracticeStore['getNote']>;
    runs: ReturnType<PracticeStore['listRuns']>; isTransaction: boolean };
  reopened: { draft: ReturnType<PracticeStore['getDraft']>; note: ReturnType<PracticeStore['getNote']>;
    runs: ReturnType<PracticeStore['listRuns']> };
};

for (const scenario of ['draft', 'run', 'note']) {
  test(`E18: real SQLITE_FULL during ${scenario} preserves acknowledged data and permits retry and restart`, { timeout: 20000 }, t => {
    const path = directory(t);
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', fullProbe,
      fileURLToPath(new URL('../../src/storage/practice-store.ts', import.meta.url)), join(path, 'practice.sqlite'), scenario], {
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const probe = JSON.parse(result.stdout) as FullResult;
    t.diagnostic(JSON.stringify({ scenario, sqliteError: probe.failure, pageCount: probe.pageCount, maxPageCount: probe.limit }));
    assert.equal(probe.limit, probe.pageCount + 2);
    assert.equal(probe.restoredLimit, probe.previousLimit);
    assert.equal(probe.afterFailure.isTransaction, false, 'SQLite rolls back the failed write automatically');
    assert.deepEqual(probe.afterFailure.draft, probe.confirmed);
    assert.deepEqual(probe.afterFailure.note, probe.note);
    assert.equal(probe.afterFailure.runs.length, 0, 'failed nested beginRun does not publish a queued snapshot');
    if (scenario === 'draft') {
      assert.equal(probe.reopened.draft?.code, 'RECOVERED');
      assert.equal(probe.reopened.draft?.revision, 2);
    } else if (scenario === 'run') {
      assert.equal(probe.reopened.draft?.code, 'INCOMPLETE');
      assert.equal(probe.reopened.draft?.revision, 2);
      assert.equal(probe.reopened.runs.length, 1);
      assert.equal(probe.reopened.runs[0].status, 'queued');
    } else {
      assert.equal(probe.reopened.note?.current.markdown, 'RECOVERED');
      assert.equal(probe.reopened.note?.current.version, 2);
      assert.equal(probe.reopened.note?.confirmedVersion, 2);
    }
    assert.equal(probe.failure?.errcode, 13, 'propagate native SQLITE_FULL, never mask it with a second ROLLBACK error');
    assert.match(probe.failure?.message ?? '', /database or disk is full/);
  });
}

test('P5-04: a future schema is rejected without changing bytes, journal mode, or creating sidecar/backup files', t => {
  const path = directory(t), dbPath = join(path, 'future.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE future_only(id TEXT PRIMARY KEY, payload TEXT); PRAGMA user_version=999;');
    db.prepare('INSERT INTO future_only VALUES (?, ?)').run('future-data', '不可覆盖');
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
  } finally { db.close(); }
  const before = fingerprint(path);
  assert.throws(() => new PracticeStore(dbPath), /Unsupported schema version: 999/);
  assert.deepEqual(fingerprint(path), before);
});

test('P5-04: conflicting migration preserves all original schema/data and its backup can be repaired and reopened', t => {
  const path = directory(t), dbPath = join(path, 'practice.sqlite');
  createLegacy(dbPath);
  const raw = new DatabaseSync(dbPath);
  try { raw.exec('CREATE TABLE interview_sessions(conflicting_fixture TEXT) STRICT;'); } finally { raw.close(); }
  const before = inspectLegacy(dbPath);
  assert.throws(() => new PracticeStore(dbPath), /Schema v6 migration failed/);
  assert.deepEqual(inspectLegacy(dbPath), before);
  const backups = readdirSync(path).filter(name => name.includes('.before-v6-') && name.endsWith('.sqlite'));
  assert.equal(backups.length, 1);
  assert.equal(readdirSync(path).some(name => name.endsWith('.partial')), false);
  const backupPath = join(path, backups[0]);
  assert.deepEqual(inspectLegacy(backupPath), before);
  const backupHash = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
  const restoredPath = join(path, 'restored.sqlite');
  PracticeStore.restoreBackup(backupPath, restoredPath);
  assert.deepEqual(inspectLegacy(restoredPath), before);
  const repair = new DatabaseSync(restoredPath);
  try { repair.exec('DROP TABLE interview_sessions;'); } finally { repair.close(); }
  const restored = new PracticeStore(restoredPath);
  try {
    assert.equal(restored.getDraft('confirmed', 'python')?.code, 'CONFIRMED');
    assert.equal(restored.saveDraft({ problemId: 'confirmed', language: 'python', code: 'RECOVERED', expectedRevision: 1 }).revision, 2);
    restored.integrityCheck();
  } finally { restored.close(); }
  assert.deepEqual(inspectLegacy(dbPath), before, 'repairing a restored copy leaves the failed source untouched');
  assert.equal(createHash('sha256').update(readFileSync(backupPath)).digest('hex'), backupHash);
});

for (const fault of ['directory-readonly', 'database-readonly', 'database-unreadable'] as const) {
  test(`E18: actual POSIX ${fault} rejects access and acknowledged saves recover after permissions are restored`, {
    skip: process.platform === 'win32' ? 'POSIX chmod does not establish Windows ACL denial; Windows native permissions remain a separate E18 check' : false,
  }, t => {
    assert.notEqual(process.getuid?.(), 0, 'a root process cannot validate POSIX permission denial');
    const path = directory(t), dbPath = join(path, 'practice.sqlite');
    const initial = new PracticeStore(dbPath);
    const confirmed = initial.saveDraft({ problemId: 'confirmed', language: 'python', code: 'CONFIRMED' });
    initial.close();
    const before = fingerprint(path);
    try {
      if (fault === 'directory-readonly') chmodSync(path, 0o500);
      else chmodSync(dbPath, fault === 'database-readonly' ? 0o400 : 0o000);
      if (fault === 'directory-readonly') {
        assert.throws(() => writeFileSync(join(path, 'permission-probe'), 'x'), { code: 'EACCES' });
      } else if (fault === 'database-unreadable') {
        assert.throws(() => readFileSync(dbPath), { code: 'EACCES' });
      }
      let opened: PracticeStore | undefined;
      try { assert.throws(() => { opened = new PracticeStore(dbPath); }, /readonly|read-only|unable to open|permission denied|EACCES/i); }
      finally { opened?.close(); }
    } finally {
      chmodSync(path, 0o700);
      // SQLite may create WAL/SHM files using the readonly database's mode.
      // Restoring storage permissions includes those files; never delete them.
      for (const name of readdirSync(path)) chmodSync(join(path, name), 0o600);
    }
    assert.equal(fingerprint(path)['practice.sqlite'], before['practice.sqlite'], 'permission failures must not change acknowledged database bytes');
    assert.equal(readdirSync(path).some(name => name.endsWith('.partial') || name.includes('.before-')), false);
    const restored = new PracticeStore(dbPath);
    try {
      assert.deepEqual(restored.getDraft('confirmed', 'python'), confirmed);
      assert.equal(restored.saveDraft({ problemId: 'confirmed', language: 'python', code: 'RECOVERED', expectedRevision: 1 }).revision, 2);
      restored.integrityCheck();
    } finally { restored.close(); }
  });
}
