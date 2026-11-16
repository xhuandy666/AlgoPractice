import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface UpdateInstaller { name: string; url: string; size: number; sha256: string }
export type UpdateFetch = (url: string, init: RequestInit) => Promise<Response>;
export const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);

/** Only the asset matching this version, OS and architecture can ever become a local installer. */
export function releaseInstaller(release: Record<string, unknown>, platform: string, arch: string): UpdateInstaller | null {
  if (!['arm64', 'x64'].includes(arch) || !['darwin', 'win32'].includes(platform) || (platform === 'win32' && arch !== 'x64')) return null;
  const tag = release.tag_name;
  if (typeof tag !== 'string' || !/^v?\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(tag)) throw new Error('更新版本无效。');
  const version = tag.replace(/^v/, '');
  const name = `AlgoPractice-${version}-${platform === 'darwin' ? 'mac' : 'win'}-${arch}.${platform === 'darwin' ? 'dmg' : 'exe'}`;
  const matches = Array.isArray(release.assets) ? release.assets.filter((asset: unknown) => asset && typeof asset === 'object' && (asset as Record<string, unknown>).name === name) : [];
  if (matches.length !== 1) throw new Error('新版本尚未提供匹配的安装包，请稍后重试。');
  const asset = matches[0] as Record<string, unknown>, url = `https://github.com/xhuandy666/AlgoPractice/releases/download/${tag}/${name}`;
  if (asset.browser_download_url !== url || !Number.isSafeInteger(asset.size) || (asset.size as number) <= 0 || (asset.size as number) > MAX_INSTALLER_BYTES || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error('安装包缺少可信的校验信息，暂不能下载。');
  }
  return { name, url, size: asset.size as number, sha256: asset.digest.slice(7) };
}

function assertDownloadUrl(raw: string): void {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error('更新下载地址无效。');
}
async function fetchInstaller(asset: UpdateInstaller, fetchImpl: UpdateFetch, signal: AbortSignal): Promise<Response> {
  let url = asset.url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    assertDownloadUrl(url);
    const response = await fetchImpl(url, { signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location) throw new Error('更新下载地址无效。');
    url = new URL(location, url).href;
  }
  throw new Error('更新下载跳转过多，请稍后重试。');
}

async function matches(path: string, asset: UpdateInstaller): Promise<boolean> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.size) return false;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash('sha256');
  try {
    const buffer = Buffer.alloc(65_536);
    for (;;) { const { bytesRead } = await file.read(buffer); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
  }
  finally { await file.close(); }
  return hash.digest('hex') === asset.sha256;
}

async function cleanCache(directory: string, keep: string, completed: boolean) {
  const installer = /^AlgoPractice-\d{1,6}\.\d{1,6}\.\d{1,6}-(?:mac|win)-(?:arm64|x64)\.(?:dmg|exe)$/;
  const partial = /^\.AlgoPractice-\d{1,6}\.\d{1,6}\.\d{1,6}-(?:mac|win)-(?:arm64|x64)\.(?:dmg|exe)\.[a-f0-9-]{36}\.partial$/;
  for (const name of await readdir(directory)) {
    if (name === keep || !(partial.test(name) || completed && installer.test(name))) continue;
    const path = join(directory, name), info = await lstat(path).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink()) await rm(path, { force: true }).catch(() => {});
  }
}

/** Stages only a complete, digest-verified file. A cached installer is checked again before being opened. */
export async function downloadInstaller(asset: UpdateInstaller, directory: string, fetchImpl: UpdateFetch,
  progress: (transferred: number, total: number) => void, signal: AbortSignal): Promise<string> {
  await mkdir(directory, { recursive: true });
  const folder = await lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('更新缓存目录不可用。');
  const target = join(directory, asset.name);
  await cleanCache(directory, asset.name, false);
  if (await matches(target, asset)) { await cleanCache(directory, asset.name, true); progress(asset.size, asset.size); return target; }
  const partial = join(directory, `.${asset.name}.${randomUUID()}.partial`);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetchInstaller(asset, fetchImpl, signal);
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('更新下载失败，请检查网络后重试。'); }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== asset.size) { await response.body.cancel(); throw new Error('安装包大小与发布记录不一致。'); }
    reader = response.body.getReader();
    const file = await open(partial, 'wx', 0o600), hash = createHash('sha256'); let transferred = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read(); if (done) break;
        transferred += value.byteLength;
        if (transferred > asset.size) throw new Error('安装包超过发布记录的大小。');
        hash.update(value);
        let offset = 0;
        while (offset < value.byteLength) { const written = await file.write(value, offset, value.byteLength - offset); if (!written.bytesWritten) throw new Error('更新文件未能完整写入。'); offset += written.bytesWritten; }
        progress(transferred, asset.size);
      }
      if (transferred !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('安装包校验失败，请重新下载。');
      await file.sync();
    } finally { await file.close(); }
    signal.throwIfAborted();
    await rename(partial, target);
    await cleanCache(directory, asset.name, true);
    return target;
  } finally { await reader?.cancel().catch(() => {}); await rm(partial, { force: true }); }
}

export async function verifyInstaller(path: string, asset: UpdateInstaller): Promise<void> {
  if (!(await matches(path, asset))) throw new Error('已下载的安装包校验失败，请重新下载。');
}
