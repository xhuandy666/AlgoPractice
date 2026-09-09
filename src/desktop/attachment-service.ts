import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { Attachment } from '../shared/learning';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const CONTENT_HASH = /^[a-f0-9]{64}$/;
const mimeByExtension: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.py': 'text/plain', '.java': 'text/plain', '.pdf': 'application/pdf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
export const attachmentExtensions = Object.keys(mimeByExtension).map(extension => extension.slice(1));
export const contentHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function readRegularFile(file: string, limit: number): Promise<Buffer> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error(`文件必须是普通文件且不超过 ${limit} 字节。`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.ino !== before.ino || info.dev !== before.dev) throw new Error('文件在打开时发生变化。');
    if (!info.isFile() || info.size > limit) throw new Error(`文件必须是普通文件且不超过 ${limit} 字节。`);
    const chunks: Buffer[] = []; let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, limit - size + 1));
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      size += bytesRead; if (size > limit) throw new Error('文件在读取时超过大小上限。');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}
export function validateAttachment(bytes: Buffer, name: string): string {
  if (!name || name !== basename(name) || /[\0\r\n\\/:*?"<>|]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name.length > 240) throw new Error('附件文件名无效。');
  const mime = mimeByExtension[extname(name).toLowerCase()];
  if (!mime || !bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('附件类型不支持、为空或超过 20 MiB。');
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
    : mime === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    : mime === 'application/pdf' ? bytes.toString('ascii', 0, 5) === '%PDF-'
    : (() => { try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return !text.includes('\0'); } catch { return false; } })();
  if (!valid) throw new Error('附件内容与允许的文件类型不匹配。');
  return mime;
}
export async function publishFile(file: string, bytes: Buffer): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.partial`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
export interface AttachmentServiceOptions {
  directory: string;
  getAttachment(hash: string): Attachment | undefined;
  registerAttachment(attachment: Attachment): Attachment;
  now?(): Date;
}
export class AttachmentService {
  readonly directory: string;
  constructor(private readonly options: AttachmentServiceOptions) { this.directory = resolve(options.directory); }
  async addFile(selectedPath: string): Promise<Attachment> {
    const name = basename(selectedPath), bytes = await readRegularFile(selectedPath, MAX_ATTACHMENT_BYTES);
    const mimeType = validateAttachment(bytes, name), hash = contentHash(bytes);
    await mkdir(this.directory, { recursive: true });
    const destination = join(this.directory, hash);
    try { await publishFile(destination, bytes); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readRegularFile(destination, MAX_ATTACHMENT_BYTES);
      if (existing.length !== bytes.length || contentHash(existing) !== hash) throw new Error('已有附件文件损坏，请先恢复备份。');
    }
    // Publication precedes the database transaction: a failed registration can only leave an unreferenced blob.
    const existing = this.options.getAttachment(hash);
    // Re-registration also cancels a persisted deletion candidate when the same content is selected again.
    return this.options.registerAttachment(existing ?? { hash, name, mimeType, size: bytes.length, createdAt: (this.options.now?.() ?? new Date()).toISOString() });
  }
  async read(hash: string): Promise<{ attachment: Attachment; bytes: Buffer }> {
    if (!CONTENT_HASH.test(hash)) throw new Error('附件标识无效。');
    const attachment = this.options.getAttachment(hash);
    if (!attachment) throw new Error('附件不存在。');
    const bytes = await readRegularFile(join(this.directory, hash), MAX_ATTACHMENT_BYTES);
    if (bytes.length !== attachment.size || contentHash(bytes) !== hash || validateAttachment(bytes, attachment.name) !== attachment.mimeType) throw new Error('附件校验失败。');
    return { attachment, bytes };
  }
  async exportFile(hash: string, selectedDestination: string): Promise<void> {
    const { bytes } = await this.read(hash);
    if (resolve(selectedDestination).startsWith(this.directory + sep)) throw new Error('不能覆盖应用管理的附件。');
    await publishFile(resolve(selectedDestination), bytes);
  }
  async openablePath(hash: string): Promise<string> {
    const { attachment, bytes } = await this.read(hash);
    // Never ask the OS to open imported source code as an executable association.
    const extension = attachment.mimeType.startsWith('image/') ? (attachment.mimeType === 'image/jpeg' ? '.jpg' : `.${attachment.mimeType.slice(6)}`) : attachment.mimeType === 'application/pdf' ? '.pdf' : '.txt';
    const directory = join(this.directory, '.open'); await mkdir(directory, { recursive: true });
    const file = join(directory, hash + extension);
    try { await publishFile(file, bytes); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (contentHash(await readRegularFile(file, MAX_ATTACHMENT_BYTES)) !== hash) throw new Error('临时预览附件已变化，请重新导出。');
    }
    return file;
  }
}
