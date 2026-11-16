import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { PracticeStore, TERMINAL_STATUSES } from '../../src/storage/practice-store.ts';
import { APPLICATION_ID, SCHEMA, SCHEMA_VERSION } from '../../src/storage/schema.ts';

function directory(t: TestContext) { const root = mkdtempSync(join(tmpdir(), 'tilian-lineage-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const header = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return { applicationId: Number(db.prepare('PRAGMA application_id').get()!.application_id), version: Number(db.prepare('PRAGMA user_version').get()!.user_version) }; }
  finally { db.close(); }
};

test('a new database is created in one step with this lineage\'s marker and reopens as is', t => {
  const root = directory(t), file = join(root, 'practice.sqlite');
  const store = new PracticeStore(file); store.saveDraft({ problemId: 'p', language: 'python', code: 'kept' }); store.close();
  assert.deepEqual(header(file), { applicationId: APPLICATION_ID, version: SCHEMA_VERSION });
  const beforeReopen = digest(file);
  const reopened = new PracticeStore(file);
  try { assert.equal(reopened.getDraft('p', 'python')?.code, 'kept'); reopened.integrityCheck(); } finally { reopened.close(); }
  assert.equal(digest(file), beforeReopen, 'opening a writable database does not change its persisted contents');
});

test('databases of earlier versions and foreign SQLite files are refused without changing a byte', t => {
  const root = directory(t);
  const cases = {
    // What a v0.91 database looks like: schema version 10, no lineage marker.
    'earlier-version.sqlite': 'PRAGMA user_version = 10; CREATE TABLE problems (id TEXT PRIMARY KEY NOT NULL) STRICT;',
    'earlier-wal.sqlite': 'PRAGMA journal_mode = WAL; PRAGMA user_version = 3; CREATE TABLE drafts (code TEXT);',
    'foreign.sqlite': 'CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES (\'someone else\');',
    'other-lineage.sqlite': `PRAGMA application_id = ${APPLICATION_ID + 1}; PRAGMA user_version = ${SCHEMA_VERSION}; CREATE TABLE x (y TEXT);`,
  };
  for (const [name, sql] of Object.entries(cases)) {
    const file = join(root, name), db = new DatabaseSync(file); db.exec(sql); db.close();
    const before = digest(file), siblings = readdirSync(root).sort();
    assert.throws(() => new PracticeStore(file), /Unsupported schema version/, name);
    assert.equal(digest(file), before, `${name}: the file is never written`);
    assert.deepEqual(readdirSync(root).sort(), siblings, `${name}: no sidecar or backup files are left behind`);
  }
  assert.ok(!existsSync(join(root, 'practice.sqlite')));
});

test('backup snapshots must carry this lineage', t => {
  const root = directory(t), old = join(root, 'old.sqlite'), db = new DatabaseSync(old);
  db.exec('PRAGMA user_version = 10; CREATE TABLE problem_versions (snapshot_json TEXT);'); db.close();
  assert.throws(() => PracticeStore.inspectBackupSnapshot(old), /Unsupported backup schema version/);
});

test('the schema accepts exactly the run statuses the code knows', () => {
  const check = /status TEXT NOT NULL CHECK\(status IN \(([^)]*)\)\),\n  result_json/.exec(SCHEMA);
  assert.ok(check, 'runs.status CHECK found');
  assert.deepEqual(check[1].split(',').map(value => value.trim().replace(/^'|'$/g, '')).sort(), ['queued', ...TERMINAL_STATUSES].sort());
});
