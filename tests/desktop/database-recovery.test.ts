import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { test } from 'node:test';
import { AttachmentService } from '../../src/desktop/attachment-service.ts';
import { BackupService, recoverInterruptedRestore } from '../../src/desktop/backup-service.ts';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { INTEGRITY_CHECK_REQUEST, requestIntegrityCheck } from '../../src/desktop/database-health.ts';
import { damagedDatabasePrompt, describeAge, keptDirectoryName, openWithRecovery, type DamagedDatabasePrompt } from '../../src/desktop/database-recovery.ts';
import { integrityFailure } from '../../src/storage/sqlite-integrity.ts';
import { AI_PROVIDER_SETTINGS_FILE, DEFAULT_REMINDER_SETTINGS, REMINDER_SETTINGS_FILE, type BackupSnapshot, type RestoreLifecycle } from '../../src/shared/maintenance.ts';

const learning = { dailyReviewBudget: 3, dailyPracticeGoal: 3, timeZone: 'Asia/Shanghai', updatedAt: '2026-09-08T00:00:00.000Z', aiAutoAnalyzeOfficial: false };
const NOW = new Date('2026-11-13T08:00:00Z');
function inspectSnapshot(path: string): BackupSnapshot {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']);
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version); if (version !== 3) throw new Error('unsupported schema');
    return { schemaVersion: version, attachments: [], mediaHashes: db.prepare('SELECT DISTINCT hash FROM media_versions ORDER BY hash').all().map(row => String(row.hash)),
      learningSettings: JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key='learning'").get()!.value)) };
  } finally { db.close(); }
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Every file and folder under root with its content hash: "byte-identical" means equal trees. */
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => { for (const name of readdirSync(directory).sort()) { const path = join(directory, name); if (statSync(path).isDirectory()) { result[relative(root, path)] = 'dir'; walk(path); } else result[relative(root, path)] = sha(readFileSync(path)); } };
  walk(root); return result;
}
const garbage = Buffer.alloc(8192, 0x41), staleWal = Buffer.from('stale write-ahead log of the damaged file');
const media = (text: string) => { const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(text)]); return { bytes, hash: sha(bytes) }; };

/** A data directory whose history holds a manual backup (v1), an automatic one (v2, newest usable) and a before-restore
 * one (v3, newest of all but never offered); the live file then gets damaged. */
async function fixture(t: test.TestContext, options: { damage?: 'garbage' | 'pages' | 'none' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'db-recovery-')), openedDatabases: DatabaseSync[] = [];
  let database: DatabaseSync | undefined;
  // after hooks run in registration order; Windows cannot remove a database while a later hook still owns it.
  t.after(() => { database?.close(); for (const db of openedDatabases) db.close(); rmSync(root, { recursive: true, force: true }); });
  const file = join(root, 'practice.sqlite'); let now = new Date('2026-11-10T08:00:00Z');
  database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=3; CREATE TABLE items(value TEXT); CREATE TABLE media_versions(hash TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE filler(v TEXT);");
  database.prepare('INSERT INTO items VALUES (?)').run('v1'); database.prepare('INSERT INTO settings VALUES (?, ?)').run('learning', JSON.stringify(learning));
  const lifecycle: RestoreLifecycle = { hasActiveInterview: () => false, enterMaintenance: async () => {}, closeDatabase: () => {}, openDatabase: () => {}, clearCredentials: async () => {}, leaveMaintenance: () => {} };
  const service = new BackupService({ dataDirectory: root, appVersion: '0.91.0', now: () => now, snapshotDatabase: path => sqliteBackup(database!, path), inspectSnapshot, getReminderSettings: () => ({ ...DEFAULT_REMINDER_SETTINGS }), lifecycle });
  const older = media('in every backup'), newer = media('only in the damaged data');
  const mediaDirectory = join(root, 'media'); mkdirSync(mediaDirectory);
  writeFileSync(join(mediaDirectory, older.hash), older.bytes); database.prepare('INSERT INTO media_versions VALUES (?)').run(older.hash);
  await service.create('manual');
  now = new Date('2026-11-12T08:00:00Z'); database.prepare("UPDATE items SET value='v2'").run();
  assert.ok(await service.autoBackup('Asia/Shanghai'), 'an automatic backup of v2');
  now = new Date('2026-11-13T07:00:00Z'); database.prepare("UPDATE items SET value='v3'").run();
  writeFileSync(join(mediaDirectory, newer.hash), newer.bytes); database.prepare('INSERT INTO media_versions VALUES (?)').run(newer.hash);
  await service.create('before-restore');
  writeFileSync(join(root, REMINDER_SETTINGS_FILE), '{"device":"reminders"}'); writeFileSync(join(root, AI_PROVIDER_SETTINGS_FILE), '{"device":"ai"}');
  if (options.damage === 'pages') {
    const insert = database.prepare('INSERT INTO filler VALUES (?)'); database.exec('BEGIN'); for (let i = 0; i < 20_000; i++) insert.run(`${'x'.repeat(100)}${i}`); database.exec('COMMIT');
  }
  database.close(); database = undefined;
  if (options.damage === 'garbage' || options.damage === undefined) { writeFileSync(file, garbage); writeFileSync(`${file}-wal`, staleWal); }
  if (options.damage === 'pages') { const size = statSync(file).size, fd = openSync(file, 'r+'); try { writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, Math.floor(size * 0.7 / 4096) * 4096); } finally { closeSync(fd); } }
  const backups = readdirSync(join(root, 'backups')).sort();
  return { root, file, older, newer, backups, trackDatabase: (db: DatabaseSync) => { openedDatabases.push(db); return db; } };
}
/** The app's startup steps, reduced: open, check, read. Closes what it opened before throwing. */
function opener(file: string, onCall?: (call: number) => void) {
  let calls = 0; const handles: DatabaseSync[] = [];
  return { handles, calls: () => calls, open: () => {
    calls++; onCall?.(calls);
    const db = new DatabaseSync(file);
    try { db.prepare('SELECT value FROM items').get(); handles.push(db); return db; } catch (error) { db.close(); throw error; }
  } };
}
function run(root: string, open: () => DatabaseSync, answers: number[] = []) {
  const prompts: DamagedDatabasePrompt[] = [], events: string[] = [];
  const result = openWithRecovery({ dataDirectory: root, appVersion: '0.91.0', inspectSnapshot, open, close: db => db.close(), now: () => NOW,
    log: event => { events.push(event); }, ask: async prompt => { prompts.push(prompt); assert.ok(answers.length, 'asked more often than expected'); return answers.shift()!; } });
  return { result, prompts, events };
}

