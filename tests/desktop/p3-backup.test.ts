import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { AttachmentService, contentHash } from '../../src/desktop/attachment-service';
import { BackupService, recoverInterruptedRestore } from '../../src/desktop/backup-service';
import { DEFAULT_REMINDER_SETTINGS, REMINDER_SETTINGS_FILE, type BackupManifest, type BackupSnapshot, type BackupServiceOptions } from '../../src/shared/maintenance';
import type { Attachment } from '../../src/shared/learning';
const learning = { dailyReviewBudget: 3, timeZone: 'Asia/Shanghai', updatedAt: '2026-09-08T00:00:00.000Z' };
function inspectSnapshot(path: string): BackupSnapshot {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']);
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version); if (version !== 3) throw new Error('unsupported schema');
    const attachments = db.prepare('SELECT DISTINCT a.metadata FROM attachments a JOIN note_versions n ON n.hash=a.hash ORDER BY a.hash').all().map(row => JSON.parse(String(row.metadata)) as Attachment);
    return { schemaVersion: version, attachments, mediaHashes: db.prepare('SELECT DISTINCT hash FROM media_versions ORDER BY hash').all().map(row => String(row.hash)), learningSettings: JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key='learning'").get()!.value)) };
  } finally { db.close(); }
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'p3-backup-')); let database: DatabaseSync | undefined = new DatabaseSync(join(root, 'practice.sqlite'));
  database.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=3; CREATE TABLE items(value TEXT); CREATE TABLE attachments(hash TEXT PRIMARY KEY,metadata TEXT); CREATE TABLE note_versions(id TEXT,hash TEXT); CREATE TABLE media_versions(hash TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');
  database.prepare('INSERT INTO items VALUES (?)').run('original'); database.prepare('INSERT INTO settings VALUES (?,?)').run('learning', JSON.stringify(learning));
  const events: string[] = []; let now = new Date('2026-09-08T12:00:00Z'), activeInterview = false, failOpen = false, failCredentials = false, maintenance = false;
  const options: BackupServiceOptions = { dataDirectory: root, appVersion: '0.3.0', now: () => now,
    snapshotDatabase: path => sqliteBackup(database!, path), inspectSnapshot, getReminderSettings: () => ({ ...DEFAULT_REMINDER_SETTINGS }),
    lifecycle: { hasActiveInterview: () => activeInterview, enterMaintenance: async () => { events.push('enter'); maintenance = true; },
      closeDatabase: () => { events.push('close'); database?.close(); database = undefined; },
      openDatabase: () => { events.push('open'); if (failOpen) { failOpen = false; throw new Error('reopen failed'); } database = new DatabaseSync(join(root, 'practice.sqlite')); assert.deepEqual(database.prepare('PRAGMA quick_check').all().map(row => row.quick_check), ['ok']); },
      clearCredentials: async () => { events.push('credentials'); if (failCredentials) throw new Error('credential clear failed'); await rm(join(root, 'private-key.json'), { force: true }); },
      leaveMaintenance: restored => { events.push(`leave:${restored}`); maintenance = false; },
    } };
  const service = new BackupService(options);
  const attachments = new AttachmentService({ directory: join(root, 'attachments'), getAttachment: hash => { const row = database!.prepare('SELECT metadata FROM attachments WHERE hash=?').get(hash); return row ? JSON.parse(String(row.metadata)) : undefined; },
    registerAttachment: attachment => { database!.prepare('INSERT INTO attachments VALUES (?,?)').run(attachment.hash, JSON.stringify(attachment)); return attachment; } });
  t.after(async () => { database?.close(); await rm(root, { recursive: true, force: true }); });
  return { root, options, service, attachments, events, db: () => database!, setDay: (value: string) => { now = new Date(value); }, setInterview: (value: boolean) => { activeInterview = value; }, failOpen: () => { failOpen = true; }, failCredentials: () => { failCredentials = true; }, maintenance: () => maintenance };
}
async function addAttachment(f: Awaited<ReturnType<typeof fixture>>, text: string, referenced = true) {
  const path = join(f.root, `${randomUUID()}.md`); await writeFile(path, text); const attachment = await f.attachments.addFile(path);
  if (referenced) f.db().prepare('INSERT INTO note_versions VALUES (?,?)').run(randomUUID(), attachment.hash); return attachment;
}
function unpack(bytes: Buffer) {
  const entries: { name: string; bytes: Buffer }[] = []; let offset = 0;
  while (offset < bytes.length && bytes[offset]) {
    const name = bytes.toString('ascii', offset, offset + 100).replace(/\0.*$/, ''), size = parseInt(bytes.toString('ascii', offset + 124, offset + 136), 8);
    entries.push({ name, bytes: Buffer.from(bytes.subarray(offset + 512, offset + 512 + size)) }); offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
function pack(entries: { name: string; bytes: Buffer; type?: string }[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512); header.write(entry.name, 0, 100); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(entry.bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = (entry.type ?? '0').charCodeAt(0); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
async function transformed(f: Awaited<ReturnType<typeof fixture>>, source: string, change: (entries: ReturnType<typeof unpack>) => void, updateHashes = false) {
  const entries = unpack(await readFile(source)); change(entries);
  if (updateHashes) {
    const manifest = JSON.parse(entries[0].bytes.toString()) as BackupManifest;
    manifest.files = entries.slice(1).map(entry => ({ path: entry.name, size: entry.bytes.length, sha256: contentHash(entry.bytes) })); manifest.dataFingerprint = contentHash(Buffer.from(JSON.stringify(manifest.files)));
    entries[0].bytes = Buffer.from(JSON.stringify(manifest));
  }
  const file = join(f.root, `${randomUUID()}.algobak`); await writeFile(file, pack(entries)); return file;
}
test('complete backup uses an online SQLite snapshot and only its historical references, excluding credentials', async t => {
  const f = await fixture(t); const old = await addAttachment(f, 'previous note version'), orphan = await addAttachment(f, 'unreferenced file', false);
  const image = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]), imageHash = contentHash(image); await mkdir(join(f.root, 'media')); await writeFile(join(f.root, 'media', imageHash), image); f.db().prepare('INSERT INTO media_versions VALUES (?)').run(imageHash);
  await writeFile(join(f.root, 'private-key.json'), 'SECRET-DO-NOT-BACKUP');
  const ordinarySnapshot = f.options.snapshotDatabase;
  f.options.snapshotDatabase = async path => { await ordinarySnapshot(path); f.db().prepare('DELETE FROM note_versions').run(); f.db().prepare('INSERT INTO note_versions VALUES (?,?)').run(randomUUID(), orphan.hash); };
  const backup = await f.service.create(), names = backup.manifest.files.map(file => file.path);
  assert.ok(names.includes(`attachments/${old.hash}`)); assert.ok(!names.includes(`attachments/${orphan.hash}`)); assert.ok(names.includes(`media/${imageHash}`));
  assert.ok(!(await readFile(backup.path)).includes(Buffer.from('SECRET-DO-NOT-BACKUP')));
  assert.deepEqual((await f.service.inspect(backup.path)).manifest, backup.manifest); assert.equal(f.events.length, 0);
});
test('restore replaces the closed database, referenced attachments and media, makes a pre-backup and clears credentials', async t => {
  const f = await fixture(t), attachment = await addAttachment(f, 'restore this note'); const backup = await f.service.create();
  f.db().prepare('UPDATE items SET value=?').run('after backup'); const extra = await addAttachment(f, 'after backup attachment'); await writeFile(join(f.root, 'private-key.json'), 'secret');
  const result = await f.service.restore(backup.path, backup.manifest);
  assert.equal(f.db().prepare('SELECT value FROM items').get()!.value, 'original'); assert.equal((await f.attachments.read(attachment.hash)).bytes.toString(), 'restore this note');
  await assert.rejects(f.attachments.read(extra.hash)); await assert.rejects(stat(join(f.root, 'private-key.json')));
  assert.equal(result.preRestoreBackup.manifest.kind, 'before-restore'); assert.ok(result.preRestoreBackup.manifest.files.some(file => file.path === `attachments/${extra.hash}`));
  assert.deepEqual(f.events, ['enter', 'close', 'open', 'credentials', 'leave:true']); assert.equal(f.maintenance(), false);
  assert.deepEqual(JSON.parse((await readFile(join(f.root, REMINDER_SETTINGS_FILE))).toString()), DEFAULT_REMINDER_SETTINGS);
  await f.service.restore(result.preRestoreBackup.path, result.preRestoreBackup.manifest); assert.equal(f.db().prepare('SELECT value FROM items').get()!.value, 'after backup');
});
test('valid restore into a fresh independent data directory retains notes and DB values', async t => {
  const source = await fixture(t), attachment = await addAttachment(source, 'portable history'), backup = await source.service.create();
  const target = await fixture(t); target.db().prepare('DELETE FROM items').run(); await target.service.restore(backup.path, backup.manifest);
  assert.equal(target.db().prepare('SELECT value FROM items').get()!.value, 'original'); assert.equal((await target.attachments.read(attachment.hash)).bytes.toString(), 'portable history');
});
test('tampered, truncated, missing-reference and internally corrupt SQLite packages leave healthy data untouched', async t => {
  const f = await fixture(t); await addAttachment(f, 'necessary historical attachment'); const backup = await f.service.create();
  const damaged = await transformed(f, backup.path, entries => { entries.find(entry => entry.name === 'database.sqlite')!.bytes[0] ^= 255; });
  const corruptDatabase = await transformed(f, backup.path, entries => { entries.find(entry => entry.name === 'database.sqlite')!.bytes.fill(65); }, true);
  const missingReference = await transformed(f, backup.path, entries => { entries.splice(entries.findIndex(entry => entry.name.startsWith('attachments/')), 1); }, true);
  const truncated = join(f.root, 'truncated.algobak'); const bytes = await readFile(backup.path); await writeFile(truncated, bytes.subarray(0, bytes.length - 1));
  for (const file of [damaged, corruptDatabase, missingReference, truncated]) { await assert.rejects(f.service.restore(file)); assert.equal(f.db().prepare('SELECT value FROM items').get()!.value, 'original'); }
  assert.deepEqual(f.events, []); assert.equal((await readdir(f.root)).filter(name => name.startsWith('.verify-')).length, 0);
});
test('path traversal, symlink/hardlink TAR entries, duplicate entries and oversized headers are rejected before maintenance', async t => {
  const f = await fixture(t), backup = await f.service.create();
  for (const path of ['../outside', '/tmp/outside', 'attachments/../../outside', 'settings.json/evil']) {
    const file = await transformed(f, backup.path, entries => { entries[1].name = path; }); await assert.rejects(f.service.restore(file));
  }
  for (const type of ['1', '2', 'x', '5']) { const entries = unpack(await readFile(backup.path)); const file = join(f.root, `${type}.algobak`); await writeFile(file, pack(entries.map((entry, index) => ({ ...entry, type: index === 1 ? type : '0' })))); await assert.rejects(f.service.restore(file)); }
  const duplicate = await transformed(f, backup.path, entries => { entries.push(entries[1]); }); await assert.rejects(f.service.restore(duplicate));
  const oversized = await readFile(backup.path), firstData = 512 + Math.ceil(unpack(oversized)[0].bytes.length / 512) * 512;
  oversized.write('77777777777\0', firstData + 124); oversized.fill(32, firstData + 148, firstData + 156);
  oversized.write(oversized.subarray(firstData, firstData + 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', firstData + 148);
  const largeFile = join(f.root, 'too-large.algobak'); await writeFile(largeFile, oversized); await assert.rejects(f.service.restore(largeFile)); assert.deepEqual(f.events, []);
});
test('backup preview identity and active interview are checked before entering maintenance', async t => {
  const f = await fixture(t), backup = await f.service.create();
  await assert.rejects(f.service.restore(backup.path, { id: randomUUID(), dataFingerprint: backup.manifest.dataFingerprint }), /预览后已变化/);
  await assert.rejects(f.service.restore(backup.path, { id: backup.manifest.id, dataFingerprint: '0'.repeat(64) }), /预览后已变化/);
  f.setInterview(true); await assert.rejects(f.service.restore(backup.path), /活动面试/); assert.deepEqual(f.events, []);
});
test('reopen or credential-clear failure rolls every managed path back before unlocking', async t => {
  for (const phase of ['open', 'credentials']) {
    const f = await fixture(t), backup = await f.service.create(); f.db().prepare('UPDATE items SET value=?').run('healthy latest'); const attachment = await addAttachment(f, 'latest note');
    if (phase === 'open') f.failOpen(); else f.failCredentials();
    await assert.rejects(f.service.restore(backup.path), phase === 'open' ? /reopen failed/ : /credential clear failed/);
    assert.equal(f.db().prepare('SELECT value FROM items').get()!.value, 'healthy latest'); assert.equal((await f.attachments.read(attachment.hash)).bytes.toString(), 'latest note');
    assert.equal(f.events.at(-1), 'leave:false'); assert.equal(f.maintenance(), false); assert.equal(f.service.status().busy, false);
    assert.equal((await readdir(f.root)).filter(name => name === '.restore-journal.json' || name.startsWith('.restore-')).length, 0);
  }
});
test('startup journal recovery rolls back an interrupted multi-path switch before opening SQLite', async t => {
  const f = await fixture(t); await f.options.lifecycle.closeDatabase(); const id = randomUUID(), operation = join(f.root, `.restore-${id}`); await mkdir(join(operation, 'original'), { recursive: true }); await mkdir(join(operation, 'prepared'));
  const names = ['practice.sqlite', 'practice.sqlite-wal', 'practice.sqlite-shm', 'attachments', 'media', REMINDER_SETTINGS_FILE];
  const entries = await Promise.all(names.map(async name => ({ name, hadOriginal: await stat(join(f.root, name)).then(() => true, () => false) })));
  await writeFile(join(f.root, '.restore-journal.json'), JSON.stringify({ version: 1, id, phase: 'swapping', entries }));
  await rename(join(f.root, 'practice.sqlite'), join(operation, 'original', 'practice.sqlite')); await writeFile(join(f.root, 'practice.sqlite'), 'partial new database');
  assert.deepEqual(await recoverInterruptedRestore(f.root), { recovered: true, outcome: 'rolled-back' });
  await f.options.lifecycle.openDatabase(); assert.equal(f.db().prepare('SELECT value FROM items').get()!.value, 'original'); assert.deepEqual(await recoverInterruptedRestore(f.root), { recovered: false });
});
test('automatic backups require changes, run at most once per local day, retain seven and never remove manual backups', async t => {
  const f = await fixture(t), manual = await f.service.create(); const first = await f.service.autoBackup('Asia/Shanghai'); assert.ok(first);
  f.db().prepare('UPDATE items SET value=?').run('changed same day'); assert.equal(await f.service.autoBackup('Asia/Shanghai'), null);
  for (let day = 9; day <= 16; day++) { f.setDay(`2026-09-${String(day).padStart(2, '0')}T12:00:00Z`); f.db().prepare('UPDATE items SET value=?').run(`day ${day}`); assert.ok(await f.service.autoBackup('Asia/Shanghai')); }
  const summaries = await f.service.list(); assert.equal(summaries.filter(row => row.manifest.kind === 'automatic').length, 7); assert.ok(summaries.some(row => row.path === manual.path));
  f.setDay('2026-09-17T12:00:00Z'); assert.equal(await f.service.autoBackup('Asia/Shanghai'), null); assert.ok(await stat(manual.path));
});
test('future SQLite versions and non-whitelisted settings are rejected even with correct package hashes', async t => {
  const f = await fixture(t), backup = await f.service.create();
  const badSettings = await transformed(f, backup.path, entries => { const settings = entries.find(entry => entry.name === 'settings.json')!; const value = JSON.parse(settings.bytes.toString()); value.apiKey = 'secret'; settings.bytes = Buffer.from(JSON.stringify(value)); }, true);
  await assert.rejects(f.service.restore(badSettings), /不允许的设置字段/);
  const future = await transformed(f, backup.path, entries => { const db = entries.find(entry => entry.name === 'database.sqlite')!; db.bytes.writeUInt32BE(99, 60); const manifest = JSON.parse(entries[0].bytes.toString()); manifest.databaseVersion = 99; entries[0].bytes = Buffer.from(JSON.stringify(manifest)); }, true);
  await assert.rejects(f.service.restore(future), /unsupported schema/); assert.deepEqual(f.events, []);
});
test('if even the rolled-back database cannot reopen, restore stays in maintenance instead of unlocking writes', async t => {
  const f = await fixture(t), backup = await f.service.create(); f.db().prepare('UPDATE items SET value=?').run('must survive');
  const reopen = f.options.lifecycle.openDatabase; f.options.lifecycle.openDatabase = () => { throw new Error('persistent reopen failure'); };
  await assert.rejects(f.service.restore(backup.path), /保持维护态/); assert.equal(f.maintenance(), true); assert.ok(!f.events.includes('leave:false'));
  f.options.lifecycle.openDatabase = reopen; await reopen(); assert.equal(f.db().prepare('SELECT value FROM items').get()!.value, 'must survive'); await f.options.lifecycle.leaveMaintenance(false);
});
test('real PracticeStore schema 3 notes, historical attachments and learning settings survive a full service restore', async t => {
  const { PracticeStore } = await import('../../src/storage/practice-store');
  const directory = await mkdtemp(join(tmpdir(), 'p3-real-store-')); let store = new PracticeStore(join(directory, 'practice.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const attachmentService = new AttachmentService({ directory: join(directory, 'attachments'), getAttachment: hash => store.getAttachment(hash), registerAttachment: attachment => store.registerAttachment(attachment) });
  const input = join(directory, 'invariant.md'); await writeFile(input, '# 保存不变量\n所有历史附件都应可恢复。'); const attachment = await attachmentService.addFile(input);
  const first = store.saveNote({ requestId: randomUUID(), kind: 'topic', subjectId: 'binary-search', title: '边界', markdown: '旧版本有附件', attachmentHashes: [attachment.hash] });
  store.saveNote({ requestId: randomUUID(), noteId: first.id, kind: 'topic', subjectId: 'binary-search', title: '边界', markdown: '新版本正文', attachmentHashes: [], expectedVersion: first.latestVersion });
  store.updateLearningSettings({ dailyReviewBudget: 7, dailyPracticeGoal: 9, timeZone: 'Asia/Shanghai' });
  const service = new BackupService({ dataDirectory: directory, appVersion: '0.3.0', snapshotDatabase: path => store.backupTo(path), inspectSnapshot: path => PracticeStore.inspectBackupSnapshot(path), getReminderSettings: () => ({ ...DEFAULT_REMINDER_SETTINGS }),
    lifecycle: { hasActiveInterview: () => false, enterMaintenance: async () => {}, closeDatabase: () => store.close(), openDatabase: () => { store = new PracticeStore(join(directory, 'practice.sqlite')); }, clearCredentials: async () => {}, leaveMaintenance: () => {} } });
  const backup = await service.create(); assert.ok(backup.manifest.files.some(file => file.path === `attachments/${attachment.hash}`));
  const before = store.listNoteVersions(first.id); store.deleteNote(first.id, 2); store.updateLearningSettings({ dailyReviewBudget: 1, dailyPracticeGoal: 2 });
  await service.restore(backup.path, backup.manifest);
  assert.deepEqual(store.listNoteVersions(first.id), before); assert.equal(store.getLearningSettings().dailyReviewBudget, 7); assert.equal(store.getLearningSettings().dailyPracticeGoal, 9);
  assert.equal((await attachmentService.read(attachment.hash)).bytes.toString(), '# 保存不变量\n所有历史附件都应可恢复。'); store.integrityCheck();
});
test('non-secret AI provider preferences restore atomically while key fields and credential-bearing URLs are refused', async t => {
  const f = await fixture(t);
  const provider = { id: 'test-provider', baseUrl: 'https://example.com/v1', model: 'model-a', temperature: 0.2, maxOutputTokens: 2048, timeoutMs: 60000, jsonMode: false, includeUsage: true };
  f.options.getAiProvider = () => provider; await writeFile(join(f.root, 'ai-provider.json'), JSON.stringify(provider));
  const backup = await f.service.create(); await writeFile(join(f.root, 'ai-provider.json'), JSON.stringify({ ...provider, model: 'model-b' }));
  await f.service.restore(backup.path, backup.manifest); assert.deepEqual(JSON.parse((await readFile(join(f.root, 'ai-provider.json'))).toString()), provider);
  for (const invalid of [{ ...provider, apiKey: 'must-never-restore' }, { ...provider, baseUrl: 'https://user:password@example.com/v1' }, { ...provider, baseUrl: 'https://example.com/v1?api_key=secret' }]) {
    const file = await transformed(f, backup.path, entries => { const settings = entries.find(entry => entry.name === 'settings.json')!; const value = JSON.parse(settings.bytes.toString()); value.aiProvider = invalid; settings.bytes = Buffer.from(JSON.stringify(value)); }, true);
    await assert.rejects(f.service.restore(file), /AI 配置无效/);
  }
  const oldFile = JSON.stringify({ ...provider, model: 'keep-on-failure' }); await writeFile(join(f.root, 'ai-provider.json'), oldFile); f.failOpen();
  await assert.rejects(f.service.restore(backup.path), /reopen failed/); assert.equal((await readFile(join(f.root, 'ai-provider.json'))).toString(), oldFile);
});

test('an intentionally zero daily review budget remains a valid portable setting', async t => {
  const f = await fixture(t); f.db().prepare("UPDATE settings SET value=? WHERE key='learning'").run(JSON.stringify({ ...learning, dailyReviewBudget: 0 }));
  const backup = await f.service.create(); await f.service.restore(backup.path, backup.manifest);
  assert.equal(JSON.parse(String(f.db().prepare("SELECT value FROM settings WHERE key='learning'").get()!.value)).dailyReviewBudget, 0);
});


test('legacy portable backups without a practice goal still verify and restore with original learning settings', async t => {
  const f = await fixture(t), backup = await f.service.create();
  const oldFile = await transformed(f, backup.path, entries => {
    const entry = entries.find(value => value.name === 'settings.json')!, settings = JSON.parse(entry.bytes.toString());
    delete settings.learning.dailyPracticeGoal; entry.bytes = Buffer.from(JSON.stringify(settings));
  }, true);
  await f.service.restore(oldFile);
  assert.deepEqual(JSON.parse(String(f.db().prepare("SELECT value FROM settings WHERE key='learning'").get()!.value)), learning);
});
