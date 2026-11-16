import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AppUpdateService, UPDATE_INTERVAL_MS, UPDATE_START_DELAY_MS, type AppUpdateOptions, type NativeUpdateEngine } from '../../src/desktop/app-update-service.ts';
import { RELEASES_API } from '../../src/desktop/update-check.ts';
import { downloadInstaller, releaseInstaller, type UpdateFetch } from '../../src/desktop/update-installer.ts';
import type { AppUpdateState } from '../../src/shared/update.ts';

const contents = Buffer.from('authored installer bytes\n'.repeat(5000));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const release = (version = '0.97.0', platform = 'mac', arch = 'arm64') => {
  const name = `AlgoPractice-${version}-${platform}-${arch}.${platform === 'mac' ? 'dmg' : 'exe'}`;
  return { tag_name: `v${version}`, html_url: `https://github.com/xhuandy666/AlgoPractice/releases/tag/v${version}`, draft: false, prerelease: false,
    published_at: '2026-11-17T00:00:00Z', assets: [{ name, size: contents.length, digest: `sha256:${sha(contents)}`,
      browser_download_url: `https://github.com/xhuandy666/AlgoPractice/releases/download/v${version}/${name}` }] };
};
async function fixture(t: TestContext, overrides: Partial<AppUpdateOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tilian-update-'));
  const requests: string[] = [], states: AppUpdateState[] = [], actions: string[] = [];
  const timers: { callback(): void; delay: number; cancelled: boolean }[] = [];
  let response = release(), payload: Uint8Array = contents, preferences = true;
  const fetch: UpdateFetch = async (url, options) => {
    requests.push(url); assert.equal(options.credentials, 'omit');
    if (url === RELEASES_API) return new Response(JSON.stringify(response));
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers, undefined, 'installer requests contain no credentials');
    return new Response(new Uint8Array(payload), { headers: { 'content-length': String(payload.length) } });
  };
  const options: AppUpdateOptions = { version: '0.96.0', platform: 'darwin', arch: 'arm64', mode: 'installer', directory, automatic: true, fetch,
    persistAutomatic: value => { preferences = value; }, changed: state => states.push(state),
    install: async action => { actions.push('flush'); await action(); actions.push('finished'); },
    openInstaller: async path => { assert.equal(sha(await readFile(path)), sha(contents)); actions.push('open'); },
    installationBlocker: () => null, schedule: (callback, delay) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; }, ...overrides };
  const service = new AppUpdateService(options);
  t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory, requests, states, actions, timers, options,
    payload: (bytes: Uint8Array) => { payload = bytes; }, release: (value: ReturnType<typeof release>) => { response = value; }, preference: () => preferences };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Update operation did not settle');
}

test('automatic startup check stages a validated installer once, never installs or restarts by itself', async t => {
  const f = await fixture(t); f.service.start(); f.service.start();
  assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, UPDATE_START_DELAY_MS); assert.deepEqual(f.requests, []);
  f.timers[0].callback(); await until(() => f.service.state().phase === 'downloaded');
  assert.equal(f.requests.length, 2); assert.deepEqual(f.actions, []);
  assert.equal(f.service.state().latestVersion, '0.97.0'); assert.equal(f.service.state().progress?.percent, 100);
  await until(() => f.timers.length === 2); assert.equal(f.timers[1].delay, UPDATE_INTERVAL_MS);
  assert.deepEqual(await readdir(f.directory), [release().assets[0].name]);
  assert.ok(!JSON.stringify(f.service.state()).includes(f.directory), 'local paths never cross IPC');
  await f.service.install(); assert.deepEqual(f.actions, ['flush', 'open', 'finished']);
});

test('source runs do not schedule or download, but an explicit check can report the latest version', async t => {
  const f = await fixture(t, { mode: 'development' }); f.service.start(); assert.equal(f.timers.length, 0);
  assert.equal(f.service.state().phase, 'disabled');
  const first = f.service.check(), second = f.service.check(); assert.equal(first, second);
  assert.equal((await first).phase, 'available'); assert.equal(f.requests.length, 1);
  await f.service.download(); await assert.rejects(f.service.install(), /先完成/);
  assert.deepEqual(f.actions, []);
});

