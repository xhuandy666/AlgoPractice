import { access, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from './process.ts';
import { compilerPath, defaultRuntimePath, sameRuntimePath } from './runtime-paths.ts';
import { isLanguage } from '../shared/languages.ts';
import { ensureToolchainReady } from './toolchain-prewarm.ts';
import type { Diagnostic, Language } from './types.ts';

export interface RuntimeInspection {
  language: Language; status: 'ready' | 'missing' | 'incompatible' | 'cancelled' | 'error';
  executable: string; compilerPath?: string; runtimeVersion: string; version?: string; compilerVersion?: string;
  diagnostics: Diagnostic[];
  compilerKind?: 'zig' | 'clang' | 'gcc';
}
const inspectionCache = new Map<string, { at: number; inspection: RuntimeInspection }>();
export function invalidateRuntimeInspection(language?: Language): void { for (const key of inspectionCache.keys()) if (!language || key.startsWith(`${language}:`)) inspectionCache.delete(key); }
export async function inspectRuntime(language: Language, options: { root?: string; runtimePath?: string; signal?: AbortSignal; /** Installer's version-only staging validation; never renderer input. */ prepare?: boolean } = {}): Promise<RuntimeInspection> {
  const executable = options.runtimePath ?? defaultRuntimePath(language, options.root);
  const out: RuntimeInspection = { language, executable, status: 'error', runtimeVersion: '', diagnostics: [] };
  const fail = (status: RuntimeInspection['status'], message: string) => { out.status = status; out.diagnostics.push({ phase: 'environment', source: 'runner', message }); return out; };
  if (options.signal?.aborted) return fail('cancelled', 'Runtime inspection cancelled');
  if (!isLanguage(language)) return fail('incompatible', 'Unsupported language');
  if (!path.isAbsolute(executable)) return fail('incompatible', 'Choose an absolute path to a runtime executable.');
  if (language === 'java') out.compilerPath = compilerPath(executable);
  try {
    for (const candidate of [executable, ...(out.compilerPath ? [out.compilerPath] : [])]) {
      const resolved = await realpath(candidate);
      if (process.platform === 'darwin' && ['/usr/bin/python', '/usr/bin/python3', '/usr/bin/java', '/usr/bin/javac', '/usr/bin/clang', '/usr/bin/clang++', '/usr/bin/g++', '/usr/bin/gcc', '/usr/bin/c++'].includes(resolved)) return fail('incompatible', 'The system developer-tools launcher is not a reusable runtime; select an installed interpreter, full JDK or actual compiler installation.');
      if (process.platform === 'win32' && /[\\/]WindowsApps[\\/]/i.test(resolved)) return fail('incompatible', 'A Microsoft Store execution alias is not an installed runtime.');
      if (!(await stat(candidate)).isFile()) return fail('incompatible', 'Choose the runtime executable, not its containing directory.');
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    }
  } catch (error) {
    return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error', (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Interpreter or matching javac is unavailable; select a full runtime installation.' : `Runtime path is inaccessible: ${String(error)}`);
  }
  if (language === 'go' || language === 'cpp') {
    let probeDirectory: string | undefined;
    try {
      if (options.prepare !== false && sameRuntimePath(executable, defaultRuntimePath(language, options.root))) {
        try {
          const marker = JSON.parse(await readFile(path.join(language === 'go' ? path.dirname(path.dirname(executable)) : path.dirname(executable), '.algopractice-runtime.json'), 'utf8'));
          if (marker.warmState === 'pending') return fail('error', 'Language environment setup is incomplete; wait for installation recovery or reinstall it.');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      }
      const resolved = await realpath(executable), info = await stat(resolved);
      const cacheKey = `${language}:${JSON.stringify([resolved, info.size, info.mtimeMs, options.root, options.prepare !== false])}`;
      const cached = inspectionCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 30000) {
        // Version metadata can be cached; the required stdlib artifacts cannot.
        // A removed cache must be rebuilt with setup's budget, never the user's.
        if (options.prepare !== false) {
          probeDirectory = await mkdtemp(path.join(os.tmpdir(), 'algopractice-environment-'));
          await ensureToolchainReady(language, cached.inspection, { cwd: probeDirectory, root: options.root, signal: options.signal });
        }
        if (options.signal?.aborted) return fail('cancelled', 'Toolchain preparation cancelled');
        return structuredClone(cached.inspection);
      }
      probeDirectory = await mkdtemp(path.join(os.tmpdir(), 'algopractice-environment-'));
      const processOptions = { cwd: probeDirectory, timeoutMs: 10000, outputLimitBytes: 16384, signal: options.signal,
        ...(language === 'go' ? { env: { GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOPROXY: 'off', GOSUMDB: 'off', CGO_ENABLED: '0' } } : {}) };
      if (language === 'go') {
        const probe = await runProcess(executable, ['version'], processOptions);
        if (probe.reason === 'cancelled') return fail('cancelled', 'Runtime inspection cancelled');
        if (probe.reason || probe.code !== 0) return fail('error', `Go version probe failed: ${probe.reason ?? probe.stderr}`);
        out.runtimeVersion = probe.stdout.trim(); out.version = /^go version go(1\.27\.\d+)\s/.exec(out.runtimeVersion)?.[1];
        const native = `${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`;
        if (!out.version || !out.runtimeVersion.endsWith(` ${native}`)) return fail('incompatible', 'Go 1.27.x for this host architecture is required.');
      } else {
        let probe = await runProcess(executable, ['version'], processOptions);
        if (probe.reason === 'cancelled') return fail('cancelled', 'Compiler inspection cancelled');
        if (!probe.reason && probe.code === 0 && /^\d+\.\d+\.\d+\s*$/.test(probe.stdout)) {
          out.compilerKind = 'zig'; out.version = probe.stdout.trim(); out.runtimeVersion = `Zig ${out.version} · C++17`;
          if (!/^0\.16\.\d+$/.test(out.version)) return fail('incompatible', 'Zig 0.16.x is required for this verified C++17 profile.');
        } else {
          probe = await runProcess(executable, ['--version'], processOptions);
          if (probe.reason === 'cancelled') return fail('cancelled', 'Compiler inspection cancelled');
          if (probe.reason || probe.code !== 0) return fail('error', `Compiler version probe failed: ${probe.reason ?? probe.stderr}`);
          const text = (probe.stdout + probe.stderr).trim();
          const clang = /^(?:Apple )?clang version\s+(\d+(?:\.\d+)*)/m.exec(text), gcc = /^(?:[^\n]*g\+\+|[^\n]*gcc)[^\n]*?\s(\d+\.\d+(?:\.\d+)*)/im.exec(text);
          if (!clang && !gcc) return fail('incompatible', 'Select Zig 0.16.x, clang++ or g++ with a complete C++17 development environment.');
          out.compilerKind = clang ? 'clang' : 'gcc'; out.version = (clang ?? gcc)![1]; out.runtimeVersion = text.split(/\r?\n/)[0];
        }
        out.compilerPath = executable; out.compilerVersion = out.runtimeVersion;
      }
      if (options.prepare !== false) await ensureToolchainReady(language, out, { cwd: probeDirectory, root: options.root, signal: options.signal });
      if (options.signal?.aborted) return fail('cancelled', 'Toolchain preparation cancelled');
      out.status = 'ready'; inspectionCache.set(cacheKey, { at: Date.now(), inspection: structuredClone(out) }); return out;
    } catch (error) { return fail(options.signal?.aborted ? 'cancelled' : 'error', `Toolchain preparation failed: ${String(error)}`); }
    finally { if (probeDirectory) await rm(probeDirectory, { recursive: true, force: true }); }
  }
  const processOptions = { cwd: os.tmpdir(), timeoutMs: 10000, outputLimitBytes: 16384, signal: options.signal };
  const probe = await runProcess(executable, language === 'python'
    ? ['-I', '-X', 'utf8', '-c', 'import json,sys; print(json.dumps({"implementation":sys.implementation.name,"version":".".join(map(str,sys.version_info[:3]))}))']
    : ['--version'], processOptions);
  if (probe.reason === 'cancelled') return fail('cancelled', 'Runtime inspection cancelled');
  if (probe.reason || probe.code !== 0) return fail('error', `Runtime probe failed: ${probe.reason ?? probe.stderr}`);
  if (language === 'python') {
    try {
      const data = JSON.parse(probe.stdout);
      out.version = typeof data.version === 'string' ? data.version : '';
      out.runtimeVersion = `Python ${out.version}`;
      if (data.implementation !== 'cpython' || !/^3\.14\.\d+$/.test(out.version!)) return fail('incompatible', 'CPython 3.14.x is required; this executable has a different implementation or version.');
    } catch { return fail('incompatible', 'Python probe did not return the expected version metadata.'); }
  } else {
    out.runtimeVersion = (probe.stdout + probe.stderr).trim();
    out.version = /^openjdk\s+(25(?:\.\d+)*)(?:\s|\+)/.exec(out.runtimeVersion)?.[1];
    if (!out.version) return fail('incompatible', 'OpenJDK 25 is required.');
    const compiler = await runProcess(out.compilerPath!, ['--version'], processOptions);
    if (compiler.reason === 'cancelled') return fail('cancelled', 'Compiler inspection cancelled');
    out.compilerVersion = (compiler.stdout + compiler.stderr).trim();
    const compilerVersion = /^javac\s+(\d+(?:\.\d+)*)(?:\s|$)/.exec(out.compilerVersion)?.[1];
    if (compiler.reason || compiler.code !== 0 || compilerVersion !== out.version) return fail('incompatible', 'java and javac must both be available and have matching complete version numbers.');
  }
  out.status = 'ready'; return out;
}
