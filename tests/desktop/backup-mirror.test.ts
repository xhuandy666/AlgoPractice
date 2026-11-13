import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BackupMirror, mirrorName, validateMirrorDirectory, type MirrorSetting } from '../../src/desktop/backup-mirror.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'tilian-mirror-')), data = join(root, 'data'), local = join(data, 'backups'), folder = join(root, 'cloud');
  await mkdir(local, { recursive: true }); await mkdir(folder);
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = new Date('2026-11-12T10:00:00.000Z'), setting: MirrorSetting | null = { directory: folder, installId: 'a1b2c3d4' };
  const backups: { path: string; id: string; modified: Date }[] = [];
  const addLocal = async (n: number, at: string, body = `backup ${n}`) => {
    const path = join(local, `automatic-${id(n)}.algobak`); await writeFile(path, body); const modified = new Date(at); await utimes(path, modified, modified);
    backups.push({ path, id: id(n), modified });
  };
  const mirror = new BackupMirror({ setting: () => setting, localBackups: async () => [...backups], now: () => clock });
  return { root, data, local, folder, mirror, addLocal, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, set: (next: MirrorSetting | null) => { setting = next; } };
}

test('the newest automatic backup is copied once under an installation-specific name', async t => {
  const f = await fixture(t);
  await f.addLocal(1, '2026-11-10T08:00:00'); await f.addLocal(2, '2026-11-11T08:00:00', 'newest backup');
  const status = await f.mirror.reconcile();
  const expected = mirrorName('a1b2c3d4', id(2), new Date('2026-11-11T08:00:00'));
  assert.deepEqual(await readdir(f.folder), [expected]);
  assert.equal(await readFile(join(f.folder, expected), 'utf8'), 'newest backup');
  assert.deepEqual([status.lastCopy, status.lastError, status.busy, status.directory], [expected, null, false, f.folder]);
  const before = (await stat(join(f.folder, expected))).mtimeMs;
  await f.mirror.reconcile();
  assert.equal((await stat(join(f.folder, expected))).mtimeMs, before, 'a second run is a no-op');
  assert.deepEqual((await readdir(f.local)).sort(), [`automatic-${id(1)}.algobak`, `automatic-${id(2)}.algobak`], 'local backups are never touched');
});

test('only this installation\'s older copies are pruned, and its leftovers cleaned', async t => {
  const f = await fixture(t);
  const foreign = [mirrorName('ffffffff', id(90), new Date('2020-01-01T00:00:00')), 'notes.txt', '.题炼-备份-ffffffff-0123456789abcdef.partial', `automatic-${id(91)}.algobak`];
  for (const name of foreign) await writeFile(join(f.folder, name), 'other');
  for (let day = 1; day <= 9; day++) { await f.addLocal(day, `2026-11-0${day}T08:00:00`); await f.mirror.reconcile(true); }
  await writeFile(join(f.folder, '.题炼-备份-a1b2c3d4-0123456789abcdef.partial'), 'interrupted');
  await f.addLocal(10, '2026-11-10T08:00:00'); await f.mirror.reconcile(true);
  const names = await readdir(f.folder), own = names.filter(name => name.startsWith('题炼-备份-a1b2c3d4-')).sort();
  const expected = [4, 5, 6, 7, 8, 9, 10].map(day => mirrorName('a1b2c3d4', id(day), new Date(`2026-11-${String(day).padStart(2, '0')}T08:00:00`))).sort();
  assert.deepEqual(own, expected, 'keeps the newest seven copies of this installation');
  for (const name of foreign) assert.ok(names.includes(name), `${name} belongs to someone else and survives`);
  assert.equal(names.includes('.题炼-备份-a1b2c3d4-0123456789abcdef.partial'), false, 'an interrupted copy of this installation is removed');
});

test('a missing folder is reported without touching local backups, backs off, and catches up when it returns', async t => {
  const f = await fixture(t);
  await f.addLocal(1, '2026-11-11T08:00:00');
  await rm(f.folder, { recursive: true });
  const failed = await f.mirror.reconcile();
  assert.match(failed.lastError ?? '', /找不到副本文件夹/); assert.equal(failed.lastCopy, null);
  assert.deepEqual(await readdir(f.local), [`automatic-${id(1)}.algobak`]);
  await mkdir(f.folder);
  assert.equal((await f.mirror.reconcile()).lastError, failed.lastError, 'retries wait for the backoff');
  f.advance(61_000);
  const recovered = await f.mirror.reconcile();
  assert.equal(recovered.lastError, null); assert.equal((await readdir(f.folder)).length, 1, 'catches up once the folder is back');
  await rm(f.folder, { recursive: true }); await writeFile(f.folder, 'a file now');
  assert.match((await f.mirror.reconcile(true)).lastError ?? '', /不是文件夹/, 'a file in place of the folder is reported as such');
});

test('no folder means no work and no status', async t => {
  const f = await fixture(t);
  await f.addLocal(1, '2026-11-11T08:00:00'); f.set(null);
  assert.deepEqual(await f.mirror.reconcile(), { directory: null, busy: false, lastCopy: null, lastCopiedAt: null, lastError: null });
  f.set({ directory: f.folder, installId: 'NOT-HEX!' });
  assert.equal((await f.mirror.reconcile()).lastCopy, null, 'a malformed installation id never matches files');
  assert.deepEqual(await readdir(f.folder), []);
});

test('a copy folder must exist, be writable and live outside the data directory', async t => {
  const f = await fixture(t);
  assert.equal(await validateMirrorDirectory(f.folder, f.data), f.folder);
  assert.deepEqual(await readdir(f.folder), [], 'the write probe cleans up after itself');
  await assert.rejects(validateMirrorDirectory('relative/folder', f.data), /完整路径/);
  await assert.rejects(validateMirrorDirectory(join(f.root, 'missing'), f.data), /找不到/);
  await writeFile(join(f.root, 'plain-file'), 'x');
  await assert.rejects(validateMirrorDirectory(join(f.root, 'plain-file'), f.data), /不是文件夹/);
  await assert.rejects(validateMirrorDirectory(f.data, f.data), /数据目录/);
  await mkdir(join(f.data, '..sneaky'));
  await assert.rejects(validateMirrorDirectory(join(f.data, '..sneaky'), f.data), /数据目录/, 'a folder named "..x" inside the data directory is still inside');
  await symlink(f.local, join(f.root, 'link-into-data'));
  await assert.rejects(validateMirrorDirectory(join(f.root, 'link-into-data'), f.data), /数据目录/, 'links are resolved first');
});
