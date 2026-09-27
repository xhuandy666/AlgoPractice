import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeManager, type RuntimeTaskState } from '../../src/runner/runtime-manager.ts';
import { installRuntime } from '../../src/runner/managed-runtime.ts';
import type { Language } from '../../src/runner/types.ts';

const installed = (language: Language): Awaited<ReturnType<typeof installRuntime>> => ({ language, target: 'darwin-arm64', executable: `/managed/${language}`, runtimeVersion: 'fixture', compilerVersion: undefined, sha256: 'a'.repeat(64), url: 'https://github.com/fixture', source: 'download', installedAt: new Date().toISOString() });
async function fixture() { return mkdtemp(path.join(os.tmpdir(), 'algopractice-manager-')); }
async function marked(root: string, language: Language) {
  const directory = path.join(root, language); await mkdir(directory);
  await writeFile(path.join(directory, '.algopractice-runtime.json'), JSON.stringify({ schema: 1, installationId: randomUUID(), language, target: 'darwin-arm64', version: '3.14.7', sha256: 'a'.repeat(64), source: 'offline-archive', installedAt: new Date().toISOString() }));
  await writeFile(path.join(directory, 'runtime'), 'runtime fixture'); return directory;
}
test('same-language same-source installation is single flight; another language proceeds independently', async () => {
  const root = await fixture();
  try {
    const complete = new Map<Language, (value: ReturnType<typeof installed>) => void>(); let calls = 0;
    const manager = new RuntimeManager({ root, installer: (async language => { calls++; return await new Promise(resolve => complete.set(language, resolve)); }) as typeof installRuntime });
    const python = manager.install('python'); assert.equal(manager.install('python'), python);
    const java = manager.install('java'); await Promise.resolve(); assert.equal(calls, 2); assert.equal(manager.pendingPromises.length, 2);
    complete.get('python')!(installed('python')); await python;
    assert.equal(manager.state('python').busy, false); assert.equal(manager.state('java').busy, true);
    const release = manager.retain('python', 'run'); release();
    assert.throws(() => manager.retain('java', 'run'), /being changed/);
    complete.get('java')!(installed('java')); await java; assert.equal(manager.busy, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('active runtime cannot be replaced; pending request allows install but blocks uninstall', async () => {
  const root = await fixture();
  try {
    const manager = new RuntimeManager({ root, installer: async language => installed(language) });
    const releaseRun = manager.retain('python', 'run'); await assert.rejects(manager.install('python'), /in use/); releaseRun(); releaseRun();
    const releasePending = manager.retain('python', 'pending'); await manager.install('python'); await assert.rejects(manager.uninstall('python'), /referenced/); releasePending();
    assert.deepEqual((await manager.details('python')).references, { run: 0, pending: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('cancellation is language-specific, drains and retains a distinct cancelled state', async () => {
  const root = await fixture();
  try {
    const manager = new RuntimeManager({ root, installer: (async (_language, options) => await new Promise((_resolve, reject) => { if (options.signal?.aborted) reject(options.signal.reason); else options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }); })) as typeof installRuntime });
    const python = manager.install('python'), java = manager.install('java');
    const results = Promise.allSettled([python, java]);
    manager.cancel('python'); await Promise.resolve(); assert.equal(manager.state('java').busy, true);
    manager.cancelAll(); await results; assert.equal(manager.busy, false); assert.equal(manager.pendingPromises.length, 0); assert.equal(manager.state('python').phase, 'cancelled');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('different offline source cannot join or replace an active task', async () => {
  const root = await fixture();
  try {
    let finish!: (result: ReturnType<typeof installed>) => void;
    const manager = new RuntimeManager({ root, installer: (async () => await new Promise(resolve => { finish = resolve; })) as typeof installRuntime });
    const running = manager.install('python'); await Promise.resolve(); await assert.rejects(manager.install('python', { localArchive: '/offline/archive' }), /different installation source/); finish(installed('python')); await running;
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('byte progress is throttled at 200 ms while phase transitions and complete byte counts remain immediate', async () => {
  const root = await fixture();
  try {
    let now = 0; const events: RuntimeTaskState[] = [];
    const manager: RuntimeManager = new RuntimeManager({ root, now: () => now, onState: state => events.push(state), installer: async (language, options) => {
      options.onProgress!({ phase: 'download', receivedBytes: 10, totalBytes: 100 });
      now = 25; options.onProgress!({ phase: 'download', receivedBytes: 20, totalBytes: 100 });
      now = 199; options.onProgress!({ phase: 'download', receivedBytes: 30, totalBytes: 100 });
      assert.equal(manager.state(language).progress!.receivedBytes, 30);
      now = 200; options.onProgress!({ phase: 'download', receivedBytes: 40, totalBytes: 100 });
      now = 201; options.onProgress!({ phase: 'download', receivedBytes: 100, totalBytes: 100 });
      for (const phase of ['verify', 'extract', 'validate', 'commit', 'ready'] as const) options.onProgress!({ phase, receivedBytes: 100, totalBytes: 100 });
      return installed(language);
    } });
    await manager.install('python');
    assert.deepEqual(events.filter(event => event.progress?.phase === 'download').map(event => event.progress!.receivedBytes), [10, 40, 100]);
    assert.deepEqual([...new Set(events.flatMap(event => event.progress ? [event.progress.phase] : []))], ['download', 'verify', 'extract', 'validate', 'commit', 'ready']);
    assert.equal(events.at(-1)!.busy, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('details report pinned download size and measured managed space, not invented expanded/peak estimates', async () => {
  const root = await fixture();
  try {
    await marked(root, 'python'); const manager = new RuntimeManager({ root }), details = await manager.details('python');
    assert.ok(details.artifact.downloadBytes! > 0); assert.equal(details.artifact.expandedBytes, null); assert.equal(details.artifact.peakBytes, null);
    assert.equal(details.managed.owned, true); assert.ok(details.managed.logicalBytes! > 0); assert.ok(details.managed.diskBytes! >= 0); assert.equal(details.managed.canUninstall, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('uninstall removes only the exact marked runtime and leaves external symlink target untouched', { skip: process.platform === 'win32' ? 'Windows symlink creation requires elevated privilege or Developer Mode.' : false }, async () => {
  const root = await fixture(), external = await fixture();
  try {
    const directory = await marked(root, 'python'); await writeFile(path.join(external, 'keep'), 'user archive'); await symlink(external, path.join(directory, 'external'));
    const manager = new RuntimeManager({ root }); await manager.uninstall('python'); assert.deepEqual(await readdir(root), []); assert.equal(await readFile(path.join(external, 'keep'), 'utf8'), 'user archive');
  } finally { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});
test('shutdown drain includes a confirmed uninstall until its transaction finishes', async () => {
  const root = await fixture();
  try {
    await marked(root, 'python'); const manager = new RuntimeManager({ root });
    const removal = manager.uninstall('python'); assert.equal(manager.pendingPromises.length, 1); assert.equal(manager.busy, true);
    manager.cancelAll(); await Promise.allSettled(manager.pendingPromises); await removal;
    assert.equal(manager.pendingPromises.length, 0); assert.equal(manager.busy, false); assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('uninstall refuses unmarked directory and unresolved installer journal', async () => {
  const root = await fixture();
  try {
    const manager = new RuntimeManager({ root }); await mkdir(path.join(root, 'python')); await assert.rejects(manager.uninstall('python'), /unowned/); await rm(path.join(root, 'python'), { recursive: true });
    await marked(root, 'python'); await writeFile(path.join(root, '.python-install.json'), '{}'); await assert.rejects(manager.uninstall('python'), /recovery/); assert.ok(await readFile(path.join(root, 'python/runtime')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('uninstall refuses a symbolic-linked runtime directory', { skip: process.platform === 'win32' ? 'Windows symlink creation requires elevated privilege or Developer Mode.' : false }, async () => {
  const root = await fixture(), external = await fixture();
  try {
    const manager = new RuntimeManager({ root });
    await marked(external, 'python'); await symlink(path.join(external, 'python'), path.join(root, 'python')); await assert.rejects(manager.uninstall('python'), /unowned/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});
test('download timeout fails safely and removes owned staging without changing existing runtime', async () => {
  const root = await fixture(), originalFetch = globalThis.fetch;
  try {
    await mkdir(path.join(root, 'python')); await writeFile(path.join(root, 'python/keep'), 'existing');
    globalThis.fetch = (async (_url, init) => await new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); })) as typeof fetch;
    await assert.rejects(installRuntime('python', { root, downloadTimeoutMs: 20 }), /timeout|timed out/i);
    assert.equal(await readFile(path.join(root, 'python/keep'), 'utf8'), 'existing'); assert.deepEqual(await readdir(root), ['python']);
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
test('download rejects insecure or unapproved redirects before requesting their destination', async () => {
  const root = await fixture(), originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    for (const location of ['http://github.com/archive', 'https://unapproved.invalid/archive']) {
      globalThis.fetch = (async () => { calls++; return new Response(null, { status: 302, headers: { location } }); }) as typeof fetch;
      const previousCalls = calls; await assert.rejects(installRuntime('python', { root }), /approved HTTPS/); assert.equal(calls, previousCalls + 1); assert.deepEqual(await readdir(root), []);
    }
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