test('automatic opt-out survives checks, manual download remains explicit, and turning it on schedules a check', async t => {
  const f = await fixture(t, { automatic: false }); f.service.start(); assert.equal(f.timers.length, 0);
  assert.equal((await f.service.check()).phase, 'available'); assert.equal(f.requests.length, 1);
  await f.service.download(); assert.equal(f.service.state().phase, 'downloaded'); assert.deepEqual(f.actions, []);
  f.service.setAutomatic(true); assert.equal(f.preference(), true); assert.equal(f.timers.at(-1)?.delay, UPDATE_START_DELAY_MS);
  f.service.setAutomatic(false); assert.equal(f.preference(), false); assert.equal(f.timers.at(-1)?.cancelled, true);
  assert.throws(() => f.service.setAutomatic('yes' as unknown as boolean), /设置无效/);
});

test('older, same-version and prerelease/draft updates never download or downgrade', async t => {
  for (const version of ['0.95.0', '0.96.0']) {
    const f = await fixture(t); f.release(release(version)); assert.equal((await f.service.check()).phase, 'up-to-date'); assert.equal(f.requests.length, 1);
  }
  for (const field of ['draft', 'prerelease'] as const) {
    const f = await fixture(t); f.release({ ...release(), [field]: true }); assert.equal((await f.service.check()).phase, 'error'); assert.equal(f.requests.length, 1);
  }
});

test('checksum failure leaves no published or partial file; retry repairs the download', async t => {
  const f = await fixture(t); const damaged = Buffer.from(contents); damaged[70_000] ^= 0xff; f.payload(damaged);
  assert.equal((await f.service.check()).phase, 'error'); assert.deepEqual(await readdir(f.directory), []);
  f.payload(contents); const first = f.service.download(), second = f.service.download(); assert.equal(first, second);
  assert.equal((await first).phase, 'downloaded'); assert.equal(f.requests.length, 3);
  assert.deepEqual(f.actions, []); assert.equal(sha(await readFile(join(f.directory, release().assets[0].name))), sha(contents));
});

test('a failed check for a different release cannot download the previous candidate under a new version label', async t => {
  const f = await fixture(t, { automatic: false }); await f.service.check();
  const invalid = release('0.98.0'); invalid.assets[0].digest = ''; f.release(invalid);
  const result = await f.service.check(); assert.equal(result.phase, 'error'); assert.equal(result.latestVersion, null);
  await f.service.download(); assert.equal(f.requests.length, 2); assert.deepEqual(await readdir(f.directory), []);
});

test('a tampered cached installer is rechecked before install and can be downloaded again', async t => {
  const f = await fixture(t); await f.service.check();
  await writeFile(join(f.directory, release().assets[0].name), Buffer.alloc(contents.length));
  await assert.rejects(f.service.install(), /重新下载/); assert.equal(f.service.state().phase, 'available'); assert.deepEqual(f.actions, []);
  await f.service.download(); assert.equal(f.service.state().phase, 'downloaded');
  await f.service.install(); assert.deepEqual(f.actions, ['flush', 'open', 'finished']);
});

test('a matching cached installer is reused only after its contents are verified', async t => {
  const f = await fixture(t); await f.service.check(); await f.service.stop();
  const next = new AppUpdateService(f.options); t.after(() => next.stop()); await next.check();
  assert.equal(next.state().phase, 'downloaded'); assert.equal(f.requests.length, 3, 'the second check reads metadata but does not redownload');
});

test('turning automatic updates off aborts an active download without leaving a stuck progress state', async t => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, { fetch: async (url, options) => {
    if (url === RELEASES_API) return new Response(JSON.stringify(release()));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      options.signal!.addEventListener('abort', () => controller.error(options.signal!.reason), { once: true }); started();
    } }));
  } });
  const task = f.service.check(); await ready; f.service.setAutomatic(false); await task;
  assert.equal(f.service.state().phase, 'available'); assert.equal(f.service.state().error, null); assert.deepEqual(await readdir(f.directory), []);
});

test('active work blocks installation; failed draft flush keeps the staged update available for retry', async t => {
  let busy = true, failedFlush = true;
  const f = await fixture(t, { installationBlocker: () => busy ? '请先结束模拟面试。' : null,
    install: async action => { if (failedFlush) throw new Error('unsaved draft'); await action(); } });
  await f.service.check(); await assert.rejects(f.service.install(), /模拟面试/); assert.equal(f.service.state().phase, 'downloaded');
  busy = false; await assert.rejects(f.service.install(), /草稿已保存/); assert.deepEqual(f.actions, []);
  assert.equal(f.service.state().phase, 'downloaded'); failedFlush = false; await f.service.install(); assert.deepEqual(f.actions, ['open']);
});

