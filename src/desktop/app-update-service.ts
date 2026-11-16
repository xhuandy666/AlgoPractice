import type { AppUpdateState } from '../shared/update';
import { compareVersions, latestRelease } from './update-check';
import { downloadInstaller, releaseInstaller, verifyInstaller, type UpdateFetch, type UpdateInstaller } from './update-installer';

export const UPDATE_START_DELAY_MS = 30_000;
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export interface NativeUpdateEngine {
  check(signal: AbortSignal): Promise<string | null>;
  download(version: string, signal: AbortSignal): Promise<void>;
  verify(): Promise<void>;
  install(): Promise<void>;
  observe(callbacks: { progress(transferred: number, total: number): void; downloaded(version: string): void; error(): void }): () => void;
}
export interface AppUpdateOptions {
  version: string; platform: string; arch: string; mode: AppUpdateState['mode']; directory: string;
  automatic: boolean; fetch: UpdateFetch; native?: NativeUpdateEngine;
  persistAutomatic(enabled: boolean): void;
  changed(state: AppUpdateState): void;
  /** Flush drafts and drain services before executing the install action. Rejection leaves the app usable. */
  install(action: () => void | Promise<void>): Promise<void>;
  openInstaller(path: string): Promise<void>;
  installationBlocker(): string | null;
  now?(): Date;
  schedule?(callback: () => void, delayMs: number): () => void;
}
const schedule = (callback: () => void, delayMs: number) => { const timer = setTimeout(callback, delayMs); timer.unref(); return () => clearTimeout(timer); };

