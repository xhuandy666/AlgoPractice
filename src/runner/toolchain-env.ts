import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess, type ToolchainProcessEnvironment } from './process.ts';
import { defaultRuntimePath, runtimeStorageRoot } from './runtime-paths.ts';
import type { RuntimeInspection } from './runtime-inspect.ts';

export type CompiledLanguage = 'go' | 'cpp';
export interface CompilationProfile { executable: string; argsPrefix: string[]; env: ToolchainProcessEnvironment; profileRoot: string; profileId: string; }
export interface CompilationPreparationOptions { cwd: string; root?: string; signal?: AbortSignal; }
export function cppTarget(platform = process.platform, architecture = process.arch): string {
  if (platform === 'darwin' && architecture === 'arm64') return 'aarch64-macos.14.0-none';
  if (platform === 'darwin' && architecture === 'x64') return 'x86_64-macos.14.0-none';
  if (platform === 'win32' && architecture === 'x64') return 'x86_64-windows-gnu';
  throw new Error('C++ toolchain target is not supported on this host.');
}
export function cppProfileArguments(kind: NonNullable<RuntimeInspection['compilerKind']>): string[] {
  const common = ['-std=c++17', '-O0', '-fno-color-diagnostics'];
  if (kind === 'zig') return ['c++', '-target', cppTarget(), ...common, '-Wno-nullability-completeness', '-Wno-nullability-completeness-on-arrays'];
  return kind === 'gcc' ? ['-std=c++17', '-O0', '-fdiagnostics-color=never'] : common;
}
const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const noLink = async (directory: string) => { if ((await lstat(directory)).isSymbolicLink()) throw new Error('Toolchain cache must not traverse a symbolic link.'); };
async function privateDirectory(base: string, directory: string): Promise<void> {
  if (!inside(base, directory)) throw new Error('Refused an external toolchain configuration directory.');
  let current = base;
  for (const segment of path.relative(base, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); await mkdir(current, { recursive: true }); await noLink(current);
  }
}

/** The same host-owned profile is used by environment setup and real user compilation. */
export async function prepareCompilation(language: CompiledLanguage, inspection: RuntimeInspection, options: CompilationPreparationOptions): Promise<CompilationProfile> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Toolchain preparation cancelled');
  const executable = await realpath(inspection.executable), executableInfo = await stat(executable);
  const argsPrefix = language === 'go' ? ['build', '-trimpath', '-buildvcs=false'] : cppProfileArguments(inspection.compilerKind ?? 'zig');
  const profileId = createHash('sha256').update(JSON.stringify([1, language, executable, executableInfo.size, executableInfo.mtimeMs, inspection.version, inspection.compilerKind, process.platform, process.arch, argsPrefix])).digest('hex');
  const root = runtimeStorageRoot(options.root); await mkdir(root, { recursive: true }); await noLink(root);
  const managed = path.resolve(inspection.executable) === path.resolve(defaultRuntimePath(language, root));
  const base = managed ? path.join(root, language, '.algopractice-cache') : path.join(root, '.toolchain-cache', language);
  // Only app-private bytes are written, never a selected system installation.
  if (managed) await noLink(path.join(root, language));
  else { await mkdir(path.join(root, '.toolchain-cache'), { recursive: true }); await noLink(path.join(root, '.toolchain-cache')); }
  await mkdir(base, { recursive: true }); await noLink(base);
  const marker = path.join(base, '.algopractice-toolchain-cache.json');
  try { const markerInfo = await lstat(marker); if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 16384) throw new Error('Invalid toolchain cache marker was preserved.'); const existing = JSON.parse(await readFile(marker, 'utf8')); if (existing.schema !== 1 || existing.language !== language) throw new Error('Unowned toolchain cache was preserved.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await writeFile(marker, JSON.stringify({ schema: 1, language }), { flag: 'wx', mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); }
  const profileRoot = path.join(base, profileId); await mkdir(profileRoot, { recursive: true }); await noLink(profileRoot);
  if (!inside(await realpath(root), await realpath(profileRoot))) throw new Error('Toolchain cache escaped the app runtime root.');
  const env: ToolchainProcessEnvironment = {
    HOME: path.join(profileRoot, 'home'), USERPROFILE: path.join(profileRoot, 'home'), APPDATA: path.join(profileRoot, 'config'),
    LOCALAPPDATA: path.join(profileRoot, 'local'), XDG_CONFIG_HOME: path.join(profileRoot, 'config'), XDG_CACHE_HOME: path.join(profileRoot, 'cache'),
  };
  if (language === 'go') Object.assign(env, {
    GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOPROXY: 'off', GOSUMDB: 'off', GOVCS: '*:off', CGO_ENABLED: '0', GO111MODULE: 'off',
    GOOS: process.platform === 'win32' ? 'windows' : process.platform, GOARCH: process.arch === 'x64' ? 'amd64' : process.arch,
    GOCACHE: path.join(profileRoot, 'go-build'), GOPATH: path.join(profileRoot, 'go-path'), GOMODCACHE: path.join(profileRoot, 'go-modules'),
  });
  else if (inspection.compilerKind === 'zig') Object.assign(env, {
    ZIG_GLOBAL_CACHE_DIR: path.join(profileRoot, 'zig-global'), ZIG_LOCAL_CACHE_DIR: path.join(profileRoot, 'zig-local'),
    ZIG_LIB_DIR: path.join(path.dirname(executable), 'lib'),
    DEVELOPER_DIR: path.join(profileRoot, 'no-apple-developer-tools'), SDKROOT: path.join(profileRoot, 'no-apple-sdk'),
  });
  for (const [key, value] of Object.entries(env)) if (!['GOTOOLCHAIN', 'GOENV', 'GOWORK', 'GOPROXY', 'GOSUMDB', 'GOVCS', 'CGO_ENABLED', 'GO111MODULE', 'GOOS', 'GOARCH', 'DEVELOPER_DIR', 'SDKROOT', 'ZIG_LIB_DIR'].includes(key)) await privateDirectory(profileRoot, value!);
  if (language === 'go') {
    const telemetry = process.platform === 'darwin' ? path.join(env.HOME!, 'Library', 'Application Support', 'go', 'telemetry') : path.join(process.platform === 'win32' ? env.APPDATA! : env.XDG_CONFIG_HOME!, 'go', 'telemetry');
    await privateDirectory(profileRoot, telemetry);
    const processOptions = { cwd: options.cwd, env, timeoutMs: 10000, outputLimitBytes: 16384, signal: options.signal };
    let verification = await runProcess(executable, ['env', 'GOTELEMETRY'], processOptions);
    if (!verification.reason && verification.code === 0 && verification.stdout.trim() !== 'off') {
      const setting = await runProcess(executable, ['telemetry', 'off'], processOptions);
      if (setting.reason || setting.code !== 0) throw new Error(`Private Go telemetry setup failed: ${setting.reason ?? setting.stderr}`);
      verification = await runProcess(executable, ['env', 'GOTELEMETRY'], processOptions);
    }
    if (verification.reason || verification.code !== 0 || verification.stdout.trim() !== 'off') throw new Error('Private Go telemetry could not be verified disabled.');
  }
  return { executable, argsPrefix, env, profileRoot, profileId };
}
