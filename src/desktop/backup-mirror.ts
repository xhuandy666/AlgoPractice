import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, open, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { MirrorStatus } from '../shared/maintenance';

// Copies of the automatic backups in a folder the user chose (typically one a cloud client syncs), so a lost or broken
// disk does not take every backup with it. The step is a reconciliation — "the newest local automatic backup is in the
// folder" — so a folder chosen later, or one that was offline, catches up on its own. It never touches the local
// backups or their status, never holds the backup lock, and deletes only copies this installation wrote: several
// devices may share one synced folder.

export interface MirrorSetting { directory: string; installId: string }
export type { MirrorStatus };
export interface MirrorOptions {
  setting(): MirrorSetting | null;
  /** Local automatic backups (path and modification time); the newest one is copied. */
  localBackups(): Promise<{ path: string; id: string; modified: Date }[]>;
  now?: () => Date;
  /** Copies of this installation kept in the folder. */
  keep?: number;
}

export const newInstallId = () => randomBytes(4).toString('hex');
/** What went wrong, in terms of the folder the user chose; other errors keep their own message. */
export function describeMirrorError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return '找不到副本文件夹：可能已移动或改名，或云盘、外接硬盘未连接。';
  if (code === 'ENOTDIR') return '副本路径现在不是文件夹。';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return '无权写入副本文件夹。';
  if (code === 'ENOSPC' || code === 'EDQUOT') return '副本文件夹所在的磁盘空间不足。';
  return error instanceof Error ? error.message : String(error);
}
const INSTALL_ID = /^[a-f0-9]{8}$/;
const stamp = (date: Date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
/** 题炼-备份-<install>-<local time>-<backup id>.algobak; sorting the names sorts this installation's copies by time. */
export const mirrorName = (installId: string, id: string, modified: Date) => `题炼-备份-${installId}-${stamp(modified)}-${id}.algobak`;
const ownCopy = (installId: string) => new RegExp(`^题炼-备份-${installId}-\\d{8}-\\d{6}-[a-f0-9-]{36}\\.algobak$`);
const ownPartial = (installId: string) => new RegExp(`^\\.题炼-备份-${installId}-[a-f0-9]{16}\\.partial$`);

interface FileDigest { size: number; sha256: string }
/** Read every byte with bounded memory: an equally sized copy may still be incomplete or damaged. */
async function fileDigest(path: string): Promise<FileDigest> {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await input.stat();
    if (!info.isFile()) throw new Error('备份路径不是普通文件。');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65_536); let size = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > info.size) throw new Error('备份文件在读取时发生变化。');
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (size !== info.size) throw new Error('备份文件在读取时发生变化。');
    return { size, sha256: hash.digest('hex') };
  } finally { await input.close(); }
}

/** Real path of a folder that can hold copies: an existing, writable directory outside the data directory. */
export async function validateMirrorDirectory(directory: string, dataDirectory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('请选择一个完整路径的文件夹。');
  let real: string;
  try { real = await realpath(directory); } catch { throw new Error('找不到所选文件夹。'); }
  if (!(await stat(real)).isDirectory()) throw new Error('所选路径不是文件夹。');
  const data = await realpath(dataDirectory).catch(() => dataDirectory);
  const inside = relative(data, real);
  if (inside === '' || (!isAbsolute(inside) && inside.split(sep)[0] !== '..')) throw new Error('副本文件夹不能位于题炼的数据目录中，否则磁盘损坏时会一并丢失。');
  const probe = join(real, `.题炼-写入检查-${randomBytes(8).toString('hex')}.tmp`);
  try { await writeFile(probe, 'ok', { flag: 'wx' }); } catch { throw new Error('所选文件夹不能写入。'); }
  await unlink(probe).catch(() => {});
  return real;
}

export class BackupMirror {
  #busy = false; #lastCopy: string | null = null; #lastCopiedAt: string | null = null; #lastError: string | null = null;
  #failures = 0; #retryAt = 0; #directory: string | null = null;
  constructor(private readonly options: MirrorOptions) {}
  #now() { return this.options.now?.() ?? new Date(); }
  status(): MirrorStatus {
    const setting = this.options.setting();
    return { directory: setting?.directory ?? null, busy: this.#busy, lastCopy: setting ? this.#lastCopy : null, lastCopiedAt: setting ? this.#lastCopiedAt : null, lastError: setting ? this.#lastError : null };
  }
  /** Never throws. `force` skips the retry backoff (a new folder, or the user asking). */
  async reconcile(force = false): Promise<MirrorStatus> {
    const setting = this.options.setting();
    if (!setting || !INSTALL_ID.test(setting.installId)) { this.#reset(null); return this.status(); }
    if (setting.directory !== this.#directory) this.#reset(setting.directory);
    if (this.#busy || (!force && this.#now().getTime() < this.#retryAt)) return this.status();
    this.#busy = true;
    try {
      const local = (await this.options.localBackups()).sort((a, b) => b.modified.getTime() - a.modified.getTime() || b.id.localeCompare(a.id))[0];
      if (!local) return this.status();
      const name = mirrorName(setting.installId, local.id, local.modified), target = join(setting.directory, name);
      const expected = await fileDigest(local.path), present = await stat(target).catch(() => null);
      if (!present || present.size !== expected.size || (await fileDigest(target)).sha256 !== expected.sha256) {
        await this.#copy(local.path, target, setting, expected);
      }
      await this.#prune(setting);
      this.#lastCopy = name; this.#lastCopiedAt = this.#now().toISOString(); this.#lastError = null; this.#failures = 0; this.#retryAt = 0;
    } catch (error) {
      this.#lastError = describeMirrorError(error); this.#failures++;
      this.#retryAt = this.#now().getTime() + Math.min(60, 2 ** Math.min(this.#failures - 1, 6)) * 60_000;
    } finally { this.#busy = false; }
    return this.status();
  }
  #reset(directory: string | null) { this.#directory = directory; this.#lastCopy = null; this.#lastCopiedAt = null; this.#lastError = null; this.#failures = 0; this.#retryAt = 0; }
  /** Check the complete temporary copy before atomic publication; never publish an unverified backup. */
  async #copy(source: string, target: string, setting: MirrorSetting, expected: FileDigest) {
    const partial = join(setting.directory, `.题炼-备份-${setting.installId}-${randomBytes(8).toString('hex')}.partial`);
    try {
      await copyFile(source, partial, constants.COPYFILE_EXCL);
      const copied = await fileDigest(partial);
      if (copied.size !== expected.size || copied.sha256 !== expected.sha256) throw new Error('副本内容与本地备份不一致。');
      await rename(partial, target);
    } catch (error) { await rm(partial, { force: true }).catch(() => {}); throw error; }
  }
  async #prune(setting: MirrorSetting) {
    const names = await readdir(setting.directory), own = ownCopy(setting.installId), partial = ownPartial(setting.installId);
    const copies = names.filter(name => own.test(name)).sort().reverse();
    for (const name of copies.slice(this.options.keep ?? 7)) await unlink(join(setting.directory, name)).catch(() => {});
    // Leftovers of copies interrupted by a crash or quit; another copy of this installation is never running.
    for (const name of names.filter(name => partial.test(name))) await unlink(join(setting.directory, name)).catch(() => {});
  }
}
