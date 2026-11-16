import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { spawnInstaller, verifyNativeUpdateCache, waitForInstallerLaunch, waitForMacInstall, type NativeUpdateCache, type InstallerLaunchControl, type MacInstallControl } from '../../src/desktop/update-native.ts';

async function cacheFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'tilian-native-update-')), file = join(root, 'update-package');
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('authored native update cache\n'.repeat(5000));
  await writeFile(file, bytes);
  let cleared = 0;
  const cache: NativeUpdateCache = { file, downloadedFileInfo: { sha512: createHash('sha512').update(bytes).digest('base64') },
    clear: async () => { cleared++; await rm(file, { force: true }); } };
  return { root, file, bytes, cache, cleared: () => cleared };
}
function nsisControl(start: (events: EventEmitter) => boolean) {
  const events = new EventEmitter(); let resets = 0;
  const control: InstallerLaunchControl = {
    onError: callback => { events.on('failure', callback); return () => { events.removeListener('failure', callback); }; },
    onLaunched: callback => { events.on('launched', callback); return () => { events.removeListener('launched', callback); }; },
    start: () => start(events), reset: () => { resets++; },
  };
  return { events, control, resets: () => resets };
}
function macControl(check: (events: EventEmitter) => void = () => {}) {
  const events = new EventEmitter(); let quits = 0;
  const control: MacInstallControl = {
    onError: callback => { events.on('failure', callback); return () => { events.removeListener('failure', callback); }; },
    onDownloaded: callback => { events.on('downloaded', callback); return () => { events.removeListener('downloaded', callback); }; },
    onBeforeQuit: callback => { events.on('before-quit', callback); return () => { events.removeListener('before-quit', callback); }; },
    check: () => check(events), quitAndInstall: () => { quits++; },
  };
  return { events, control, quits: () => quits };
}
const noListeners = (events: EventEmitter) => assert.deepEqual(events.eventNames(), []);

test('native cached bytes are re-read and same-size damage invalidates the cache before installation', async t => {
  const f = await cacheFixture(t);
  await verifyNativeUpdateCache(f.cache); assert.equal(f.cleared(), 0);
  const changed = Buffer.from(f.bytes); changed[70_000] ^= 0xff; await writeFile(f.file, changed);
  await assert.rejects(verifyNativeUpdateCache(f.cache), { code: 'UPDATE_CACHE_INVALID' });
  assert.equal(f.cleared(), 1);
});

test('missing native files and invalid metadata clear the updater cache and require a download', async t => {
  const f = await cacheFixture(t); await rm(f.file);
  await assert.rejects(verifyNativeUpdateCache(f.cache), { code: 'UPDATE_CACHE_INVALID' }); assert.equal(f.cleared(), 1);
  await assert.rejects(verifyNativeUpdateCache({ ...f.cache, downloadedFileInfo: { sha512: '' } }), { code: 'UPDATE_CACHE_INVALID' });
  assert.equal(f.cleared(), 2);
  await assert.rejects(verifyNativeUpdateCache(null), { code: 'UPDATE_CACHE_INVALID' });
});

test('a native update symlink is rejected instead of verifying bytes at a substitute path', { skip: process.platform === 'win32' }, async t => {
  const f = await cacheFixture(t), original = join(f.root, 'original');
  await writeFile(original, f.bytes); await rm(f.file); await symlink(original, f.file);
  await assert.rejects(verifyNativeUpdateCache(f.cache), { code: 'UPDATE_CACHE_INVALID' }); assert.equal(f.cleared(), 1);
});

test('NSIS synchronous error events or rejected starts fail rather than leaving the app installing', async () => {
  for (const start of [(events: EventEmitter) => { events.emit('failure'); return false; }, () => false, () => { throw new Error('authored synchronous launch failure'); }]) {
    const f = nsisControl(start);
    await assert.rejects(waitForInstallerLaunch(f.control), /启动|准备/);
    assert.equal(f.resets(), 1); noListeners(f.events);
  }
});

