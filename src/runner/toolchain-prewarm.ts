import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './process.ts';
import { prepareCompilation, type CompiledLanguage, type CompilationPreparationOptions, type CompilationProfile } from './toolchain-env.ts';
import type { RuntimeInspection } from './runtime-inspect.ts';

export const TOOLCHAIN_SETUP_TIMEOUT_MS = 300000;
export const TOOLCHAIN_SETUP_OUTPUT_BYTES = 64000000;
export const GO_BOOTSTRAP_STANDARD_PACKAGES = ['encoding/json', 'fmt', 'sort', 'unicode/utf8', 'math', 'math/big', 'os', 'reflect', 'runtime/debug', 'strconv'] as const;
const goProbe = `package main\nimport(${GO_BOOTSTRAP_STANDARD_PACKAGES.map((name, index) => `${index < 4 ? '' : '_ '}${JSON.stringify(name)}`).join(';')})\nfunc main(){v:=[]int{3,1,2};sort.Ints(v);b,_:=json.Marshal([]bool{true,false});if utf8.RuneCountInString("算法🚀")!=3||string(b)!="[true,false]"{panic("probe")};fmt.Println(v[0]+v[1]+v[2])}\n`;
const cppProbe = '#include <algorithm>\n#include <iostream>\n#include <optional>\n#include <stdexcept>\n#include <string>\n#include <unordered_map>\n#include <vector>\nint main(){static_assert(sizeof(void*)==8);std::vector<int>v{3,1,2};std::sort(v.begin(),v.end());std::vector<bool>b{true,false};std::optional<std::string>s=u8"算法🚀";try{throw std::runtime_error(*s);}catch(const std::exception&){std::cout<<v[0]+v[1]+v[2]<<"\\n";}}\n';
interface WarmReceipt { schema: 1; profileId: string; inventoryKind?: 'go-standard-exports-v2'; requiredFiles: { path: string; size: number }[]; compiledAt: string; durationMs: number; vendorDiagnosticBytes: number; }
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new Error('Toolchain preparation cancelled'); };
interface SharedTask<T> { controller: AbortController; promise: Promise<T>; waiters: number; settled: boolean; }
/** Each caller owns a cancellable lease, not the lifetime of other callers. */
export class SharedToolchainTasks<T> {
  private readonly tasks = new Map<string, SharedTask<T>>();
  run(key: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, options: { awaitCancelledTaskDrain?: boolean } = {}): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Toolchain preparation cancelled'));
    let task = this.tasks.get(key);
    if (!task || task.controller.signal.aborted) {
      const draining = task?.promise.catch(() => undefined);
      const controller = new AbortController();
      task = { controller, waiters: 0, settled: false, promise: undefined as unknown as Promise<T> };
      const current = task;
      current.promise = Promise.resolve(draining).then(() => { cancelled(controller.signal); return work(controller.signal); }).finally(() => {
        current.settled = true;
        if (this.tasks.get(key) === current) this.tasks.delete(key);
      });
      this.tasks.set(key, current);
    }
    const current = task; current.waiters++;
    return new Promise<T>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return; released = true;
        signal?.removeEventListener('abort', onAbort);
        if (--current.waiters === 0 && !current.settled) current.controller.abort(new Error('All toolchain preparation callers cancelled'));
      };
      const onAbort = () => {
        const error = signal?.reason ?? new Error('Toolchain preparation cancelled'); release();
        // Only a final-path installer needs this ownership barrier: rollback
        // must not restore an old directory while setup's finally still uses it.
        if (options.awaitCancelledTaskDrain) current.promise.then(() => reject(error), () => reject(error));
        else reject(error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      current.promise.then(value => { if (!released) { release(); resolve(value); } }, error => { if (!released) { release(); reject(error); } });
      if (signal?.aborted) onAbort();
    });
  }
}
const warming = new SharedToolchainTasks<WarmReceipt>();
export function validateBootstrapInventory(language: CompiledLanguage, compilerKind: RuntimeInspection['compilerKind'], files: WarmReceipt['requiredFiles']): void {
  if ((language === 'go' || compilerKind === 'zig') && files.length === 0) throw new Error('Bundled toolchain bootstrap produced no cache artifacts; environment is not ready.');
}
export async function cachedToolchainReceipt(profile: CompilationProfile, language: CompiledLanguage, signal?: AbortSignal): Promise<WarmReceipt | undefined> {
  try {
    cancelled(signal);
    const receiptPath = path.join(profile.profileRoot, '.prepared.json'), receiptInfo = await lstat(receiptPath);
    if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.size > 1048576) return undefined;
    const value = JSON.parse(await readFile(receiptPath, 'utf8')) as WarmReceipt;
    cancelled(signal);
    if (value.schema !== 1 || value.profileId !== profile.profileId || !Array.isArray(value.requiredFiles) || value.requiredFiles.length === 0 || value.requiredFiles.length > 3000) return undefined;
    if (language === 'go' && value.inventoryKind !== 'go-standard-exports-v2') return undefined;
    const canonicalRoot = await realpath(profile.profileRoot);
    for (const item of value.requiredFiles) {
      cancelled(signal);
      if (typeof item.path !== 'string' || !item.path || path.isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..') || !Number.isSafeInteger(item.size) || item.size < 0) return undefined;
      const candidate = path.join(profile.profileRoot, item.path);
      const info = await lstat(candidate); if (!info.isFile() || info.isSymbolicLink() || info.size !== item.size || await realpath(candidate) !== path.join(canonicalRoot, item.path)) return undefined;
    }
    cancelled(signal);
    return value;
  } catch { cancelled(signal); return undefined; }
}
/** Only exports named by the synthetic probe's standard-library dependency graph. */
export async function goStandardLibraryInventory(profile: CompilationProfile, exports: string, signal?: AbortSignal): Promise<WarmReceipt['requiredFiles']> {
  cancelled(signal);
  const cacheRoot = profile.env.GOCACHE!, canonicalRoot = await realpath(cacheRoot), files: WarmReceipt['requiredFiles'] = [];
  const candidates = [...new Set(exports.split(/\r?\n/).filter(Boolean))];
  if (candidates.length > 3000) throw new Error('Toolchain bootstrap file budget exceeded.');
  for (const candidate of candidates) {
    cancelled(signal);
    const relative = path.relative(cacheRoot, candidate);
    if (!path.isAbsolute(candidate) || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || !candidate.endsWith('-d')) throw new Error('Go standard-library export is outside the private build cache.');
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(candidate) !== path.join(canonicalRoot, relative)) throw new Error('Go standard-library export is not an ordinary private cache file.');
    files.push({ path: path.relative(profile.profileRoot, candidate), size: info.size });
  }
  cancelled(signal); return files;
}
async function cppCacheInventory(profile: CompilationProfile, signal: AbortSignal): Promise<WarmReceipt['requiredFiles']> {
  const root = path.join(profile.profileRoot, 'zig-global'), files: WarmReceipt['requiredFiles'] = [], pending = [root];
  let visited = 0;
  while (pending.length) {
    cancelled(signal);
    if (++visited > 10000) throw new Error('Toolchain cache inventory exceeded its bounded budget.');
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Toolchain bootstrap created an unexpected cache link.');
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && /\.(?:a|lib)$/.test(entry.name)) {
        files.push({ path: path.relative(profile.profileRoot, candidate), size: (await stat(candidate)).size });
        if (files.length > 3000) throw new Error('Toolchain bootstrap file budget exceeded.');
      }
    }
  }
  // System clang/gcc do not bootstrap a bundled standard library. Their probe output is retained below.
  return files;
}
export async function resetIncompleteZigCache(profile: CompilationProfile, signal: AbortSignal): Promise<void> {
  // Zig's manifest may still advertise an archive a user has removed. A fresh
  // probe alone cannot repair that record. Only these exact app-private,
  // regenerable directories are reset; no compiler installation is changed.
  for (const [key, name] of [['ZIG_GLOBAL_CACHE_DIR', 'zig-global'], ['ZIG_LOCAL_CACHE_DIR', 'zig-local']] as const) {
    cancelled(signal);
    const directory = path.join(profile.profileRoot, name);
    if (profile.env[key] !== directory) throw new Error('Refused an external Zig cache reset.');
    if ((await lstat(profile.profileRoot)).isSymbolicLink()) throw new Error('Refused an unowned Zig cache reset.');
    // An aborted reset can remove a directory after the retry prepared its
    // profile. After the old task drains, recreate only this exact owned child.
    try { await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== path.join(await realpath(profile.profileRoot), name)) throw new Error('Refused an unowned Zig cache reset.');
    await rm(directory, { recursive: true }); cancelled(signal); await mkdir(directory);
  }
}
/** Setup has its own bounded budget; it never expands a user run's limits. */
export async function ensureToolchainReady(language: CompiledLanguage, inspection: RuntimeInspection, options: CompilationPreparationOptions & { /** Installer final-path ownership barrier, not a user-run setting. */ awaitCancelledTaskDrain?: boolean }): Promise<WarmReceipt> {
  const profile = await prepareCompilation(language, inspection, options);
  cancelled(options.signal);
  const previous = await cachedToolchainReceipt(profile, language, options.signal);
  // A system SDK can change independently of the compiler executable. Its tiny
  // native probe is reused for UI polling, not treated as an indefinite SDK proof.
  if (previous && (language !== 'cpp' || inspection.compilerKind === 'zig' || Date.now() - Date.parse(previous.compiledAt) < 30000)) return previous;
  cancelled(options.signal);
  return warming.run(profile.profileRoot, async signal => {
    cancelled(signal);
    const deadline = performance.now() + TOOLCHAIN_SETUP_TIMEOUT_MS;
    const remaining = (limit = TOOLCHAIN_SETUP_TIMEOUT_MS) => { const ms = Math.ceil(deadline - performance.now()); if (ms <= 0) throw new Error('Toolchain setup exceeded its total time budget.'); return Math.min(limit, ms); };
    if (language === 'cpp' && inspection.compilerKind === 'zig') await resetIncompleteZigCache(profile, signal);
    const probes = path.join(profile.profileRoot, 'probes'); await mkdir(probes, { recursive: true });
    const cwd = await mkdtemp(path.join(probes, 'probe-'));
    try {
      const source = language === 'go' ? 'main.go' : 'main.cpp', binary = path.join(cwd, process.platform === 'win32' ? 'probe.exe' : 'probe');
      await writeFile(path.join(cwd, source), language === 'go' ? goProbe : cppProbe);
      const args = [...profile.argsPrefix, '-o', binary, source];
      const compile = await runProcess(profile.executable, args, { cwd, env: profile.env, timeoutMs: remaining(), outputLimitBytes: TOOLCHAIN_SETUP_OUTPUT_BYTES, signal });
      cancelled(signal);
      if (compile.reason || compile.code !== 0) throw new Error(`Toolchain setup compilation failed (${compile.reason ?? compile.code}): ${compile.stderr.slice(-8192)}`);
      const execute = await runProcess(binary, [], { cwd, timeoutMs: remaining(10000), outputLimitBytes: 16384, signal });
      cancelled(signal);
      if (execute.reason || execute.code !== 0 || execute.stdout.replaceAll('\r\n', '\n').trim() !== '6') throw new Error(`Toolchain setup executable failed: ${execute.reason ?? execute.stderr}`);
      let requiredFiles: WarmReceipt['requiredFiles'];
      if (language === 'go') {
        const list = await runProcess(profile.executable, ['list', ...profile.argsPrefix.slice(1), '-deps', '-export', '-f', '{{if .Standard}}{{.Export}}{{end}}', source], { cwd, env: profile.env, timeoutMs: remaining(), outputLimitBytes: 1048576, signal });
        cancelled(signal);
        if (list.reason || list.code !== 0) throw new Error(`Go standard-library inventory failed: ${list.reason ?? list.stderr}`);
        requiredFiles = await goStandardLibraryInventory(profile, list.stdout, signal);
      } else requiredFiles = inspection.compilerKind === 'zig' ? await cppCacheInventory(profile, signal) : [];
      validateBootstrapInventory(language, inspection.compilerKind, requiredFiles);
      if (!requiredFiles.length) {
        const sentinel = path.join(profile.profileRoot, 'system-compiler-probe'); await writeFile(sentinel, 'C++17 compile/link/run passed\n');
        requiredFiles.push({ path: 'system-compiler-probe', size: (await stat(sentinel)).size });
      }
      cancelled(signal); remaining();
      const receipt: WarmReceipt = { schema: 1, profileId: profile.profileId, ...(language === 'go' ? { inventoryKind: 'go-standard-exports-v2' as const } : {}), requiredFiles, compiledAt: new Date().toISOString(), durationMs: compile.durationMs, vendorDiagnosticBytes: Buffer.byteLength(compile.stderr) };
      const temporary = path.join(profile.profileRoot, `.prepared-${randomUUID()}.json`); await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
      try { cancelled(signal); await rename(temporary, path.join(profile.profileRoot, '.prepared.json')); cancelled(signal); return receipt; }
      finally { await rm(temporary, { force: true }); }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, options.signal, { awaitCancelledTaskDrain: options.awaitCancelledTaskDrain });
}