test('prompt wording: backup age and time, what is lost, where the damaged copy goes; nothing to offer gives null', () => {
  assert.equal(describeAge('2026-11-13T07:59:30Z', NOW), '刚刚'); assert.equal(describeAge('2026-11-13T07:15:00Z', NOW), '约 45 分钟前');
  assert.equal(describeAge('2026-11-12T08:00:00Z', NOW), '约 24 小时前'); assert.equal(describeAge('2026-11-01T08:00:00Z', NOW), '约 12 天前');
  assert.equal(describeAge('2026-11-14T08:00:00Z', NOW), '刚刚', 'a clock that ran backwards');
  assert.match(keptDirectoryName(NOW, 'abcdef01'), /^damaged-\d{8}-\d{6}-abcdef01$/);
  const backup = { path: '/data/backups/automatic-x.algobak', bytes: 1, manifest: { createdAt: '2026-11-12T08:00:00Z', kind: 'automatic' } } as never;
  const restoreOnly = damagedDatabasePrompt({ backup, canOpen: false, keptPath: '/data/damaged-x', dataDirectory: '/data', now: NOW, formatTime: () => '2026-11-12 16:00' })!;
  assert.deepEqual(restoreOnly.actions, ['restore', 'quit']); assert.equal(restoreOnly.buttons[restoreOnly.cancelId], '退出');
  assert.match(restoreOnly.detail, /2026-11-12 16:00（约 24 小时前，自动备份）/); assert.match(restoreOnly.detail, /之后的练习、笔记和复习记录会丢失/); assert.match(restoreOnly.detail, /\/data\/damaged-x/);
  const withOpen = damagedDatabasePrompt({ backup, canOpen: true, keptPath: '/data/damaged-x', dataDirectory: '/data', now: NOW })!;
  assert.deepEqual(withOpen.actions, ['restore', 'open', 'quit']); assert.equal(withOpen.actions[withOpen.cancelId], 'quit');
  assert.deepEqual(damagedDatabasePrompt({ backup: null, canOpen: true, keptPath: '', dataDirectory: '/data', now: NOW })!.actions, ['open', 'quit']);
  assert.equal(damagedDatabasePrompt({ backup: null, canOpen: false, keptPath: '', dataDirectory: '/data', now: NOW }), null);
});

test('a healthy database opens directly; a stale check request is cleared after the file passes', async t => {
  const f = await fixture(t, { damage: 'none' }), { open, calls } = opener(f.file);
  requestIntegrityCheck(f.root);
  const { result, prompts, events } = run(f.root, open);
  const opened = await result; assert.ok('store' in opened && !opened.restored); (opened as { store: DatabaseSync }).store.close();
  assert.equal(calls(), 1); assert.equal(prompts.length, 0); assert.ok(!existsSync(join(f.root, INTEGRITY_CHECK_REQUEST)));
  assert.deepEqual(events, ['database.integrity-checked']);
});