test('NSIS asynchronous launch failure is acknowledged, clears listeners and permits a retry', async () => {
  let fail = true;
  const f = nsisControl(events => { setImmediate(() => events.emit(fail ? 'failure' : 'launched')); return true; });
  await assert.rejects(waitForInstallerLaunch(f.control), /启动/); assert.equal(f.resets(), 1); noListeners(f.events);
  fail = false; await waitForInstallerLaunch(f.control); assert.equal(f.resets(), 1); noListeners(f.events);
});

test('a launch timeout cannot be completed by a late event and leaves NSIS retryable', async () => {
  const f = nsisControl(() => true);
  await assert.rejects(waitForInstallerLaunch(f.control, 25), /超时/);
  assert.equal(f.resets(), 1); noListeners(f.events);
  f.events.emit('launched'); noListeners(f.events);
});

test('installer launching uses the real spawn event and rejects a missing executable asynchronously', async t => {
  const f = await cacheFixture(t); let started = 0;
  await assert.rejects(spawnInstaller(join(f.root, 'missing-executable'), [], { stdio: 'ignore' }, () => { started++; }), { code: 'ENOENT' });
  assert.equal(started, 0);
  assert.equal(await spawnInstaller(process.execPath, ['--version'], { stdio: 'ignore' }, () => { started++; }), true);
  assert.equal(started, 1);
});

test('a failed direct launch can fall back to a successfully spawned elevation process before acknowledgment', async t => {
  const f = await cacheFixture(t), n = nsisControl(events => {
    void spawnInstaller(join(f.root, 'missing-installer'), [], { stdio: 'ignore' }, () => { events.emit('launched'); })
      .catch(() => spawnInstaller(process.execPath, ['--version'], { stdio: 'ignore' }, () => { events.emit('launched'); }))
      .catch(() => { events.emit('failure'); });
    return true;
  });
  await waitForInstallerLaunch(n.control); assert.equal(n.resets(), 0); noListeners(n.events);
});

test('cancelling a pending spawn prevents a late launch acknowledgment', async () => {
  const controller = new AbortController(); let started = 0;
  const task = spawnInstaller(process.execPath, ['--version'], { stdio: 'ignore' }, () => { started++; }, controller.signal);
  const rejected = assert.rejects(task, /abort/i); controller.abort(); await rejected;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(started, 0);
});

test('Mac synchronous native errors reject and do not request a quit', async () => {
  for (const check of [(events: EventEmitter) => { events.emit('failure'); }, () => { throw new Error('authored native failure'); }]) {
    const f = macControl(check);
    await assert.rejects(waitForMacInstall(f.control), /系统/); assert.equal(f.quits(), 0); noListeners(f.events);
  }
});

test('Mac waits for Squirrel verification and before-quit acknowledgment without registering an irrevocable autoquit', async () => {
  const f = macControl(); let settled = false;
  const task = waitForMacInstall(f.control).then(() => { settled = true; });
  f.events.emit('before-quit'); assert.equal(f.quits(), 0);
  f.events.emit('downloaded'); assert.equal(f.quits(), 1);
  await Promise.resolve(); assert.equal(settled, false);
  f.events.emit('before-quit'); await task; assert.equal(settled, true); noListeners(f.events);
});

test('Mac timeout removes the downloaded listener, so a late verification cannot quit the working app', async () => {
  const f = macControl();
  await assert.rejects(waitForMacInstall(f.control, 25), /超时/); noListeners(f.events);
  f.events.emit('downloaded'); f.events.emit('before-quit'); assert.equal(f.quits(), 0);
});

test('Mac missing quit acknowledgment and native verification failures both return a retryable failure', async () => {
  const f = macControl(events => { events.emit('downloaded'); });
  await assert.rejects(waitForMacInstall(f.control, 25), /超时/); assert.equal(f.quits(), 1); noListeners(f.events);
  f.events.emit('downloaded'); assert.equal(f.quits(), 1);
  const failed = macControl(); const task = waitForMacInstall(failed.control);
  failed.events.emit('failure'); await assert.rejects(task, /验证或安装/); assert.equal(failed.quits(), 0); noListeners(failed.events);
});
