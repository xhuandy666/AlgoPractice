import { spawnSync } from 'node:child_process';
import type { StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { autoUpdater as systemUpdater } from 'electron';
import { MacUpdater, NsisUpdater } from 'electron-updater';
import type { AppUpdateState } from '../shared/update';
import type { NativeUpdateEngine } from './app-update-service';
import { spawnInstaller, verifyNativeUpdateCache, waitForInstallerLaunch, waitForMacInstall, type NativeUpdateCache } from './update-native';

/** Ad-hoc macOS bundles cannot use Squirrel's signature verification; they use a checked DMG instead. */
export function updateInstallMode(packaged: boolean, platform: string, arch: string, executable: string): AppUpdateState['mode'] {
  if (!packaged) return 'development';
  if (!['x64', 'arm64'].includes(arch)) return 'unsupported';
  if (platform === 'win32') return arch === 'x64' ? (existsSync(join(dirname(executable), 'Uninstall 题炼.exe')) ? 'native' : 'installer') : 'unsupported';
  if (platform !== 'darwin') return 'unsupported';
  const bundle = dirname(dirname(dirname(executable)));
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 });
  return result.status === 0 && /^TeamIdentifier=[A-Z0-9]{10}$/m.test(result.stderr ?? '') && /^Authority=Developer ID Application:/m.test(result.stderr ?? '') ? 'native' : 'installer';
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('更新已取消。'));
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

class VerifiedNsisUpdater extends NsisUpdater {
  #launched: (() => void) | null = null;
  #launchController: AbortController | null = null;
  cache(): NativeUpdateCache | null { return this.downloadedUpdateHelper; }
  protected override spawnLog(command: string, args: string[] = [], env?: NodeJS.ProcessEnv, stdio: StdioOptions = 'ignore'): Promise<boolean> {
    // Retain NsisUpdater.doInstall(), including its elevation fallback, but wait for an actual child spawn.
    const launched = this.#launched, controller = this.#launchController;
    if (!launched || !controller) return Promise.reject(new Error('本次更新安装已取消。'));
    return spawnInstaller(command, args, { stdio, env, detached: true }, () => { if (launched === this.#launched) launched(); }, controller.signal);
  }
  async installVerified(): Promise<void> {
    await verifyNativeUpdateCache(this.cache());
    const controller = new AbortController(); this.#launchController = controller;
    try {
      await waitForInstallerLaunch({
        onError: callback => { this.on('error', callback); return () => { this.removeListener('error', callback); }; },
        onLaunched: callback => { this.#launched = callback; return () => { if (this.#launched === callback) this.#launched = null; }; },
        start: () => this.install(true, true),
        reset: () => { controller.abort(); this.quitAndInstallCalled = false; },
      });
    } finally { if (this.#launchController === controller) this.#launchController = null; }
  }
}
class VerifiedMacUpdater extends MacUpdater {
  cache(): NativeUpdateCache | null { return this.downloadedUpdateHelper; }
  async installVerified(): Promise<void> {
    await verifyNativeUpdateCache(this.cache());
    await waitForMacInstall({
      onError: callback => { systemUpdater.on('error', callback); return () => { systemUpdater.removeListener('error', callback); }; },
      onDownloaded: callback => { systemUpdater.on('update-downloaded', callback); return () => { systemUpdater.removeListener('update-downloaded', callback); }; },
      onBeforeQuit: callback => { systemUpdater.on('before-quit-for-update', callback); return () => { systemUpdater.removeListener('before-quit-for-update', callback); }; },
      // MacUpdater's completed download already supplied Squirrel with its local, authenticated ZIP feed.
      check: () => systemUpdater.checkForUpdates(),
      quitAndInstall: () => systemUpdater.quitAndInstall(),
    });
  }
}
export function nativeUpdateEngine(platform: string, arch: string): NativeUpdateEngine {
  const updater = platform === 'darwin' ? new VerifiedMacUpdater() : new VerifiedNsisUpdater();
  updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
  updater.setFeedURL({ provider: 'github', owner: 'xhuandy666', repo: 'AlgoPractice', private: false });
  if (platform === 'darwin') updater.channel = `latest-${arch}`;
  updater.allowDowngrade = false; updater.allowPrerelease = false; updater.disableDifferentialDownload = true;
  if (updater instanceof NsisUpdater) updater.disableWebInstaller = true;
  updater.logger = null;
  // Keep a listener even when a check has no UI subscribers: updater errors must never be uncaught exceptions.
  updater.on('error', () => {});
  return {
    async check(signal) {
      const result = await abortable(updater.checkForUpdates(), signal);
      return result?.isUpdateAvailable ? result.updateInfo.version : null;
    },
    async download(version, signal) {
      const result = await abortable(updater.checkForUpdates(), signal);
      if (!result?.isUpdateAvailable || result.updateInfo.version !== version || !result.cancellationToken) throw new Error('版本发布信息已变化，请重新检查。');
      const cancellation = result.cancellationToken, cancel = () => cancellation.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try { signal.throwIfAborted(); await updater.downloadUpdate(cancellation); }
      finally { signal.removeEventListener('abort', cancel); }
    },
    verify: () => verifyNativeUpdateCache(updater.cache()),
    install: () => updater.installVerified(),
    observe(callbacks) {
      const progress = (value: { transferred: number; total: number }) => callbacks.progress(value.transferred, value.total);
      const downloaded = (value: { version: string }) => callbacks.downloaded(value.version);
      const error = () => callbacks.error();
      updater.on('download-progress', progress); updater.on('update-downloaded', downloaded); updater.on('error', error);
      return () => { updater.removeListener('download-progress', progress); updater.removeListener('update-downloaded', downloaded); updater.removeListener('error', error); };
    },
  };
}
