import { lstat, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultRuntimePath } from './runtime-paths.ts';
import { inspectRuntime, type RuntimeInspection } from './runtime-inspect.ts';
import type { Language } from './types.ts';

export type RuntimeSource = 'explicit' | 'managed' | 'system' | 'test-override' | 'none';
export interface RuntimeCandidate { executable: string; source: Exclude<RuntimeSource, 'none'>; inspection: RuntimeInspection; }
export interface RuntimeResolution extends RuntimeInspection {
  source: RuntimeSource;
  blockedByExplicit: boolean;
  candidates: RuntimeCandidate[];
}
export interface DiscoveryOptions {
  root: string; explicitPath?: string; testRoot?: string; signal?: AbortSignal;
  /** Injection points for deterministic discovery tests, never renderer input. */
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; cwd?: string;
  inspect?: typeof inspectRuntime;
}
const under = (parent: string, child: string, flavor = path) => { const relative = flavor.relative(flavor === path.win32 ? parent.toLowerCase() : parent, flavor === path.win32 ? child.toLowerCase() : child); return relative === '' || (!relative.startsWith(`..${flavor.sep}`) && relative !== '..' && !flavor.isAbsolute(relative)); };
function fromWorkingDirectory(candidate: string, cwd: string, home: string, p = path): boolean {
  // GUI apps may launch with / or the user's home as cwd; these are not project directories.
  const normalize = (value: string) => p === path.win32 ? p.normalize(value).toLowerCase() : p.normalize(value);
  const directory = normalize(cwd);
  return normalize(p.dirname(candidate)) === directory || (directory !== normalize(p.parse(cwd).root) && directory !== normalize(home) && under(cwd, candidate, p));
}

/** A finite, deterministic list: no shell, registry execution, py launcher or recursive disk search. */
export async function runtimeDiscoveryPaths(language: Language, options: Pick<DiscoveryOptions, 'platform' | 'env' | 'home' | 'cwd'> = {}): Promise<string[]> {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env;
  const home = options.home ?? os.homedir(), cwd = options.cwd ?? process.cwd();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const result: string[] = [], seen = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate || !p.isAbsolute(candidate)) return;
    const normalized = p.normalize(candidate), key = platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key) || fromWorkingDirectory(normalized, cwd, home, p)) return;
    // These OS launchers can open the Store or developer-tools installer instead of probing a runtime.
    if (platform === 'win32' && /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(normalized)) return;
    if (platform === 'darwin' && ['/usr/bin/python', '/usr/bin/python3', '/usr/bin/java', '/usr/bin/javac'].includes(normalized)) return;
    seen.add(key); result.push(normalized);
  };
  const children = async (directory: string, executable: (name: string) => string) => {
    if (!p.isAbsolute(directory) || fromWorkingDirectory(p.join(directory, 'candidate'), cwd, home, p)) return;
    try {
      // Only immediate children of known installation roots; cap even hostile or unusually large roots.
      const names = await readdir(directory, { withFileTypes: true });
      for (const item of names.filter(item => item.isDirectory() || item.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 24)) add(executable(item.name));
    } catch { /* A missing or inaccessible optional installation root is not an error. */ }
  };
  if (language === 'java' && env.JAVA_HOME) add(p.join(env.JAVA_HOME, 'bin', platform === 'win32' ? 'java.exe' : 'java'));
  if (platform === 'darwin') {
    if (language === 'python') {
      add('/Library/Frameworks/Python.framework/Versions/3.14/bin/python3');
      add('/opt/homebrew/opt/python@3.14/bin/python3.14'); add('/usr/local/opt/python@3.14/bin/python3.14');
      add('/opt/homebrew/bin/python3.14'); add('/usr/local/bin/python3.14');
    } else {
      for (const directory of ['/Library/Java/JavaVirtualMachines', p.join(home, 'Library/Java/JavaVirtualMachines')]) await children(directory, name => p.join(directory, name, 'Contents/Home/bin/java'));
      add('/opt/homebrew/opt/openjdk@25/bin/java'); add('/usr/local/opt/openjdk@25/bin/java');
    }
  } else if (platform === 'win32') {
    if (language === 'python') {
      if (env.LOCALAPPDATA) add(p.join(env.LOCALAPPDATA, 'Programs/Python/Python314/python.exe'));
      if (env.ProgramFiles) add(p.join(env.ProgramFiles, 'Python314/python.exe'));
    } else {
      for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']].filter((item): item is string => !!item)) {
        for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft']) {
          const directory = p.join(base, vendor); await children(directory, name => p.join(directory, name, 'bin/java.exe'));
        }
      }
    }
  }
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const directory of pathValue.split(platform === 'win32' ? ';' : ':').slice(0, 64)) {
    if (!p.isAbsolute(directory) || fromWorkingDirectory(p.join(directory, 'candidate'), cwd, home, p)) continue;
    const names = language === 'python' ? (platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3.14', 'python3']) : [platform === 'win32' ? 'java.exe' : 'java'];
    for (const name of names) add(p.join(directory, name));
  }
  return result.slice(0, 64);
}

