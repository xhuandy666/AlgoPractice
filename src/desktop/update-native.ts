import { createHash } from 'node:crypto';
import { spawn, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

/** The public cache fields exposed by electron-updater's protected downloadedUpdateHelper. */
export interface NativeUpdateCache {
  readonly file: string | null;
  readonly downloadedFileInfo: { sha512: string } | null;
  clear(): Promise<void>;
}

/** Re-read the bytes, including same-process caches that electron-updater otherwise checks only for existence. */
export async function verifyNativeUpdateCache(cache: NativeUpdateCache | null): Promise<void> {
  try {
    const path = cache?.file, expected = cache?.downloadedFileInfo?.sha512;
    if (!path || !expected || Buffer.from(expected, 'base64').length !== 64 || Buffer.from(expected, 'base64').toString('base64') !== expected) throw new Error('Missing update cache');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error('Invalid update cache');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash('sha512');
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw new Error('Changed update cache');
      const buffer = Buffer.alloc(65_536);
      for (;;) { const { bytesRead } = await file.read(buffer); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
      if (hash.digest('base64') !== expected) throw new Error('Damaged update cache');
    } finally { await file.close(); }
  } catch {
    await cache?.clear().catch(() => {});
    throw Object.assign(new Error('已下载的更新校验失败，请重新下载。'), { code: 'UPDATE_CACHE_INVALID' });
  }
}

/** A child PID can exist before an asynchronous spawn error. Only the spawn event acknowledges launch. */
export function spawnInstaller(command: string, args: string[], options: SpawnOptions, launched: () => void, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, options);
    let settled = false;
    const removeAbort = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return; settled = true; removeAbort(); child.kill();
      reject(signal?.reason ?? new Error('更新安装已取消。'));
    };
    child.once('error', error => { if (!settled) { settled = true; removeAbort(); reject(error); } });
    child.once('spawn', () => {
      child.unref();
      if (settled) { child.kill(); return; }
      settled = true; removeAbort(); launched(); resolve(true);
    });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

type Remove = () => void;
export interface InstallerLaunchControl {
  onError(callback: () => void): Remove;
  onLaunched(callback: () => void): Remove;
  start(): boolean;
  reset(): void;
}

/** NSIS install() returns before spawn finishes and reports failures as events rather than throwing. */
export async function waitForInstallerLaunch(control: InstallerLaunchControl, timeoutMs = 15_000): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); removeError(); removeLaunched();
        if (error) reject(error); else resolve();
      };
      const removeError = control.onError(() => finish(new Error('无法启动更新安装程序，请稍后重试。')));
      const removeLaunched = control.onLaunched(() => finish());
      const timer = setTimeout(() => finish(new Error('等待更新安装程序启动超时，请稍后重试。')), timeoutMs);
      try { if (!control.start()) finish(new Error('更新安装程序尚未准备好，请重新下载或重试。')); }
      catch { finish(new Error('无法启动更新安装程序，请稍后重试。')); }
    });
  } catch (error) { control.reset(); throw error; }
}

export interface MacInstallControl {
  onError(callback: () => void): Remove;
  onDownloaded(callback: () => void): Remove;
  onBeforeQuit(callback: () => void): Remove;
  check(): void;
  quitAndInstall(): void;
}

/** Squirrel still performs its signature verification. Unlike MacUpdater.quitAndInstall(), this wait is removable. */
export function waitForMacInstall(control: MacInstallControl, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false, quitting = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); removeError(); removeDownloaded(); removeBeforeQuit();
      if (error) reject(error); else resolve();
    };
    const removeError = control.onError(() => finish(new Error('系统未能验证或安装更新，请稍后重试。')));
    const removeDownloaded = control.onDownloaded(() => {
      if (settled || quitting) return; quitting = true;
      try { control.quitAndInstall(); } catch { finish(new Error('无法重启并安装更新，请稍后重试。')); }
    });
    const removeBeforeQuit = control.onBeforeQuit(() => { if (quitting) finish(); });
    const timer = setTimeout(() => finish(new Error('等待系统验证或重启更新超时，请稍后重试。')), timeoutMs);
    try { control.check(); } catch { finish(new Error('系统未能检查已下载的更新，请稍后重试。')); }
  });
}