/** One process owns discovery, download and install. Rendering a page never starts an update check. */
export class AppUpdateService {
  #state: AppUpdateState;
  #candidate: { version: string; asset: UpdateInstaller | null } | null = null;
  #file: string | null = null;
  #checkTask: Promise<AppUpdateState> | null = null;
  #downloadTask: Promise<AppUpdateState> | null = null;
  #installTask: Promise<void> | null = null;
  #checkAbort: AbortController | null = null;
  #downloadAbort: AbortController | null = null;
  #cancelTimer: (() => void) | null = null;
  #removeNative: (() => void) | null = null;
  #stopped = false;
  #started = false;
  #lastProgressAt = 0;
  constructor(private readonly options: AppUpdateOptions) {
    this.#state = { currentVersion: options.version, latestVersion: null, mode: options.mode, automatic: options.automatic,
      phase: ['development', 'unsupported'].includes(options.mode) ? 'disabled' : 'idle', checkedAt: null, publishedAt: null,
      releaseUrl: null, progress: null, error: null };
    this.#removeNative = options.native?.observe({
      progress: (done, total) => this.#progress(done, total),
      downloaded: version => { if (!this.#stopped && this.#candidate?.version === version && this.#state.phase === 'downloading') this.#set({ phase: 'downloaded', error: null }); },
      error: () => { /* The owning check/download promise reports a fixed public error; do not expose updater errors. */ },
    }) ?? null;
  }
  state(): AppUpdateState { return structuredClone(this.#state); }
  #set(patch: Partial<AppUpdateState>) {
    if (this.#stopped) return;
    this.#state = { ...this.#state, ...patch }; this.options.changed(this.state());
  }
  start() { if (this.#started || this.#stopped) return; this.#started = true; this.#arm(UPDATE_START_DELAY_MS); }
  #arm(delay: number) {
    this.#cancelTimer?.(); this.#cancelTimer = null;
    if (!this.#started || this.#stopped || !this.#state.automatic || ['development', 'unsupported'].includes(this.#state.mode)) return;
    this.#cancelTimer = (this.options.schedule ?? schedule)(() => {
      this.#cancelTimer = null;
      void this.check(true).finally(() => this.#arm(UPDATE_INTERVAL_MS));
    }, delay);
  }
  setAutomatic(enabled: boolean): AppUpdateState {
    if (typeof enabled !== 'boolean') throw new Error('自动更新设置无效。');
    this.options.persistAutomatic(enabled);
    this.#set({ automatic: enabled });
    // Download cancellation is deliberately separate from quitting or installing an already verified update.
    if (!enabled) {
      this.#cancelTimer?.(); this.#cancelTimer = null;
      this.#checkAbort?.abort(); this.#downloadAbort?.abort();
      if (['checking', 'downloading'].includes(this.#state.phase)) this.#set({ phase: this.#candidate ? 'available' : 'idle', progress: null });
    }
    else this.#arm(UPDATE_START_DELAY_MS);
    return this.state();
  }
  check(background = false): Promise<AppUpdateState> {
    if (background && !this.#state.automatic) return Promise.resolve(this.state());
    if (this.#checkTask) return this.#checkTask;
    if (this.#stopped || ['downloading', 'downloaded', 'installing'].includes(this.#state.phase)) return Promise.resolve(this.state());
    const controller = new AbortController(); this.#checkAbort = controller;
    this.#candidate = null; this.#file = null;
    this.#set({ phase: 'checking', latestVersion: null, releaseUrl: null, publishedAt: null, error: null, progress: null });
    const task = (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
        const release = await latestRelease(this.options.fetch, signal);
        signal.throwIfAborted();
        const version = (release.tag_name as string).replace(/^v/, '');
        const newer = compareVersions(version, this.options.version) === 1;
        this.#set({ latestVersion: version, releaseUrl: release.html_url as string,
          publishedAt: typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)) ? release.published_at : null,
          checkedAt: (this.options.now?.() ?? new Date()).toISOString() });
        if (!newer) { this.#candidate = null; this.#file = null; this.#set({ phase: 'up-to-date' }); return this.state(); }
        const asset = this.#state.mode === 'installer' ? releaseInstaller(release, this.options.platform, this.options.arch) : null;
        if (this.#state.mode === 'native') {
          const nativeVersion = await this.options.native!.check(signal);
          if (nativeVersion !== version) throw new Error('版本发布信息正在更新，请稍后重试。');
        }
        signal.throwIfAborted();
        if (this.#candidate?.version !== version) this.#file = null;
        this.#candidate = { version, asset }; this.#set({ phase: 'available' });
        if (this.#state.automatic && !['development', 'unsupported'].includes(this.#state.mode)) return await this.download();
      } catch {
        if (!controller.signal.aborted) this.#set({ phase: 'error', latestVersion: null, error: '无法检查更新，请检查网络或代理后重试。' });
      }
      return this.state();
    })();
    this.#checkTask = task;
    void task.finally(() => { if (this.#checkTask === task) this.#checkTask = null; if (this.#checkAbort === controller) this.#checkAbort = null; });
    return task;
  }
  #progress(transferred: number, total: number) {
    if (this.#state.phase !== 'downloading' || !Number.isFinite(transferred) || !Number.isFinite(total) || total <= 0) return;
    const now = Date.now(); if (transferred < total && now - this.#lastProgressAt < 100) return;
    this.#lastProgressAt = now;
    const done = Math.max(0, Math.min(total, transferred));
    this.#set({ progress: { transferred: done, total, percent: Math.floor(done / total * 100) } });
  }
  download(): Promise<AppUpdateState> {
    if (this.#downloadTask) return this.#downloadTask;
    if (this.#stopped || this.#state.phase === 'downloaded' || this.#state.phase === 'installing') return Promise.resolve(this.state());
    if (!this.#candidate || ['development', 'unsupported'].includes(this.#state.mode)) return Promise.resolve(this.state());
    const candidate = this.#candidate, controller = new AbortController(); this.#downloadAbort = controller;
    this.#set({ phase: 'downloading', error: null, progress: null });
    const task = (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]);
        if (this.#state.mode === 'native') await this.options.native!.download(candidate.version, signal);
        else {
          if (!candidate.asset) throw new Error('安装包不可用。');
          this.#file = await downloadInstaller(candidate.asset, this.options.directory, this.options.fetch, (done, total) => this.#progress(done, total), signal);
          signal.throwIfAborted(); this.#set({ phase: 'downloaded', error: null });
        }
      } catch { if (!controller.signal.aborted) this.#set({ phase: 'error', error: '更新下载或校验失败，请检查网络后重新下载。', progress: null }); }
      return this.state();
    })();
    this.#downloadTask = task;
    void task.finally(() => { if (this.#downloadTask === task) this.#downloadTask = null; if (this.#downloadAbort === controller) this.#downloadAbort = null; });
    return task;
  }
  install(): Promise<void> {
    if (this.#installTask) return this.#installTask;
    if (this.#stopped || this.#state.phase !== 'downloaded' || !this.#candidate) return Promise.reject(new Error('请先完成更新下载。'));
    const blocker = this.options.installationBlocker(); if (blocker) return Promise.reject(new Error(blocker));
    const candidate = this.#candidate, file = this.#file;
    this.#set({ phase: 'installing', error: null });
    const task = (async () => {
      try {
        if (this.#state.mode === 'installer') await this.#verify(file, candidate.asset);
        else await this.options.native!.verify();
        await this.options.install(async () => {
          if (this.#state.mode === 'native') await this.options.native!.install();
          else {
            await this.#verify(file, candidate.asset);
            await this.options.openInstaller(file!);
          }
        });
      } catch (error) {
        const invalidNativeCache = (error as { code?: unknown } | null)?.code === 'UPDATE_CACHE_INVALID';
        this.#set({ phase: invalidNativeCache || this.#state.mode === 'installer' && !this.#file ? 'available' : 'downloaded', error: '更新暂未安装。请确认草稿已保存、运行已结束后重试；若安装包不可用，请重新下载。' });
        throw new Error(this.#state.error ?? '更新暂未安装。');
      }
    })();
    this.#installTask = task; void task.finally(() => { if (this.#installTask === task) this.#installTask = null; }).catch(() => {});
    return task;
  }
  async #verify(file: string | null, asset: UpdateInstaller | null) {
    try { if (!file || !asset) throw new Error('安装包不可用。'); await verifyInstaller(file, asset); }
    catch (error) { this.#file = null; throw error; }
  }
  async stop() {
    this.#stopped = true; this.#cancelTimer?.(); this.#cancelTimer = null;
    this.#checkAbort?.abort(); this.#downloadAbort?.abort(); this.#removeNative?.(); this.#removeNative = null;
    await Promise.allSettled([this.#checkTask, this.#downloadTask]);
  }
}
