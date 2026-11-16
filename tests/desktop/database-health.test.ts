import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { checkDatabaseFile, clearIntegrityCheckRequest, INTEGRITY_CHECK_REQUEST, integrityCheckRequested, requestIntegrityCheck } from '../../src/desktop/database-health.ts';
import { isDatabaseCorruption } from '../../src/desktop/startup-errors.ts';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { APPLICATION_ID, SCHEMA_VERSION } from '../../src/storage/schema.ts';

function directory(t: test.TestContext) { const root = mkdtempSync(join(tmpdir(), 'db-health-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
/** A database with enough rows that a page in the middle belongs to the table, not the schema. */
function populated(file: string, lineage = false, rows = 20_000) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=DELETE; ${lineage ? `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};` : ''} CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX tv ON t(v);`);
  const insert = db.prepare('INSERT INTO t(v) VALUES (?)'); db.exec('BEGIN'); for (let i = 0; i < rows; i++) insert.run(`${'x'.repeat(100)}${i}`); db.exec('COMMIT'); db.close();
}
function damagePages(file: string) {
  const size = statSync(file).size, fd = openSync(file, 'r+');
  try { writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, Math.floor(size / 2 / 4096) * 4096); } finally { closeSync(fd); }
}

test('a healthy database passes, including committed transactions left in the WAL by a killed process', t => {
  const root = directory(t), file = join(root, 'practice.sqlite');
  // The child commits in WAL mode and is killed before it can checkpoint or close.
  const child = spawnSync(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('committed')");
    process.kill(process.pid, 'SIGKILL');`], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.ok(statSync(`${file}-wal`).size > 0, 'the commit is still only in the WAL');
  const before = digest(file);
  assert.deepEqual(checkDatabaseFile(file), { verdict: 'ok' });
  assert.equal(digest(file), before, 'the check never writes the main database file');
  const reader = new DatabaseSync(file, { readOnly: true });
  try { assert.deepEqual(reader.prepare('SELECT v FROM t').all().map(row => row.v), ['committed']); } finally { reader.close(); }
});

test('page damage and a file that is not a database are both reported as damage; a missing file is not', t => {
  const root = directory(t), pages = join(root, 'pages.sqlite'), garbage = join(root, 'garbage.sqlite');
  populated(pages); damagePages(pages);
  const opened = new DatabaseSync(pages); try { opened.prepare('PRAGMA user_version').get(); } finally { opened.close(); }
  const damaged = checkDatabaseFile(pages); assert.equal(damaged.verdict, 'corrupt', 'damage in table pages passes opening but not the full check');
  assert.ok(isDatabaseCorruption(damaged.error));
  writeFileSync(garbage, Buffer.alloc(8192, 0x41));
  const notDatabase = checkDatabaseFile(garbage); assert.equal(notDatabase.verdict, 'corrupt'); assert.ok(isDatabaseCorruption(notDatabase.error));
  assert.deepEqual(checkDatabaseFile(join(root, 'absent.sqlite')), { verdict: 'missing' });
});

test('real SQLite and store errors classify as damage by their codes', t => {
  const root = directory(t), garbage = join(root, 'garbage.sqlite'), pages = join(root, 'pages.sqlite');
  writeFileSync(garbage, Buffer.alloc(8192, 0x41));
  assert.throws(() => new PracticeStore(garbage), error => isDatabaseCorruption(error) && (error as { errcode?: number }).errcode === 26);
  populated(pages, true); damagePages(pages);
  const db = new DatabaseSync(pages);
  try { assert.throws(() => db.prepare('SELECT count(*), sum(length(v)) FROM t').get(), error => isDatabaseCorruption(error) && (error as { errcode?: number }).errcode === 11); }
  finally { db.close(); }
  assert.throws(() => PracticeStore.inspectBackupSnapshot(pages), error => isDatabaseCorruption(error), 'the store\'s own integrity check is typed damage');
});

test('the check request survives a restart until cleared and is idempotent', t => {
  const root = directory(t);
  assert.equal(integrityCheckRequested(root), false);
  requestIntegrityCheck(root, new Date('2026-11-13T10:00:00Z')); requestIntegrityCheck(root, new Date('2026-11-13T11:00:00Z'));
  assert.equal(integrityCheckRequested(root), true);
  assert.deepEqual(JSON.parse(readFileSync(join(root, INTEGRITY_CHECK_REQUEST), 'utf8')), { requestedAt: '2026-11-13T10:00:00.000Z' }, 'the first report is kept');
  assert.deepEqual(readdirSync(root), [INTEGRITY_CHECK_REQUEST], 'no temporary files are left behind');
  clearIntegrityCheckRequest(root); clearIntegrityCheckRequest(root);
  assert.equal(integrityCheckRequested(root), false); assert.equal(existsSync(join(root, INTEGRITY_CHECK_REQUEST)), false);
});
