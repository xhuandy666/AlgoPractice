import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { PracticeStore, hashCode } from '../../src/storage/practice-store.ts';
import { LANGUAGES } from '../../src/shared/languages.ts';
import { defaultLearningSettings } from '../../src/learning/repository.ts';
import { MIGRATE_V5 } from '../../src/interview/schema.ts';
import { MIGRATE_V7 } from '../../src/storage/submission-history-schema.ts';
import { MIGRATE_V8 } from '../../src/storage/answer-format-schema.ts';
import { MIGRATE_V10 } from '../../src/storage/language-schema.ts';

const at = '2026-10-13T00:00:00.000Z';
const frozenV9 = readFileSync(new URL('./fixtures/p9-schema.sql', import.meta.url), 'utf8');
const settings = JSON.stringify({ ...defaultLearningSettings(), timeZone: 'UTC', updatedAt: at });
const originalContent = { id: 'old', source: 'local', title: '原题', difficulty: '简单', tags: [],
  description: '旧题面不得更改', descriptionFormat: 'plain', constraints: [], mode: 'function',
  adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1], expected: 1 }],
  starter: { python: 'class Solution: pass', java: 'class Solution {}' } };
const originalSnapshot = JSON.stringify(originalContent, null, 2);

function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'tilian-v10 迁移 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function rows(db: DatabaseSync) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => [String(row.name), db.prepare(`SELECT rowid AS preserved_rowid, * FROM "${row.name}" ORDER BY rowid`).all()]));
}
function externalSchema(db: DatabaseSync) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND tbl_name NOT IN ('attempts','drafts') ORDER BY type,name").all();
}
function seedSettings(db: DatabaseSync, version: number) {
  if (version >= 3) db.prepare('INSERT INTO learning_settings VALUES (1,?)').run(settings);
  if (version === 9) {
    db.exec('INSERT INTO problem_review_meta VALUES (1,17)');
    db.prepare('INSERT INTO problem_review_migrations VALUES (?,?,?,?)').run('already-completed-v9', 'UTC', at, '{ "retained": true }');
  }
}
function seedV9(db: DatabaseSync) {
  seedSettings(db, 9);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN;');
  try {
    db.prepare('INSERT INTO problems VALUES (?)').run('old');
    db.prepare('INSERT INTO problem_versions VALUES (?,?,?)').run('old', 'v9-original', originalSnapshot);
    db.prepare('INSERT INTO library_problem_heads VALUES (?,?,?,?)').run('old', 'v9-original', at, at);
    for (const [rowid, language, format, code, revision] of [[7, 'python', 'function', '# 原始代码\r\n', 8],
      [89, 'java', 'acm', 'class Main {}', 13], [111, 'java', 'legacy', '未知旧草稿', 3]] as const) {
      db.prepare('INSERT INTO drafts(rowid,problem_id,language,scope_id,code,code_hash,revision,saved_at,answer_format,spec_version,test_config_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(rowid, 'old', language, 'practice', code, hashCode(code), revision, at, format, 'native-v1', format === 'acm' ? '{"version":1,"cases":[{"stdin":"1\\n","expected":""}],"compare":"exact"}' : 'null');
    }
    for (const [rowid, id, language, format] of [[42, 'active', 'python', 'function'], [3, 'finished', 'java', 'acm'], [900, 'restored', 'python', 'function']] as const) {
      db.prepare('INSERT INTO attempts(rowid,id,problem_id,language,problem_version,mode,started_at,draft_scope_id,answer_format) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(rowid, id, 'old', language, 'v9-original', 'practice', at, id === 'restored' ? 'restored:r9' : 'practice', format);
    }
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)")
      .run('r9', 'finished', 'class Main {}', hashCode('class Main {}'), 'suite9', '{ "cases": [], "untouched": true }', 'adapter9', 'OpenJDK 25', '{ "stdout": "中文\\n" }', at, at);
    db.prepare('UPDATE attempts SET ended_at=?,final_code=?,final_code_hash=?,final_draft_revision=?,final_last_run_id=?,last_run_matches_final=1,final_test_config_json=? WHERE id=?')
      .run(at, 'class Main {}', hashCode('class Main {}'), 13, 'r9', '{ "version": 1, "cases": [{"stdin":""}], "compare":"exact" }', 'finished');
    // Populate the restored source during INSERT semantics, not by bypassing its final trigger.
    db.exec('DELETE FROM attempts WHERE id=\'restored\'');
    db.prepare('INSERT INTO attempts(rowid,id,problem_id,language,problem_version,mode,started_at,draft_scope_id,restored_from_run_id) VALUES (900,?,?,?,?,?,?,?,?)')
      .run('restored', 'old', 'python', 'v9-original', 'practice', at, 'restored:r9', 'r9');
    db.exec("INSERT INTO active_attempts VALUES ('old','python','practice','practice','active','function'); INSERT INTO active_attempts VALUES ('old','python','practice','restored:r9','restored','function');");
    db.prepare('INSERT INTO draft_restorations VALUES (?,?,?,?,?)').run('restore9', 'r9', 'restored', 'restored:r9', at);
    db.prepare("INSERT INTO official_submissions VALUES (?, ?, ?, ?, 13, 'fixture', '1', '123', 'completed', ?, 'null', ?, ?, ?)")
      .run('official9', 'finished', 'class Main {}', hashCode('class Main {}'), '{ "status": "accepted", "statusMessage": "Accepted" }', at, at, at);
    db.prepare("INSERT INTO ai_requests VALUES (?, ?, ?, ?, 'completed', ?, 'null', 'null', NULL, ?, ?)")
      .run('ai9', 'active', hashCode('request9'), '{ "language": "python", "code": "旧代码" }', '{ "schemaVersion": 2, "explanation": "旧分析" }', at, at);
    db.prepare('INSERT INTO ai_help_state VALUES (?,?,NULL)').run('active', at);
    db.prepare("INSERT INTO ai_help_used VALUES ('ai9','active','adaptive',?)").run(at);
    db.prepare('INSERT INTO activity_samples VALUES (?,?,?,?,?,?)').run('activity9', 'activity-request9', 'active', 300, at, at);
    db.prepare('INSERT INTO interview_sessions VALUES (?,?,?,?)').run('interview9', 'interview-request9', at, '{ "language": "python", "original": true }');
    db.exec("INSERT INTO interview_attempts VALUES ('active','interview9')");
    db.prepare("INSERT INTO notes VALUES ('note9','problem','old',1,1,?,?)").run(at, at);
    db.prepare("INSERT INTO note_versions VALUES ('note9',1,'旧笔记','# 已确认内容','[]','ai','confirmed','ai9',?)").run(at);
    db.exec("INSERT INTO attempt_note_versions VALUES ('finished','note9',1)");
    db.exec('COMMIT');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

test('real v9 WAL upgrade retains every row, sparse rowid, pinned snapshot, external FK and final trigger', t => {
  const root = directory(t), path = join(root, 'practice.sqlite'), raw = new DatabaseSync(path);
  raw.exec(frozenV9); seedV9(raw);
  const before = rows(raw), beforeExternal = externalSchema(raw);
  assert.throws(() => raw.prepare("INSERT INTO drafts VALUES ('old','go','practice','go','hash',1,?,'function','native-v1','null')").run(at), /CHECK/);
  const exec = DatabaseSync.prototype.exec, fkAtBegin: number[] = [], fkAfterRestore: number[] = [];
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN IMMEDIATE') fkAtBegin.push(Number(this.prepare('PRAGMA foreign_keys').get()!.foreign_keys));
    const result = exec.call(this, sql);
    if (sql === 'PRAGMA foreign_keys = ON') fkAfterRestore.push(Number(this.prepare('PRAGMA foreign_keys').get()!.foreign_keys));
    return result;
  });
  let store: PracticeStore | null = null;
  try {
    store = new PracticeStore(path);
    assert.deepEqual(fkAtBegin, [0]); assert.deepEqual(fkAfterRestore, [1]);
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 10);
    assert.deepEqual(rows(raw), before, 'all table values, snapshot strings and sparse rowids remain exact');
    assert.deepEqual(externalSchema(raw), beforeExternal, 'parent references must not point to a temporary attempts table');
    assert.ok(store.migrationBackupPath?.includes('.before-v10-'));
    const backup = new DatabaseSync(store.migrationBackupPath!, { readOnly: true });
    try { assert.equal(PracticeStore.inspectBackupSnapshot(store.migrationBackupPath!).schemaVersion, 9); assert.deepEqual(rows(backup), before); }
    finally { backup.close(); }
    for (const column of ['language', 'draft_scope_id', 'problem_version', 'mode', 'started_at', 'answer_format', 'spec_version']) {
      assert.throws(() => raw.exec(`UPDATE attempts SET ${column}=${column} WHERE id='active'`), /immutable/);
    }
    for (const column of ['ended_at', 'final_code', 'final_code_hash', 'final_draft_revision', 'final_last_run_id', 'last_run_matches_final', 'final_test_config_json']) {
      assert.throws(() => raw.exec(`UPDATE attempts SET ${column}=${column} WHERE id='finished'`), /immutable/);
    }
    assert.throws(() => raw.prepare('UPDATE attempts SET restored_from_run_id=? WHERE id=?').run('r9', 'active'), /only be detached/);
    assert.throws(() => raw.prepare('UPDATE attempts SET ended_at=? WHERE id=?').run(at, 'active'), /requires a final draft/);
    assert.throws(() => raw.prepare('UPDATE attempts SET ended_at=?,final_code=?,final_code_hash=?,final_draft_revision=1,final_last_run_id=? WHERE id=?')
      .run(at, 'x', hashCode('x'), 'r9', 'active'), /must belong/);
    raw.exec("SAVEPOINT composite_fk; DELETE FROM active_attempts WHERE attempt_id='restored'");
    try { assert.throws(() => raw.exec("INSERT INTO active_attempts VALUES ('old','java','practice','wrong','restored','function')"), /FOREIGN KEY/); }
    finally { raw.exec('ROLLBACK TO composite_fk; RELEASE composite_fk'); }
    store.integrityCheck(); store.close(); store = new PracticeStore(path);
    assert.equal(store.migrationBackupPath, null); assert.deepEqual(rows(raw), before);
    assert.deepEqual(store.listAttempts('old').map(attempt => attempt.id), ['restored', 'active', 'finished']);
  } finally { store?.close(); raw.close(); }
});

