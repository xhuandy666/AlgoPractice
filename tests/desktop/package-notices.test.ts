import assert from 'node:assert/strict';
import { cp, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
// @ts-expect-error Standalone packaging tools are deliberately plain Node.js.
import { supplementalPackageNotices } from '../../scripts/package-notices.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const metadata = JSON.parse(await readFile(join(root, 'node_modules/lazy-val/package.json'), 'utf8'));

test('the exact lazy-val release retains its original upstream MIT declaration and attributed SPDX terms', async () => {
  const notices: Array<{ source: string; file: string }> = await supplementalPackageNotices(root, metadata);
  assert.deepEqual(notices.map(notice => notice.file).sort(), ['MIT.txt', 'NOTICE.md', 'provenance.json', 'upstream-package.json']);
  const upstream = JSON.parse(await readFile(notices.find(notice => notice.file === 'upstream-package.json')!.source, 'utf8'));
  assert.equal(upstream.version, '1.0.5'); assert.equal(upstream.author, 'Vladimir Krivosheev'); assert.equal(upstream.license, 'MIT');
  assert.equal((await supplementalPackageNotices(root, { ...metadata, version: '1.0.6' })).length, 0, 'a new version must obtain its own reviewed notices');
  assert.equal((await supplementalPackageNotices(root, { ...metadata, name: 'unreviewed-package' })).length, 0);
  await assert.rejects(supplementalPackageNotices(root, { ...metadata, license: 'unverified' }), /does not match/);
});

test('tampered supplemental terms and a changed package archive cannot pass the notice gate', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'algopractice-notice-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const relative = 'build/third-party-notices/lazy-val-1.0.5';
  await cp(join(root, relative), join(fixture, relative), { recursive: true });
  await copyFile(join(root, 'package-lock.json'), join(fixture, 'package-lock.json'));
  await writeFile(join(fixture, relative, 'MIT.txt'), 'changed terms');
  await assert.rejects(supplementalPackageNotices(fixture, metadata), /hash changed/);
  await copyFile(join(root, relative, 'MIT.txt'), join(fixture, relative, 'MIT.txt'));
  const lock = JSON.parse(await readFile(join(fixture, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/lazy-val'].integrity = 'sha512-different';
  await writeFile(join(fixture, 'package-lock.json'), JSON.stringify(lock));
  await assert.rejects(supplementalPackageNotices(fixture, metadata), /integrity changed/);
});