test('restore from the newest valid backup keeps a copy of the damaged files, device settings and every media file', async t => {
  const f = await fixture(t), { open } = opener(f.file);
  const before = tree(f.root);
  const { result, prompts } = run(f.root, open, [0]);
  const opened = await result; assert.ok('store' in opened);
  const store = f.trackDatabase(opened.store);
  assert.equal(store.prepare('SELECT value FROM items').get()!.value, 'v2', 'the automatic backup, not the newer before-restore one');
  assert.equal(prompts.length, 1); assert.deepEqual(prompts[0].actions, ['restore', 'quit']); assert.match(prompts[0].detail, /自动备份/);
  assert.equal(opened.restored?.manifest.kind, 'automatic');
  const kept = opened.restored!.keptDirectory; assert.match(prompts[0].detail, new RegExp(kept.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')));
  assert.equal(sha(readFileSync(join(kept, 'practice.sqlite'))), sha(garbage)); assert.equal(sha(readFileSync(join(kept, 'practice.sqlite-wal'))), sha(staleWal));
  const wal = join(f.root, 'practice.sqlite-wal');
  assert.ok(!existsSync(wal) || !readFileSync(wal).equals(staleWal), 'the damaged file\'s WAL never sits next to the restored database');
  for (const name of [REMINDER_SETTINGS_FILE, AI_PROVIDER_SETTINGS_FILE]) assert.equal(tree(f.root)[name], before[name], `${name} unchanged`);
  assert.ok(existsSync(join(f.root, 'media', f.older.hash)) && existsSync(join(f.root, 'media', f.newer.hash)), 'media of the damaged data stay next to the backup\'s');
  assert.deepEqual(readdirSync(join(f.root, 'backups')).sort(), f.backups, 'no backup is created or removed');
  assert.deepEqual(readdirSync(f.root).filter(name => /^\.(restore|verify|backup)-|journal/.test(name)), [], 'no journal or staging left');
});

test('declining leaves the data directory byte-identical', async t => {
  const f = await fixture(t), before = tree(f.root), { open } = opener(f.file);
  const { result, prompts } = run(f.root, open, [1]);
  assert.deepEqual(await result, { quit: true }); assert.equal(prompts.length, 1);
  assert.deepEqual(tree(f.root), before);
});

test('no offer without SQLite damage of the live file itself, or without a valid backup; the directory stays byte-identical', async t => {
  const sqlite = (message: string, errcode: number) => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
  const healthy = await fixture(t, { damage: 'none' }), before = tree(healthy.root);
  for (const error of [sqlite('database or disk is full', 13), sqlite('attempt to write a readonly database', 8), sqlite('disk I/O error', 10), sqlite('database is locked', 5),
    new Error('Unsupported schema version: 99'), new Error('Schema v10 migration failed; original schema retained.', { cause: sqlite('database disk image is malformed', 11) }),
    integrityFailure(), sqlite('database disk image is malformed', 11)]) {
    const { result, prompts } = run(healthy.root, () => { throw error; });
    await assert.rejects(result, thrown => thrown === error, error.message); assert.equal(prompts.length, 0, error.message);
  }
  assert.deepEqual(tree(healthy.root), before, 'a damage report about a file that passes the full check changes nothing');
  const damaged = await fixture(t);
  for (const name of damaged.backups) writeFileSync(join(damaged.root, 'backups', name), Buffer.alloc(2048));
  const unchanged = tree(damaged.root), { open } = opener(damaged.file);
  const { result, prompts } = run(damaged.root, open);
  await assert.rejects(result, /not a database/); assert.equal(prompts.length, 0);
  assert.deepEqual(tree(damaged.root), unchanged);
});

test('damage found by the requested check offers restore or opening anyway; opening keeps the request for the next start', async t => {
  const f = await fixture(t, { damage: 'pages' }), { open, calls } = opener(f.file);
  requestIntegrityCheck(f.root);
  const { result, prompts } = run(f.root, open, [1]);
  const opened = await result; assert.ok('store' in opened && !opened.restored); opened.store.close();
  assert.deepEqual(prompts[0].actions, ['restore', 'open', 'quit']); assert.equal(calls(), 1, 'nothing opened the file before the user chose');
  assert.ok(existsSync(join(f.root, INTEGRITY_CHECK_REQUEST)));
});

test('a crash in the middle of the swap recovers to the damaged state, never to an empty database', async t => {
  const f = await fixture(t), crashed = join(f.root, '..', `${relative(join(f.root, '..'), f.root)}-crashed`); t.after(() => rmSync(crashed, { recursive: true, force: true }));
  // The damaged header is caught read-only, so the first open is the restored database, right after the swap and before
  // the commit: copy the disk state there.
  const { open } = opener(f.file, call => { if (call === 1) cpSync(f.root, crashed, { recursive: true }); });
  const { result } = run(f.root, open, [0]); const opened = await result; assert.ok('store' in opened); opened.store.close();
  assert.ok(existsSync(join(crashed, '.restore-journal.json')), 'the crash copy is mid-swap');
  await recoverInterruptedRestore(crashed);
  assert.equal(sha(readFileSync(join(crashed, 'practice.sqlite'))), sha(garbage)); assert.equal(sha(readFileSync(join(crashed, 'practice.sqlite-wal'))), sha(staleWal));
  assert.ok(!existsSync(join(crashed, '.restore-journal.json')));
});

test('if the restored database cannot open, everything is rolled back and the copy of the damaged files is removed', async t => {
  const f = await fixture(t), before = tree(f.root);
  const { open } = opener(f.file, call => { if (call === 1) throw new Error('restored file failed to open'); });
  const { result } = run(f.root, open, [0]);
  await assert.rejects(result, /restored file failed to open/);
  assert.deepEqual(tree(f.root), before);
});

test('damage that only the read-write open runs into is confirmed by the full check before a restore is offered', async t => {
  const f = await fixture(t, { damage: 'pages' }); let calls = 0;
  // The header probe passes; reading the damaged table during the startup steps fails with SQLITE_CORRUPT.
  const open = () => {
    calls++; const db = new DatabaseSync(f.file);
    try { db.prepare('SELECT value FROM items').get(); if (calls === 1) db.prepare('SELECT count(*), sum(length(v)) FROM filler').get(); return db; } catch (error) { db.close(); throw error; }
  };
  const { result, prompts } = run(f.root, open, [0]);
  const opened = await result; assert.ok('store' in opened); f.trackDatabase(opened.store);
  assert.equal(calls, 2, 'the failed open, then the restored file');
  assert.deepEqual(prompts[0].actions, ['restore', 'quit']);
  assert.equal(opened.store.prepare('SELECT value FROM items').get()!.value, 'v2');
});

test('end to end with the real store: a damaged practice.sqlite comes back from a real automatic backup with its notes and attachments', async t => {
  const root = mkdtempSync(join(tmpdir(), 'db-recovery-real-')), file = join(root, 'practice.sqlite');
  let store = new PracticeStore(file); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const attachments = new AttachmentService({ directory: join(root, 'attachments'), getAttachment: hash => store.getAttachment(hash), registerAttachment: attachment => store.registerAttachment(attachment) });
  const input = join(root, 'invariant.md'); writeFileSync(input, '# 边界\n恢复后附件仍可读取。'); const attachment = await attachments.addFile(input);
  const note = store.saveNote({ requestId: randomUUID(), kind: 'topic', subjectId: 'binary-search', title: '边界', markdown: '备份里的笔记', attachmentHashes: [attachment.hash] });
  const versions = store.listNoteVersions(note.id);
  const lifecycle: RestoreLifecycle = { hasActiveInterview: () => false, enterMaintenance: async () => {}, closeDatabase: () => {}, openDatabase: () => {}, clearCredentials: async () => {}, leaveMaintenance: () => {} };
  const service = new BackupService({ dataDirectory: root, appVersion: '0.91.0', now: () => new Date('2026-11-12T08:00:00Z'), snapshotDatabase: path => store.backupTo(path),
    inspectSnapshot: path => PracticeStore.inspectBackupSnapshot(path), getReminderSettings: () => ({ ...DEFAULT_REMINDER_SETTINGS }), lifecycle });
  assert.ok(await service.autoBackup('Asia/Shanghai'));
  store.close(); writeFileSync(file, garbage);
  const prompts: DamagedDatabasePrompt[] = [];
  const opened = await openWithRecovery({ dataDirectory: root, appVersion: '0.91.0', inspectSnapshot: path => PracticeStore.inspectBackupSnapshot(path), open: () => new PracticeStore(file),
    close: candidate => candidate.close(), now: () => NOW, log: () => {}, ask: async prompt => { prompts.push(prompt); return 0; } });
  assert.ok('store' in opened); store = opened.store;
  assert.deepEqual(prompts[0].actions, ['restore', 'quit']); assert.match(prompts[0].detail, /自动备份/);
  assert.deepEqual(store.listNoteVersions(note.id), versions);
  assert.equal((await attachments.read(attachment.hash)).bytes.toString(), '# 边界\n恢复后附件仍可读取。');
  store.integrityCheck();
  assert.equal(sha(readFileSync(join(opened.restored!.keptDirectory, 'practice.sqlite'))), sha(garbage));
});