test('failure after the whole v10 rebuild rolls schema, rows and version back and reenables foreign keys before closing', t => {
  const root = directory(t), path = join(root, 'practice.sqlite'), raw = new DatabaseSync(path);
  raw.exec(frozenV9); seedV9(raw);
  const before = rows(raw), schema = raw.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  const exec = DatabaseSync.prototype.exec, restoredStates: number[] = [];
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (sql === MIGRATE_V10) { assert.equal(this.isTransaction, true); throw new Error('injected-after-rebuild'); }
    if (sql === 'PRAGMA foreign_keys = ON') restoredStates.push(Number(this.prepare('PRAGMA foreign_keys').get()!.foreign_keys));
    return result;
  });
  try {
    assert.throws(() => new PracticeStore(path), /Schema v10 migration failed; original schema retained/);
    assert.deepEqual(restoredStates, [1]);
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 9);
    assert.deepEqual(rows(raw), before); assert.deepEqual(raw.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(), schema);
    assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
    const backups = readdirSync(root).filter(name => name.includes('.before-v10-') && name.endsWith('.sqlite'));
    assert.equal(backups.length, 1); assert.equal(readdirSync(root).some(name => name.endsWith('.partial')), false);
    const backup = new DatabaseSync(join(root, backups[0]), { readOnly: true });
    try { assert.deepEqual(rows(backup), before); } finally { backup.close(); }
  } finally { raw.close(); }
});

