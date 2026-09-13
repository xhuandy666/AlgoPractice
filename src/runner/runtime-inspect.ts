import { access } from 'node:fs/promises';
import os from 'node:os';
import { runProcess } from './process.ts';
import { compilerPath, defaultRuntimePath } from './runtime-paths.ts';
import type { Diagnostic, Language } from './types.ts';

export interface RuntimeInspection {
  language: Language; status: 'ready' | 'missing' | 'incompatible' | 'cancelled' | 'error';
  executable: string; compilerPath?: string; runtimeVersion: string; version?: string; compilerVersion?: string;
  diagnostics: Diagnostic[];
}
export async function inspectRuntime(language: Language, options: { root?: string; runtimePath?: string; signal?: AbortSignal } = {}): Promise<RuntimeInspection> {
  const executable = options.runtimePath ?? defaultRuntimePath(language, options.root);
  const out: RuntimeInspection = { language, executable, status: 'error', runtimeVersion: '', diagnostics: [] };
  const fail = (status: RuntimeInspection['status'], message: string) => { out.status = status; out.diagnostics.push({ phase: 'environment', source: 'runner', message }); return out; };
  if (options.signal?.aborted) return fail('cancelled', 'Runtime inspection cancelled');
  if (language !== 'python' && language !== 'java') return fail('incompatible', 'Unsupported language');
  if (language === 'java') out.compilerPath = compilerPath(executable);
  try { await access(executable); if (out.compilerPath) await access(out.compilerPath); }
  catch { return fail('missing', 'Interpreter or matching javac is unavailable; select a full runtime installation.'); }
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
