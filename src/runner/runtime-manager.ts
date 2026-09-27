import { lstat, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { installRuntime, runtimeManifest, type InstallProgress } from './managed-runtime.ts';
import { resolveRuntime, type DiscoveryOptions, type RuntimeResolution } from './runtime-discovery.ts';
import type { Language } from './types.ts';

export type RuntimeTaskPhase = 'idle' | InstallProgress['phase'] | 'cancelled' | 'error' | 'uninstalling';
export interface RuntimeTaskState {
  language: Language; phase: RuntimeTaskPhase; busy: boolean;
  progress?: InstallProgress; error?: string; startedAt?: string;
}
export interface RuntimeArtifactDetails {
  supported: boolean; target: string; version: string; source: string | null;
  downloadBytes: number | null; expandedBytes: null; peakBytes: null;
}
export interface ManagedRuntimeDetails {
  present: boolean; owned: boolean; directory: string; version?: string; source?: string; installedAt?: string;
  /** Logical and allocated sizes count symlinks themselves, never their external targets. */
  logicalBytes: number | null; diskBytes: number | null; sizeError?: string; canUninstall: boolean;
}
export interface RuntimeDetails {
  language: Language; artifact: RuntimeArtifactDetails; managed: ManagedRuntimeDetails;
  task: RuntimeTaskState; references: { run: number; pending: number };
}
interface Marker { schema: 1; installationId: string; language: Language; target: string; version: string; sha256: string; source: string; installedAt: string; }
type Installed = Awaited<ReturnType<typeof installRuntime>>;
interface ManagerOptions {
  root: string; onState?: (state: RuntimeTaskState) => void;
  /** Host-only injection for tests. Production always uses the verified installer. */
  installer?: typeof installRuntime; resolver?: typeof resolveRuntime; now?: () => number;
}
const languages: Language[] = ['python', 'java'];
const markerName = '.algopractice-runtime.json';
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function validateLanguage(language: Language): void { if (!languages.includes(language)) throw new Error('Unsupported language'); }
function artifactDetails(language: Language): RuntimeArtifactDetails {
  const target = `${process.platform}-${process.arch}`, family = runtimeManifest[language];
  const artifact = family.targets[target as keyof typeof family.targets];
  return { supported: !!artifact, target, version: family.version, source: artifact?.url ?? null, downloadBytes: artifact?.size ?? null, expandedBytes: null, peakBytes: null };
}
async function ownedMarker(root: string, language: Language): Promise<Marker | undefined> {
  const directory = path.join(root, language), markerPath = path.join(directory, markerName);
  try {
    const directoryInfo = await lstat(directory), markerInfo = await lstat(markerPath);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 16384) return undefined;
    if (path.dirname(await realpath(directory)) !== await realpath(root)) return undefined;
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Marker;
    if (marker.schema !== 1 || marker.language !== language || !/^[a-f0-9-]{36}$/.test(marker.installationId) || !/^[a-f0-9]{64}$/.test(marker.sha256)
      || !['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(marker.target) || typeof marker.version !== 'string' || typeof marker.source !== 'string' || typeof marker.installedAt !== 'string') return undefined;
    return marker;
  } catch (error) { if (isMissing(error) || error instanceof SyntaxError) return undefined; throw error; }
}
async function directorySize(directory: string): Promise<{ logicalBytes: number; diskBytes: number }> {
  let logicalBytes = 0, diskBytes = 0, count = 0;
  const pending = [directory], inodes = new Set<string>(), deadline = Date.now() + 10000;
  while (pending.length) {
    if (++count > 150000 || Date.now() > deadline) throw new Error('Runtime size measurement exceeded its bounded budget; size is unknown.');
    const file = pending.pop()!, info = await lstat(file), key = `${info.dev}:${info.ino}`;
    // A runtime can contain hard links; count their allocation only once.
    if (info.ino !== 0 && inodes.has(key)) continue;
    if (info.ino !== 0) inodes.add(key);
    logicalBytes += info.size; diskBytes += typeof info.blocks === 'number' ? info.blocks * 512 : info.size;
    if (info.isDirectory() && !info.isSymbolicLink()) for (const name of await readdir(file)) pending.push(path.join(file, name));
  }
  return { logicalBytes, diskBytes };
}

/** Host-owned runtime lifecycle. Detection never downloads and pending intentions are not executable jobs. */
export class RuntimeManager {
  readonly root: string;
  private readonly options: ManagerOptions;
  private tasks = new Map<Language, { promise: Promise<Installed>; controller: AbortController; archive?: string }>();
  private removals = new Set<Promise<void>>();
  private taskStates = new Map<Language, RuntimeTaskState>();
  private refs = new Map<Language, { run: number; pending: number }>();
  private detailCache = new Map<Language, { at: number; details: ManagedRuntimeDetails }>();
  private progressNotifications = new Map<Language, { phase: InstallProgress['phase']; at: number }>();
  constructor(options: ManagerOptions) {
    this.root = path.resolve(options.root); this.options = options;
    for (const language of languages) { this.taskStates.set(language, { language, phase: 'idle', busy: false }); this.refs.set(language, { run: 0, pending: 0 }); }
  }
  state(language: Language): RuntimeTaskState { validateLanguage(language); return structuredClone(this.taskStates.get(language)!); }
  states(): RuntimeTaskState[] { return languages.map(language => this.state(language)); }
  get busy(): boolean { return this.states().some(state => state.busy); }
  get pendingPromises(): Promise<unknown>[] { return [...[...this.tasks.values()].map(task => task.promise), ...this.removals]; }
  private emit(language: Language, update: Partial<RuntimeTaskState>, notify = true): void {
    const state = { ...this.taskStates.get(language)!, ...update }; this.taskStates.set(language, state);
    if (notify) try { this.options.onState?.(structuredClone(state)); } catch { /* Observers cannot change lifecycle transactions. */ }
  }
  private progress(language: Language, progress: InstallProgress): void {
    const previous = this.progressNotifications.get(language), at = (this.options.now ?? Date.now)();
    const notify = !previous || previous.phase !== progress.phase || at - previous.at >= 200 || (progress.totalBytes > 0 && progress.receivedBytes >= progress.totalBytes);
    // Keep polling state current even while suppressing byte-level IPC floods. Every phase transition is immediate.
    this.emit(language, { phase: progress.phase, progress }, notify);
    if (notify) this.progressNotifications.set(language, { phase: progress.phase, at });
  }
  invalidate(language?: Language): void { if (language) this.detailCache.delete(language); else this.detailCache.clear(); }
  inspect(language: Language, options: Omit<DiscoveryOptions, 'root'> = {}): Promise<RuntimeResolution> {
    validateLanguage(language); return (this.options.resolver ?? resolveRuntime)(language, { ...options, root: this.root });
  }
  retain(language: Language, reason: 'run' | 'pending'): () => void {
    validateLanguage(language);
    if (this.state(language).phase === 'uninstalling' || (reason === 'run' && this.state(language).busy)) throw new Error('This language environment is being changed; wait for it to finish.');
    this.refs.get(language)![reason]++;
    let released = false;
    return () => { if (!released) { released = true; this.refs.get(language)![reason]--; } };
  }
  install(language: Language, options: { localArchive?: string } = {}): Promise<Installed> {
    validateLanguage(language);
    const active = this.tasks.get(language), archive = options.localArchive ? path.resolve(options.localArchive) : undefined;
    if (active) {
      if (active.archive !== archive) return Promise.reject(new Error('A different installation source is already in progress for this language.'));
      return active.promise;
    }
    if (this.refs.get(language)!.run || this.state(language).busy) return Promise.reject(new Error('This language is in use; its environment cannot be changed now.'));
    const controller = new AbortController();
    this.progressNotifications.delete(language);
    this.emit(language, { phase: archive ? 'copy' : 'download', busy: true, progress: undefined, error: undefined, startedAt: new Date().toISOString() });
    // Schedule after the single-flight slot is recorded, including synchronous test installers.
    const promise = Promise.resolve().then(() => (this.options.installer ?? installRuntime)(language, {
      root: this.root, localArchive: archive, signal: controller.signal,
      onProgress: progress => this.progress(language, progress),
    })).then(result => { this.emit(language, { phase: 'ready', busy: false }); return result; }, error => {
      this.emit(language, { phase: controller.signal.aborted ? 'cancelled' : 'error', busy: false, error: error instanceof Error ? error.message : String(error) }); throw error;
    }).finally(() => { this.tasks.delete(language); this.invalidate(language); });
    this.tasks.set(language, { promise, controller, archive }); return promise;
  }
  cancel(language: Language): boolean {
    validateLanguage(language); const task = this.tasks.get(language); if (!task) return false;
    task.controller.abort(new Error('Runtime installation cancelled by user')); return true;
  }
  cancelAll(): void { for (const language of languages) this.cancel(language); }
  async details(language: Language, refresh = false): Promise<RuntimeDetails> {
    validateLanguage(language); let cached = this.detailCache.get(language);
    if (refresh || !cached || Date.now() - cached.at > 30000) {
      const directory = path.join(this.root, language);
      const managed: ManagedRuntimeDetails = { present: false, owned: false, directory, logicalBytes: null, diskBytes: null, canUninstall: false };
      try { managed.present = !!await lstat(directory); } catch (error) { if (!isMissing(error)) managed.sizeError = String(error); }
      try {
        const marker = await ownedMarker(this.root, language);
        if (marker) { Object.assign(managed, { owned: true, version: marker.version, source: marker.source, installedAt: marker.installedAt }); Object.assign(managed, await directorySize(directory)); }
      } catch (error) { managed.sizeError = error instanceof Error ? error.message : String(error); }
      cached = { at: Date.now(), details: managed }; this.detailCache.set(language, cached);
    }
    const refs = this.refs.get(language)!, task = this.state(language), managed = { ...cached.details };
    managed.canUninstall = managed.owned && !task.busy && refs.run === 0 && refs.pending === 0;
    return { language, artifact: artifactDetails(language), managed, task, references: { ...refs } };
  }
  /** Caller must obtain user confirmation. Only a marked, direct child of this app's managed root may be removed. */
  async uninstall(language: Language): Promise<void> {
    const operation = this.uninstallOwned(language); this.removals.add(operation);
    try { await operation; } finally { this.removals.delete(operation); }
  }
  private async uninstallOwned(language: Language): Promise<void> {
    validateLanguage(language);
    const refs = this.refs.get(language)!;
    if (this.state(language).busy || refs.run || refs.pending) throw new Error('Runtime is referenced by an active run, pending request or installation; it cannot be uninstalled.');
    this.emit(language, { phase: 'uninstalling', busy: true, error: undefined });
    const directory = path.join(this.root, language), retired = path.join(this.root, `.${language}-uninstall-${randomUUID()}`);
    const lockPath = path.join(this.root, `.${language}-install.lock`); let ownsLock = false;
    try {
      for (const name of [`.${language}-install.lock`, `.${language}-install.json`]) {
        try { await lstat(path.join(this.root, name)); throw new Error('Installation recovery or another installer is pending; runtime was preserved.'); } catch (error) { if (!isMissing(error)) throw error; }
      }
      const lock = await open(lockPath, 'wx', 0o600); ownsLock = true;
      try { await lock.writeFile(JSON.stringify({ pid: process.pid, purpose: 'uninstall' })); await lock.sync(); } finally { await lock.close(); }
      if (!await ownedMarker(this.root, language)) throw new Error('Refusing to uninstall an unowned, symbolic-linked or invalid runtime directory.');
      // Renaming the exact validated directory removes it from selection before deleting app-owned bytes.
      await rename(directory, retired);
      try { await rm(retired, { recursive: true }); }
      catch (error) { throw new Error(`Runtime was detached but cleanup failed; preserved remainder at ${retired}: ${String(error)}`); }
      this.emit(language, { phase: 'idle', busy: false, progress: undefined });
    } catch (error) { this.emit(language, { phase: 'error', busy: false, error: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { if (ownsLock) await rm(lockPath, { force: true }); this.invalidate(language); }
  }
}