function legacySchema(db: DatabaseSync, version: number) {
  if (version <= 4) {
    const name = ({ 1: 'p1-schema.sql', 2: 'p2-schema.sql', 3: 'p3-schema.sql', 4: 'p3-v4-schema.sql' } as Record<number, string>)[version];
    db.exec(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  } else if (version === 9) db.exec(frozenV9);
  else {
    db.exec(readFileSync(new URL('./fixtures/p3-v4-schema.sql', import.meta.url), 'utf8')); db.exec(MIGRATE_V5);
    if (version >= 6) {
      const source = new DatabaseSync(':memory:');
      try {
        source.exec(frozenV9);
        for (const name of ['official_submissions', 'official_by_attempt', 'official_active_attempt', 'immutable_official_snapshot', 'immutable_official_id', 'immutable_official_result']) {
          db.exec(`${source.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)!.sql};`);
        }
        db.exec('DROP TABLE ai_help_used;'); db.exec(`${source.prepare("SELECT sql FROM sqlite_schema WHERE name='ai_help_used'").get()!.sql};`);
      } finally { source.close(); }
    }
    if (version >= 7) db.exec(MIGRATE_V7);
    if (version >= 8) db.exec(MIGRATE_V8);
    db.exec(`PRAGMA user_version=${version}`);
  }
  seedSettings(db, version);
  db.prepare('INSERT INTO problems VALUES (?)').run('old');
  db.prepare('INSERT INTO problem_versions VALUES (?,?,?)').run('old', 'original', originalSnapshot);
  const code = `retained-v${version}`;
  if (version < 8) db.prepare('INSERT INTO drafts VALUES (?,?,?,?,?,?,?)').run('old', 'python', 'practice', code, hashCode(code), 7, at);
  else db.prepare("INSERT INTO drafts VALUES ('old','python','practice',?,?,7,?,'function','native-v1','null')").run(code, hashCode(code), at);
}

for (let version = 1; version <= 9; version++) test(`v${version} backup is accepted, upgraded once, and restored without losing its original draft`, async t => {
  const root = directory(t), path = join(root, 'practice.sqlite'), old = new DatabaseSync(path);
  legacySchema(old, version); old.close();
  let store: PracticeStore | null = new PracticeStore(path);
  try {
    const beforePath = store.migrationBackupPath!;
    assert.equal(PracticeStore.inspectBackupSnapshot(beforePath).schemaVersion, version);
    assert.equal(store.getDraft('old', 'python')?.code, `retained-v${version}`);
    assert.equal(store.getDraft('old', 'python')?.revision, 7);
    store.saveDraft({ problemId: 'old', language: 'go', code: 'Go after migration' });
    store.saveDraft({ problemId: 'old', language: 'cpp', code: 'C++ after migration' });
    store.integrityCheck();
    const currentBackup = join(root, 'current.sqlite'); await store.backupTo(currentBackup);
    assert.equal(PracticeStore.inspectBackupSnapshot(currentBackup).schemaVersion, 10);
    const restore = join(root, 'restore-old.sqlite'); PracticeStore.restoreBackup(beforePath, restore);
    const restored = new PracticeStore(restore);
    try { assert.equal(restored.getDraft('old', 'python')?.code, `retained-v${version}`); assert.equal(restored.getDraft('old', 'go'), undefined); restored.integrityCheck(); }
    finally { restored.close(); }
    store.close(); store = new PracticeStore(path); assert.equal(store.migrationBackupPath, null);
    assert.equal(store.getDraft('old', 'go')?.code, 'Go after migration'); assert.equal(store.getDraft('old', 'cpp')?.code, 'C++ after migration');
  } finally { store?.close(); }
});

test('four languages, two answer formats and independent scopes survive backup/restore with revision CAS and immutable run identities', async t => {
  const root = directory(t), path = join(root, 'practice.sqlite'), store = new PracticeStore(path);
  try {
    const problem = store.upsertProblem({ ...originalContent, descriptionFormat: 'plain', mode: 'function', source: 'local',
      adapter: { method: 'solve', params: ['int'], returns: 'int' }, starter: Object.fromEntries(LANGUAGES.map(language => [language, `${language} template`])) });
    for (const language of LANGUAGES) for (const answerFormat of ['function', 'acm'] as const) for (const scopeId of ['practice', 'isolated']) {
      const code = `${language}-${answerFormat}-${scopeId}`;
      const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language, answerFormat, draftScopeId: scopeId });
      const draft = store.saveDraft({ problemId: problem.id, language, answerFormat, scopeId, code, expectedRevision: 0,
        ...(answerFormat === 'acm' ? { testConfig: { version: 1, compare: 'exact', cases: [{ stdin: language, expected: '' }] } } as const : {}) });
      assert.equal(draft.revision, 1);
      assert.throws(() => store.saveDraft({ problemId: problem.id, language, answerFormat, scopeId, code: 'stale', expectedRevision: 0 }), /revision conflict/);
      const run = store.saveRun({ attemptId: attempt.id, code, testSuiteVersion: 'suite', adapterVersion: 'v1', runtimeVersion: `${language}-test`, status: 'completed', result: {} });
      assert.equal(run.language, language); assert.equal(run.answerFormat, answerFormat);
      assert.equal(store.getActiveAttempt(problem.id, language, 'practice', scopeId, answerFormat)?.id, attempt.id);
      if (scopeId === 'isolated') store.finishAttempt(attempt.id);
    }
    assert.equal(store.listAttempts(problem.id).length, 16);
    const backup = join(root, 'four-languages.sqlite'); await store.backupTo(backup);
    const restoredPath = join(root, 'restored.sqlite'); PracticeStore.restoreBackup(backup, restoredPath);
    const restored = new PracticeStore(restoredPath);
    try {
      assert.equal(restored.migrationBackupPath, null);
      for (const language of LANGUAGES) for (const format of ['function', 'acm'] as const) for (const scope of ['practice', 'isolated']) {
        assert.equal(restored.getDraft(problem.id, language, scope, format)?.code, `${language}-${format}-${scope}`);
      }
      assert.equal(restored.listAttempts(problem.id).length, 16); restored.integrityCheck();
    } finally { restored.close(); }
  } finally { store.close(); }
});
