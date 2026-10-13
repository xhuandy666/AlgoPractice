import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupRunDirectory } from '../../src/runner/index.ts';

const failure = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });
test('Windows run cleanup retries a transient image lock and removes only its exact directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ap-cleanup-')), owned = path.join(root, 'owned'), adjacent = path.join(root, 'other-run');
  try {
    await mkdir(owned); await mkdir(adjacent); let attempts = 0;
    await cleanupRunDirectory(owned, 'win32', async () => { if (++attempts < 3) throw failure('EPERM'); await rm(owned, { recursive: true, force: true }); });
    assert.equal(attempts, 3);
    await assert.rejects(stat(owned), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.equal((await stat(adjacent)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Windows run cleanup preserves a persistent lock failure after a bounded retry window', async () => {
  const error = failure('EPERM'); let attempts = 0; const started = performance.now();
  await assert.rejects(cleanupRunDirectory('/synthetic/owned-run', 'win32', async () => { attempts++; throw error; }), candidate => candidate === error);
  assert.equal(attempts, 5);
  assert.ok(performance.now() - started < 1500, 'A persistent lock must not create an unbounded cleanup wait');
});
test('run cleanup does not retry non-lock failures or change POSIX removal semantics', async () => {
  for (const [platform, code] of [['win32', 'EIO'], ['darwin', 'EPERM']] as const) {
    const error = failure(code); let attempts = 0;
    await assert.rejects(cleanupRunDirectory('/synthetic/owned-run', platform, async () => { attempts++; throw error; }), candidate => candidate === error);
    assert.equal(attempts, 1);
  }
});