export async function resolveRuntime(language: Language, options: DiscoveryOptions): Promise<RuntimeResolution> {
  const inspect = options.inspect ?? inspectRuntime, candidates: RuntimeCandidate[] = [];
  const inspected = new Set<string>();
  const finish = (inspection: RuntimeInspection, source: RuntimeSource, blockedByExplicit = false): RuntimeResolution => ({ ...inspection, source, blockedByExplicit, candidates });
  const probe = async (executable: string, source: RuntimeCandidate['source'], signal = options.signal) => {
    const inspection = await inspect(language, { runtimePath: executable, signal });
    candidates.push({ executable, source, inspection }); inspected.add(path.resolve(executable));
    return inspection;
  };
  // An explicit choice is never silently substituted, including by a test override.
  if (options.explicitPath) {
    const inspection = await probe(options.explicitPath, 'explicit');
    return finish(inspection, 'explicit', inspection.status !== 'ready');
  }
  if (options.testRoot) return finish(await probe(defaultRuntimePath(language, options.testRoot), 'test-override'), 'test-override');
  const managed = await probe(defaultRuntimePath(language, options.root), 'managed');
  if (managed.status === 'ready' || managed.status === 'cancelled') return finish(managed, 'managed');
  const projectDirectory = await realpath(options.cwd ?? process.cwd()).catch(() => path.resolve(options.cwd ?? process.cwd()));
  const homeDirectory = await realpath(options.home ?? os.homedir()).catch(() => options.home ?? os.homedir());
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(20000)]);
  let incompatible: RuntimeInspection | undefined;
  for (const executable of await runtimeDiscoveryPaths(language, options)) {
    if (signal.aborted) break;
    try {
      const resolved = await realpath(executable), info = await lstat(resolved);
      if (!info.isFile() || inspected.has(resolved) || fromWorkingDirectory(resolved, projectDirectory, homeDirectory)) continue;
      if (process.platform === 'darwin' && ['/usr/bin/python', '/usr/bin/python3', '/usr/bin/java', '/usr/bin/javac'].includes(resolved)) continue;
      if (process.platform === 'win32' && /[\\/]WindowsApps[\\/]/i.test(resolved)) continue;
      inspected.add(resolved);
    } catch { continue; }
    const inspection = await probe(executable, 'system', signal);
    if (inspection.status === 'ready') return finish(inspection, 'system');
    if (inspection.status === 'incompatible') incompatible ??= inspection;
  }
  if (options.signal?.aborted) return finish({ ...managed, status: 'cancelled', diagnostics: [{ phase: 'environment', source: 'runner', message: 'Runtime discovery cancelled.' }] }, 'none');
  if (signal.aborted) return finish({ ...managed, status: 'error', diagnostics: [{ phase: 'environment', source: 'runner', message: 'Runtime discovery reached its time limit; choose an installed executable or retry detection.' }] }, 'none');
  const failed = incompatible ?? managed;
  return finish(failed, 'none');
}