test('native updates wait for the exact downloaded version and require an explicit install action', async t => {
  let events!: Parameters<NativeUpdateEngine['observe']>[0], installed = 0, removed = 0;
  const native: NativeUpdateEngine = { check: async () => '0.97.0', download: async () => {
    events.downloaded('0.98.0'); assert.equal(f.service.state().phase, 'downloading');
    events.progress(150, 100); events.downloaded('0.97.0');
  }, verify: async () => {}, install: async () => { installed++; }, observe: value => { events = value; return () => { removed++; }; } };
  const f = await fixture(t, { mode: 'native', native });
  assert.equal((await f.service.check()).phase, 'downloaded'); assert.equal(installed, 0); assert.equal(f.requests.length, 1);
  await f.service.check(); assert.equal(f.requests.length, 1, 'ready state cannot be replaced by another concurrent release');
  await f.service.install(); assert.equal(installed, 1);
  await f.service.stop(); events.downloaded('0.97.0'); assert.equal(removed, 1);
});

test('native cache damage returns to download without entering the draft-flush/install gate', async t => {
  let events!: Parameters<NativeUpdateEngine['observe']>[0];
  const native: NativeUpdateEngine = { check: async () => '0.97.0', download: async () => events.downloaded('0.97.0'),
    verify: async () => { throw Object.assign(new Error('bad cached bytes'), { code: 'UPDATE_CACHE_INVALID' }); },
    install: async () => { throw new Error('must not install'); }, observe: value => { events = value; return () => {}; } };
  const f = await fixture(t, { mode: 'native', native }); await f.service.check();
  await assert.rejects(f.service.install(), /重新下载/); assert.equal(f.service.state().phase, 'available'); assert.deepEqual(f.actions, []);
});

test('the metadata check deadline also cancels native feed discovery and leaves a retryable error', async t => {
  const deadline = new AbortController(); t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  let entered = false;
  const native: NativeUpdateEngine = { check: signal => new Promise((_, reject) => { entered = true; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }),
    download: async () => {}, verify: async () => {}, install: async () => {}, observe: () => () => {} };
  const f = await fixture(t, { mode: 'native', native }); const task = f.service.check();
  await until(() => entered); deadline.abort(new DOMException('Timed out', 'TimeoutError'));
  await Promise.race([task, new Promise((_, reject) => setTimeout(() => reject(new Error('native check ignored the deadline')), 250))]);
  assert.equal(f.service.state().phase, 'error'); assert.equal(f.service.state().latestVersion, null);
});

test('a successful new download bounds the installer cache while preserving unrelated files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'AlgoPractice-0.95.0-mac-arm64.dmg'), 'older installer');
  await writeFile(join(f.directory, '.AlgoPractice-0.95.0-mac-arm64.dmg.12345678-1234-1234-1234-123456789abc.partial'), 'interrupted download');
  await writeFile(join(f.directory, 'notes.txt'), 'keep');
  assert.equal((await f.service.check()).phase, 'downloaded');
  assert.deepEqual((await readdir(f.directory)).sort(), [release().assets[0].name, 'notes.txt'].sort());
});

test('installer selection rejects other architectures, missing checksums and substituted URLs', () => {
  assert.equal(releaseInstaller(release(), 'darwin', 'arm64')!.name, release().assets[0].name);
  assert.throws(() => releaseInstaller(release(), 'darwin', 'x64'), /匹配/);
  for (const patch of [{ digest: '' }, { browser_download_url: 'https://evil.example/update.dmg' }, { size: -1 }]) {
    const data = release(); Object.assign(data.assets[0], patch); assert.throws(() => releaseInstaller(data, 'darwin', 'arm64'), /校验信息/);
  }
  assert.equal(releaseInstaller(release(), 'linux', 'x64'), null);
});

test('download rejects truncation and unexpected redirect hosts before publishing or sending another request', async t => {
  const f = await fixture(t), asset = releaseInstaller(release(), 'darwin', 'arm64')!;
  for (const body of [contents.subarray(1), Buffer.concat([contents, Buffer.from('extra')])]) {
    await assert.rejects(downloadInstaller(asset, f.directory, async () => new Response(body), () => {}, new AbortController().signal), /大小|校验/);
    assert.deepEqual(await readdir(f.directory), []);
  }
  let requests = 0;
  await assert.rejects(downloadInstaller(asset, f.directory, async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/payload' } }); }, () => {}, new AbortController().signal), /地址无效/);
  assert.equal(requests, 1); assert.deepEqual(await readdir(f.directory), []);
});
