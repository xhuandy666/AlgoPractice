import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { approvedRuntimeSource, installRuntime, recoverRuntimeInstallations, runtimeManifest } from '../../src/runner/managed-runtime.ts';
import { RuntimeManager } from '../../src/runner/runtime-manager.ts';
import { inspectRuntime } from '../../src/runner/runtime-inspect.ts';
import { prepareCompilation } from '../../src/runner/toolchain-env.ts';
import { cachedToolchainReceipt, ensureToolchainReady, GO_BOOTSTRAP_STANDARD_PACKAGES, goStandardLibraryInventory, resetIncompleteZigCache, SharedToolchainTasks, TOOLCHAIN_SETUP_OUTPUT_BYTES, TOOLCHAIN_SETUP_TIMEOUT_MS, validateBootstrapInventory } from '../../src/runner/toolchain-prewarm.ts';
import { defaultRuntimePath, runCode } from '../../src/runner/index.ts';
import type { CompilationProfile } from '../../src/runner/toolchain-env.ts';
import { runProcess, type ToolchainProcessEnvironment } from '../../src/runner/process.ts';
import { runtimeDiscoveryPaths } from '../../src/runner/runtime-discovery.ts';

const temporary = () => mkdtemp(path.join(os.tmpdir(), 'algopractice-compiled-runtime-'));
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
test('Go bootstrap explicitly includes the production function driver standard imports', () => {
  for (const dependency of ['encoding/json', 'fmt', 'math', 'math/big', 'os', 'reflect', 'runtime/debug', 'strconv', 'unicode/utf8']) assert.ok((GO_BOOTSTRAP_STANDARD_PACKAGES as readonly string[]).includes(dependency));
});
test('shared preparation cancellation releases only that caller and removes its listener', async () => {
  for (const cancelledFirst of [true, false]) {
    const pool = new SharedToolchainTasks<number>(), started = deferred<AbortSignal>(), finish = deferred<number>(), controller = new AbortController(); let calls = 0;
    const work = (signal: AbortSignal) => { calls++; started.resolve(signal); return finish.promise; };
    const first = pool.run('profile', work, cancelledFirst ? controller.signal : undefined);
    const second = pool.run('profile', work, cancelledFirst ? undefined : controller.signal);
    const signal = await started.promise;
    controller.abort(new Error('one caller cancelled'));
    await assert.rejects(cancelledFirst ? first : second, /one caller cancelled/);
    assert.equal(signal.aborted, false); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    finish.resolve(42); assert.equal(await (cancelledFirst ? second : first), 42); assert.equal(calls, 1);
  }
});
test('last preparation caller cancellation aborts shared work and cannot erase a newer retry', async () => {
  const pool = new SharedToolchainTasks<number>(), started = deferred<AbortSignal>(), oldFinished = deferred<number>(), newFinished = deferred<number>(), controller = new AbortController(); let calls = 0;
  const first = pool.run('profile', signal => { calls++; started.resolve(signal); return oldFinished.promise; }, controller.signal);
  const signal = await started.promise; controller.abort(new Error('last caller cancelled'));
  await assert.rejects(first, /last caller cancelled/); assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const retry = pool.run('profile', async retrySignal => { calls++; assert.equal(retrySignal.aborted, false); return newFinished.promise; });
  oldFinished.reject(new Error('old task has drained'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const follower = pool.run('profile', async () => { calls++; return -1; });
  newFinished.resolve(7); assert.deepEqual(await Promise.all([retry, follower]), [7, 7]); assert.equal(calls, 2);
});
test('last preparation cancellation propagates to the real bounded child process', async () => {
  const pool = new SharedToolchainTasks<Awaited<ReturnType<typeof runProcess>>>(), controller = new AbortController(), started = deferred<void>();
  let child: Promise<Awaited<ReturnType<typeof runProcess>>> | undefined;
  const waiter = pool.run('synthetic-process', signal => { child = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: os.tmpdir(), timeoutMs: 10000, outputLimitBytes: 1024, signal }); started.resolve(); return child; }, controller.signal);
  await started.promise; controller.abort(new Error('synthetic cancellation'));
  await assert.rejects(waiter, /synthetic cancellation/); assert.equal((await child!).reason, 'cancelled');
});
test('retry repairs a cache directory removed after its profile preparation by the cancelled old reset', async () => {
  const root = await temporary();
  try {
    const executable = path.join(root, 'fixture-zig'); await writeFile(executable, 'fixture', { mode: 0o700 });
    const inspection = { language: 'cpp' as const, executable, status: 'ready' as const, version: '0.16.0', runtimeVersion: 'fixture', compilerKind: 'zig' as const, diagnostics: [] };
    const profile = await prepareCompilation('cpp', inspection, { cwd: root, root }), pool = new SharedToolchainTasks<void>(), controller = new AbortController(), removing = deferred<void>(), removed = deferred<void>(), drained = deferred<void>();
    const old = pool.run(profile.profileRoot, async signal => { await removing.promise; await rm(profile.env.ZIG_GLOBAL_CACHE_DIR!, { recursive: true }); removed.resolve(); await drained.promise; signal.throwIfAborted(); }, controller.signal);
    const retryProfile = await prepareCompilation('cpp', inspection, { cwd: root, root });
    removing.resolve(); await removed.promise; controller.abort(new Error('cancel after rm'));
    await assert.rejects(old, /cancel after rm/);
    const retry = pool.run(profile.profileRoot, signal => resetIncompleteZigCache(retryProfile, signal));
    drained.resolve(); await retry;
    assert.equal((await stat(profile.env.ZIG_GLOBAL_CACHE_DIR!)).isDirectory(), true);
    assert.equal((await stat(profile.env.ZIG_LOCAL_CACHE_DIR!)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('installer cancellation drains delayed setup cleanup before restoring the previous final directory', async () => {
  const root = await temporary(), id = randomUUID(), staging = `.go-install-${id}`, backup = `.go-backup-${id}`;
  const started = deferred<void>(), cleanupStarted = deferred<void>(), allowCleanup = deferred<void>(), controller = new AbortController(), pool = new SharedToolchainTasks<void>();
  let cleanupFinished = false, restored = false;
  try {
    await mkdir(path.join(root, staging)); await mkdir(path.join(root, backup)); await writeFile(path.join(root, backup, 'sentinel'), 'previous environment');
    await mkdir(path.join(root, 'go')); await writeFile(path.join(root, 'go', 'sentinel'), 'new environment');
    await writeFile(path.join(root, 'go', '.algopractice-runtime.json'), JSON.stringify({ installationId: id, warmState: 'pending' }));
    await writeFile(path.join(root, '.go-install.json'), JSON.stringify({ schema: 1, id, pid: 2147483647, language: 'go', staging, backup, phase: 'warming', warmRequired: true, createdAt: new Date().toISOString() }));
    const transaction = pool.run('final-installation-profile', async signal => {
      try { await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started.resolve(); }); }
      finally { cleanupStarted.resolve(); await allowCleanup.promise; await writeFile(path.join(root, 'go', 'cleanup-proof'), 'only new final path may receive this cleanup'); cleanupFinished = true; }
    }, controller.signal, { awaitCancelledTaskDrain: true }).catch(async error => {
      assert.equal(cleanupFinished, true, 'Recovery must not run before the old task finally completes.');
      const recovery = (await recoverRuntimeInstallations(root)).find(item => item.language === 'go'); assert.equal(recovery?.status, 'rolled_back'); restored = true; throw error;
    });
    const cancellation = assert.rejects(transaction, /cancel final warm/);
    await started.promise; controller.abort(new Error('cancel final warm')); await cleanupStarted.promise;
    assert.equal(restored, false); assert.equal(await readFile(path.join(root, 'go', 'sentinel'), 'utf8'), 'new environment');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    allowCleanup.resolve(); await cancellation; assert.equal(restored, true);
    assert.equal(await readFile(path.join(root, 'go', 'sentinel'), 'utf8'), 'previous environment');
    assert.deepEqual(await readdir(path.join(root, 'go')), ['sentinel']); assert.deepEqual(await readdir(root), ['go']);
  } finally { allowCleanup.resolve(); await rm(root, { recursive: true, force: true }); }
});
test('cache validation cancellation is not treated as a cache miss', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancel inventory'));
  await assert.rejects(cachedToolchainReceipt({ profileRoot: 'never-read' } as CompilationProfile, 'cpp', controller.signal), /cancel inventory/);
});
test('Go inventory records only named standard exports, not private main or cache history', async () => {
  const root = await temporary();
  try {
    const cache = path.join(root, 'go-build'); await mkdir(cache);
    const standard = path.join(cache, 'standard-d'), main = path.join(cache, 'main-d'); await writeFile(standard, 'export'); await writeFile(main, 'main');
    const profile = { profileRoot: root, profileId: 'synthetic', env: { GOCACHE: cache } } as CompilationProfile;
    assert.deepEqual(await goStandardLibraryInventory(profile, `${standard}\n\n${standard}\n`), [{ path: 'go-build/standard-d', size: 6 }]);
    await assert.rejects(goStandardLibraryInventory(profile, `${path.join(root, 'external-d')}\n`), /outside/);
    const receipt = { schema: 1, profileId: 'synthetic', inventoryKind: 'go-standard-exports-v1', requiredFiles: [{ path: 'go-build/standard-d', size: 6 }] };
    await writeFile(path.join(root, '.prepared.json'), JSON.stringify(receipt)); assert.equal(await cachedToolchainReceipt(profile, 'go'), undefined);
    receipt.inventoryKind = 'go-standard-exports-v2'; await writeFile(path.join(root, '.prepared.json'), JSON.stringify(receipt)); assert.ok(await cachedToolchainReceipt(profile, 'go'));
    const controller = new AbortController(); controller.abort(new Error('cancel exports'));
    await assert.rejects(goStandardLibraryInventory(profile, `${standard}\n`, controller.signal), /cancel exports/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('bundled Go/Zig require real bootstrap artifacts; only system C++ permits no cache inventory', () => {
  assert.throws(() => validateBootstrapInventory('go', undefined, []), /no cache artifacts/);
  assert.throws(() => validateBootstrapInventory('cpp', 'zig', []), /no cache artifacts/);
  assert.doesNotThrow(() => validateBootstrapInventory('cpp', 'clang', []));
  assert.doesNotThrow(() => validateBootstrapInventory('cpp', 'gcc', []));
  assert.doesNotThrow(() => validateBootstrapInventory('cpp', 'zig', [{ path: 'zig-global/o/libc++.a', size: 4096 }]));
});
test('Go/Zig manifest sources are exact official families, not arbitrary approved-host files', () => {
  for (const language of ['go', 'cpp'] as const) for (const artifact of Object.values(runtimeManifest[language].targets)) assert.equal(approvedRuntimeSource(language, new URL(artifact.url)), true);
  assert.equal(approvedRuntimeSource('go', new URL('https://dl.google.com/arbitrary.exe')), false);
  assert.equal(approvedRuntimeSource('cpp', new URL('https://ziglang.org/unknown.zip')), false);
  assert.equal(approvedRuntimeSource('cpp', new URL('http://ziglang.org/download/0.16.0/zig-x86_64-windows-0.16.0.zip')), false);
  assert.equal(approvedRuntimeSource('go', new URL('https://attacker.invalid/go/go1.27.2.windows-amd64.zip')), false);
  assert.equal(TOOLCHAIN_SETUP_TIMEOUT_MS, 300000); assert.equal(TOOLCHAIN_SETUP_OUTPUT_BYTES, 64000000);
});
test('four-language manager state and discovery preserve compiler/toolchain identities', async () => {
  const root = await temporary();
  try {
    assert.deepEqual(new RuntimeManager({ root }).states().map(state => state.language), ['python', 'java', 'go', 'cpp']);
    const go = await runtimeDiscoveryPaths('go', { platform: 'win32', cwd: 'C:\\project', home: 'C:\\Users\\person', env: { GOROOT: 'C:\\toolchains\\go', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\tools' } });
    assert.deepEqual(go, ['C:\\toolchains\\go\\bin\\go.exe', 'C:\\Program Files\\Go\\bin\\go.exe', 'C:\\tools\\go.exe']);
    const cpp = await runtimeDiscoveryPaths('cpp', { platform: 'win32', cwd: 'C:\\project', home: 'C:\\Users\\person', env: { PATH: 'C:\\tools' } });
    assert.deepEqual(cpp, ['C:\\tools\\zig.exe', 'C:\\tools\\clang++.exe', 'C:\\tools\\g++.exe']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('host process rejects arbitrary secrets, PATH and compiler hook environment before launch', async () => {
  for (const key of ['OPENAI_API_KEY', 'PATH', 'GOFLAGS', 'GOCACHEPROG', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) {
    const result = await runProcess(process.execPath, ['-e', 'process.exit(99)'], { cwd: os.tmpdir(), timeoutMs: 1000, outputLimitBytes: 1024, env: { [key]: 'not-allowed' } as ToolchainProcessEnvironment });
    assert.equal(result.reason, 'spawn_error'); assert.equal(result.code, null);
  }
});
test('chunked multi-stream capture preserves complete UTF-8 without quadratic prefix recopies', async () => {
  const result = await runProcess(process.execPath, ['-e', 'for(let i=0;i<8192;i++){process.stdout.write("🙂");process.stderr.write("界");}'], { cwd: os.tmpdir(), timeoutMs: 10000, outputLimitBytes: 65536 });
  assert.equal(result.reason, undefined); assert.equal(result.code, 0);
  assert.equal(result.stdout, '🙂'.repeat(8192)); assert.equal(result.stderr, '界'.repeat(8192));
});
test('multi-stream output limits remain shared and never expose a truncated UTF-8 replacement', async () => {
  const result = await runProcess(process.execPath, ['-e', 'for(let i=0;i<50000;i++){process.stdout.write("🙂");process.stderr.write("界");}'], { cwd: os.tmpdir(), timeoutMs: 10000, outputLimitBytes: 4096 });
  assert.equal(result.reason, 'output_limit'); assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 4096);
  assert.ok(!result.stdout.includes('\uFFFD') && !result.stderr.includes('\uFFFD'));
});
test('system Zig preparation writes only app-private caches and reuses the precise C++ profile', async () => {
  const root = await temporary(), system = await temporary();
  try {
    const executable = path.join(system, process.platform === 'win32' ? 'zig.exe' : 'zig'); await writeFile(executable, 'synthetic compiler', { mode: 0o700 });
    const inspection = { language: 'cpp' as const, executable, status: 'ready' as const, version: '0.16.0', runtimeVersion: 'Zig 0.16.0', compilerKind: 'zig' as const, diagnostics: [] };
    const profile = await prepareCompilation('cpp', inspection, { cwd: root, root });
    assert.equal(profile.env.ZIG_LIB_DIR, path.join(await realpath(system), 'lib'));
    assert.deepEqual(await readdir(system), [path.basename(executable)]);
    assert.ok(profile.profileRoot.startsWith(path.join(root, '.toolchain-cache', 'cpp')));
    assert.deepEqual(profile.argsPrefix.slice(-5), ['-std=c++17', '-O0', '-fno-color-diagnostics', '-Wno-nullability-completeness', '-Wno-nullability-completeness-on-arrays']);
    assert.ok(profile.env.DEVELOPER_DIR?.endsWith('no-apple-developer-tools'));
    const repeated = await prepareCompilation('cpp', inspection, { cwd: root, root }); assert.equal(repeated.profileId, profile.profileId);
    await writeFile(executable, 'changed synthetic compiler');
    assert.notEqual((await prepareCompilation('cpp', inspection, { cwd: root, root })).profileId, profile.profileId);
  } finally { await rm(root, { recursive: true, force: true }); await rm(system, { recursive: true, force: true }); }
});
test('private compiler configuration refuses an external home symlink before any configuration write', { skip: process.platform === 'win32' }, async () => {
  const root = await temporary(), external = await temporary();
  try {
    const executable = path.join(root, 'fixture-zig'); await writeFile(executable, 'fixture', { mode: 0o700 });
    const inspection = { language: 'cpp' as const, executable, status: 'ready' as const, version: '0.16.0', runtimeVersion: 'fixture', compilerKind: 'zig' as const, diagnostics: [] };
    const profile = await prepareCompilation('cpp', inspection, { cwd: root, root });
    await rm(profile.env.HOME!, { recursive: true }); await symlink(external, profile.env.HOME!);
    await assert.rejects(prepareCompilation('cpp', inspection, { cwd: root, root }), /symbolic link/);
    assert.deepEqual(await readdir(external), []);
  } finally { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});
for (const language of ['go', 'cpp'] as const) for (const state of ['pending', 'ready', 'conflict', 'new-pending'] as const) test(`${language} final-path warming recovery: ${state}`, async () => {
  const root = await temporary(), id = randomUUID(), staging = `.${language}-install-${id}`, backup = `.${language}-backup-${id}`;
  try {
    await mkdir(path.join(root, staging));
    if (state !== 'new-pending') { await mkdir(path.join(root, backup)); await writeFile(path.join(root, backup, 'sentinel'), 'old ready installation'); }
    await mkdir(path.join(root, language)); await writeFile(path.join(root, language, 'sentinel'), 'new installation');
    await writeFile(path.join(root, language, '.algopractice-runtime.json'), JSON.stringify({ installationId: state === 'conflict' ? randomUUID() : id, warmState: state === 'ready' ? 'ready' : 'pending' }));
    await writeFile(path.join(root, `.${language}-install.json`), JSON.stringify({ schema: 1, id, pid: 2147483647, language, staging, backup, phase: 'warming', warmRequired: true, createdAt: new Date().toISOString() }));
    const outcome = (await recoverRuntimeInstallations(root)).find(item => item.language === language)!;
    assert.equal(outcome.status, state === 'ready' ? 'committed' : state === 'pending' ? 'rolled_back' : state === 'conflict' ? 'needs_attention' : 'discarded');
    if (state === 'new-pending') assert.deepEqual(await readdir(root), []);
    else assert.equal(await readFile(path.join(root, language, 'sentinel'), 'utf8'), state === 'pending' ? 'old ready installation' : 'new installation');
    if (state === 'conflict') assert.equal(await readFile(path.join(root, backup, 'sentinel'), 'utf8'), 'old ready installation');
    else if (state !== 'new-pending') assert.deepEqual(await readdir(root), [language]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a pending Go marker is not ready or uninstallable; ready managed caches count toward size', async () => {
  const root = await temporary();
  try {
    const directory = path.join(root, 'go'); await mkdir(path.join(directory, 'bin'), { recursive: true });
    await writeFile(path.join(directory, 'bin', process.platform === 'win32' ? 'go.exe' : 'go'), 'synthetic', { mode: 0o700 });
    const marker = { schema: 1, installationId: randomUUID(), language: 'go', target: 'darwin-arm64', version: '1.27.2', sha256: 'a'.repeat(64), source: 'offline-archive', installedAt: new Date().toISOString(), warmState: 'pending' };
    await writeFile(path.join(directory, '.algopractice-runtime.json'), JSON.stringify(marker));
    const manager = new RuntimeManager({ root }); assert.equal((await manager.details('go')).managed.canUninstall, false);
    assert.equal((await inspectRuntime('go', { root })).status, 'error');
    marker.warmState = 'ready'; await writeFile(path.join(directory, '.algopractice-runtime.json'), JSON.stringify(marker));
    await mkdir(path.join(directory, '.algopractice-cache')); await writeFile(path.join(directory, '.algopractice-cache', 'synthetic-cache'), Buffer.alloc(4096));
    const details = await manager.details('go', true); assert.equal(details.managed.owned, true); assert.ok(details.managed.logicalBytes! >= 4096);
    await manager.uninstall('go'); assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const goArchive = process.env.ALGOPRACTICE_GO_OFFLINE_ARCHIVE;
test('real Go cancellation during final-path warming restores the previous directory without network', { skip: !goArchive ? 'Set ALGOPRACTICE_GO_OFFLINE_ARCHIVE to the pinned host archive' : false, timeout: 120000 }, async () => {
  const root = await temporary(), originalFetch = globalThis.fetch;
  try {
    await mkdir(path.join(root, 'go')); await writeFile(path.join(root, 'go', 'sentinel'), 'previous');
    globalThis.fetch = (async () => { throw new Error('Offline test must not download'); }) as typeof fetch;
    const controller = new AbortController(); let validations = 0;
    await assert.rejects(installRuntime('go', { root, localArchive: goArchive, signal: controller.signal, onProgress: progress => { if (progress.phase === 'validate' && ++validations === 2) controller.abort(new Error('synthetic final warming cancellation')); } }), /cancell|abort/i);
    assert.equal(validations, 2); assert.equal(await readFile(path.join(root, 'go/sentinel'), 'utf8'), 'previous'); assert.deepEqual(await readdir(root), ['go']);
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
test('macOS compiler launchers are refused without triggering developer tool installation', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal((await inspectRuntime('cpp', { runtimePath: '/usr/bin/clang++' })).status, 'incompatible');
});

// Toolchain packages are read-only; all cache mutations below target fresh temporary roots.
const cacheTestRoot = process.env.ALGOPRACTICE_TOOLCHAIN_CACHE_TEST_ROOT ?? process.env.ALGOPRACTICE_NATIVE_TEST_ROOT;
test('real cached C++ inspection repairs a deleted stdlib archive before normal-budget user compilation', { skip: !cacheTestRoot ? 'Set ALGOPRACTICE_TOOLCHAIN_CACHE_TEST_ROOT to prepared Go/C++ packages' : false, timeout: 620000 }, async () => {
  const root = await temporary(), executable = defaultRuntimePath('cpp', path.resolve(cacheTestRoot!));
  try {
    const first = await inspectRuntime('cpp', { root, runtimePath: executable }); assert.equal(first.status, 'ready', JSON.stringify(first));
    const readyAt = Date.now(), profile = await prepareCompilation('cpp', first, { cwd: root, root });
    const before = await cachedToolchainReceipt(profile, 'cpp'); assert.ok(before);
    const library = before.requiredFiles.find(file => /(?:^|[\\/])libc\+\+\.a$/.test(file.path)); assert.ok(library, 'The proof must delete the actual libc++ archive.');
    const artifact = path.join(profile.profileRoot, library.path); await rm(artifact);
    assert.equal(await cachedToolchainReceipt(profile, 'cpp'), undefined);
    assert.ok(Date.now() - readyAt < 30000, 'The second inspection must enter the ready metadata cache branch.');
    const second = await inspectRuntime('cpp', { root, runtimePath: executable }); assert.equal(second.status, 'ready', JSON.stringify(second));
    const after = await cachedToolchainReceipt(profile, 'cpp'); assert.ok(after); assert.notEqual(after.compiledAt, before.compiledAt);
    const rebuilt = after.requiredFiles.find(file => /(?:^|[\\/])libc\+\+\.a$/.test(file.path)); assert.ok(rebuilt); assert.equal((await stat(path.join(profile.profileRoot, rebuilt.path))).size, rebuilt.size);
    const result = await runCode({ language: 'cpp', runtimePath: executable, mode: 'acm', code: '#include <bits/stdc++.h>\nint main(){std::vector<bool>b{true,false};try{throw std::runtime_error("synthetic");}catch(const std::exception&){std::cout<<b[0]<<"\\n";}}', cases: [{ stdin: '', expected: '1\n' }], outputLimitBytes: 65536, compileTimeoutMs: 30000 }, { runtimeRoot: root });
    assert.equal(result.status, 'passed', JSON.stringify(result)); assert.equal(result.stderr, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('real Go readiness excludes main exports and more than 3000 historical cache artifacts', { skip: !cacheTestRoot ? 'Set ALGOPRACTICE_TOOLCHAIN_CACHE_TEST_ROOT to prepared Go/C++ packages' : false, timeout: 340000 }, async () => {
  const root = await temporary(), executable = defaultRuntimePath('go', path.resolve(cacheTestRoot!));
  try {
    const inspection = await inspectRuntime('go', { root, runtimePath: executable }); assert.equal(inspection.status, 'ready', JSON.stringify(inspection));
    const profile = await prepareCompilation('go', inspection, { cwd: root, root }), before = await cachedToolchainReceipt(profile, 'go'); assert.ok(before);
    assert.equal(before.inventoryKind, 'go-standard-exports-v2');
    await writeFile(path.join(root, 'history-main.go'), 'package main\nimport "fmt"\nfunc main(){fmt.Println("historical user main")}\n');
    const main = await runProcess(executable, ['list', ...profile.argsPrefix.slice(1), '-export', '-f', '{{.Export}}', 'history-main.go'], { cwd: root, env: profile.env, timeoutMs: 30000, outputLimitBytes: 16384 });
    assert.equal(main.reason, undefined); assert.equal(main.code, 0); assert.ok(main.stdout.trim().endsWith('-d'));
    const mainRelative = path.relative(profile.profileRoot, main.stdout.trim());
    assert.ok(!before.requiredFiles.some(file => file.path === mainRelative));
    const history = path.join(profile.env.GOCACHE!, 'synthetic-history'); await mkdir(history);
    for (let start = 0; start < 3101; start += 100) await Promise.all(Array.from({ length: Math.min(100, 3101 - start) }, (_, i) => writeFile(path.join(history, `${start + i}-d`), 'unrelated historical artifact')));
    await rm(path.join(profile.profileRoot, before.requiredFiles[0].path));
    const after = await ensureToolchainReady('go', inspection, { cwd: root, root });
    assert.ok(after.requiredFiles.length > 0 && after.requiredFiles.length < 3000);
    assert.ok(after.requiredFiles.every(file => !file.path.includes('synthetic-history') && file.path !== mainRelative));
    assert.ok(await cachedToolchainReceipt(profile, 'go'));
    const controller = new AbortController(), validation = cachedToolchainReceipt(profile, 'go', controller.signal); controller.abort(new Error('cancel in-progress inventory'));
    await assert.rejects(validation, /cancel in-progress inventory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
