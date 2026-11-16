import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, open, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CONTENT_HASH, MAX_ATTACHMENT_BYTES, contentHash, readRegularFile, validateAttachment } from './attachment-service';
import { localClock, validateReminderSettings } from './reminder-service';
import { AI_PROVIDER_SETTINGS_FILE, REMINDER_SETTINGS_FILE } from '../shared/maintenance';
import type { BackupFile, BackupKind, BackupManifest, BackupServiceOptions, BackupSettings, BackupSnapshot, BackupSummary, RestoreResult } from '../shared/maintenance';
import type { LearningSettings } from '../shared/learning';
import { normalizeProviderConfig } from '../ai/canonical';
import { isDatabaseCorruption } from './startup-errors';
import { cachedMediaType } from './media-cache';

export const BACKUP_LIMITS = { archive: 512 * 1024 * 1024, database: 256 * 1024 * 1024, attachment: MAX_ATTACHMENT_BYTES, media: 8 * 1024 * 1024, manifest: 1024 * 1024, settings: 16384, files: 5000 };
const JOURNAL = '.restore-journal.json';
const managedNames = ['practice.sqlite', 'practice.sqlite-wal', 'practice.sqlite-shm', 'attachments', 'media', REMINDER_SETTINGS_FILE, AI_PROVIDER_SETTINGS_FILE] as const;
const idPattern = /^[a-f0-9-]{36}$/;
const exists = async (file: string) => { try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.partial`, handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
}
function learningSettings(value: unknown): LearningSettings {
  const v = value as LearningSettings;
  if (!v || typeof v !== 'object' || Object.keys(v).some(key => !['dailyReviewBudget', 'dailyPracticeGoal', 'timeZone', 'updatedAt', 'aiAutoAnalyzeOfficial'].includes(key))
    || (v.dailyReviewBudget !== null && (!Number.isInteger(v.dailyReviewBudget) || v.dailyReviewBudget < 0 || v.dailyReviewBudget > 1000))
    || !Number.isInteger(v.dailyPracticeGoal) || v.dailyPracticeGoal < 1 || v.dailyPracticeGoal > 1000
    || typeof v.aiAutoAnalyzeOfficial !== 'boolean'
    || typeof v.timeZone !== 'string' || v.timeZone.length > 128 || typeof v.updatedAt !== 'string' || !Number.isFinite(Date.parse(v.updatedAt))) throw new Error('备份学习设置无效。');
  localClock(new Date(), v.timeZone);
  return { dailyReviewBudget: v.dailyReviewBudget, dailyPracticeGoal: v.dailyPracticeGoal, timeZone: v.timeZone, updatedAt: v.updatedAt, aiAutoAnalyzeOfficial: v.aiAutoAnalyzeOfficial };
}
function safeSettings(value: unknown): BackupSettings {
  const v = value as BackupSettings;
  if (!v || Object.keys(v).some(key => !['learning', 'reminders', 'aiProvider'].includes(key))) throw new Error('备份包含不允许的设置字段。');
  return { learning: learningSettings(v.learning), reminders: validateReminderSettings(v.reminders), aiProvider: v.aiProvider == null ? null : normalizeProviderConfig(v.aiProvider) };
}
function pathLimit(path: string): number {
  if (path === 'database.sqlite') return BACKUP_LIMITS.database;
  if (path === 'settings.json') return BACKUP_LIMITS.settings;
  if (/^attachments\/[a-f0-9]{64}$/.test(path)) return BACKUP_LIMITS.attachment;
  if (/^media\/[a-f0-9]{64}$/.test(path)) return BACKUP_LIMITS.media;
  throw new Error(`备份包含不允许的文件路径：${path.slice(0, 200)}`);
}
function validateManifest(value: unknown): BackupManifest {
  const m = value as BackupManifest;
  if (m?.format === 'algopractice-backup' && (m as { formatVersion?: unknown }).formatVersion !== 2) throw new Error('这是旧版本题炼的备份，当前版本不能恢复。');
  if (!m || m.format !== 'algopractice-backup' || m.formatVersion !== 2 || !idPattern.test(m.id)
    || typeof m.appVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(m.appVersion)
    || !Number.isInteger(m.databaseVersion) || m.databaseVersion < 1 || !Number.isFinite(Date.parse(m.createdAt))
    || !['manual', 'automatic', 'before-restore'].includes(m.kind) || (m.localDay !== null && !/^\d{4}-\d{2}-\d{2}$/.test(m.localDay))
    || !CONTENT_HASH.test(m.dataFingerprint) || !Array.isArray(m.files) || m.files.length < 2 || m.files.length > BACKUP_LIMITS.files) throw new Error('备份清单格式或版本无效。');
  if (Object.keys(m).some(key => !['format', 'formatVersion', 'appVersion', 'databaseVersion', 'id', 'createdAt', 'kind', 'localDay', 'dataFingerprint', 'files'].includes(key))) throw new Error('备份清单包含未知字段。');
  const seen = new Set<string>(); let total = 0;
  for (const file of m.files) {
    if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > pathLimit(file.path) || !CONTENT_HASH.test(file.sha256)
      || Object.keys(file).some(key => !['path', 'size', 'sha256'].includes(key)) || seen.has(file.path)) throw new Error('备份文件清单无效或重复。');
    seen.add(file.path); total += file.size;
  }
  if (!seen.has('database.sqlite') || !seen.has('settings.json') || total > BACKUP_LIMITS.archive - BACKUP_LIMITS.manifest) throw new Error('备份缺少必要文件或超过总大小上限。');
  if (contentHash(Buffer.from(JSON.stringify(m.files))) !== m.dataFingerprint) throw new Error('备份数据指纹不匹配。');
  return m;
}
async function fileHash(file: string, maximum: number): Promise<{ size: number; sha256: string }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size < 1 || info.size > maximum) throw new Error('备份引用的文件类型或大小无效。');
    const hash = createHash('sha256'); let size = 0;
    for (;;) { const chunk = Buffer.alloc(65536), { bytesRead } = await handle.read(chunk); if (!bytesRead) break; size += bytesRead; if (size > maximum) throw new Error('备份引用文件在读取时变大。'); hash.update(chunk.subarray(0, bytesRead)); }
    return { size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512); h.write(name, 0, 100, 'ascii');
  const octal = (value: number, start: number, length: number) => h.write(value.toString(8).padStart(length - 1, '0') + '\0', start, length, 'ascii');
  octal(0o600, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12);
  h.fill(32, 148, 156); h[156] = 48; h.write('ustar\0', 257, 6, 'ascii'); h.write('00', 263, 2, 'ascii');
  const sum = h.reduce((total, byte) => total + byte, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii'); return h;
}
async function writeTar(destination: string, directory: string, manifest: BackupManifest): Promise<void> {
  const output = await open(destination, 'wx', 0o600);
  try {
    const metadata = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await output.writeFile(tarHeader('manifest.json', metadata.length)); await output.writeFile(metadata); await output.writeFile(Buffer.alloc((512 - metadata.length % 512) % 512));
    for (const file of manifest.files) {
      await output.writeFile(tarHeader(file.path, file.size));
      const source = await open(join(directory, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const hash = createHash('sha256'); let size = 0;
        for (;;) { const buffer = Buffer.alloc(65536), { bytesRead } = await source.read(buffer); if (!bytesRead) break; size += bytesRead; if (size > file.size) throw new Error('备份暂存文件发生变化。'); const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); await output.writeFile(bytes); }
        if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error('备份暂存文件校验失败。');
      } finally { await source.close(); }
      await output.writeFile(Buffer.alloc((512 - file.size % 512) % 512));
    }
    await output.writeFile(Buffer.alloc(1024)); await output.sync();
  } finally { await output.close(); }
}
/** The manifest only (the first TAR entry), for ordering candidates; full validation still follows. */
async function readManifest(archive: string): Promise<BackupManifest> {
  const input = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(512);
    if ((await input.read(header, 0, 512, 0)).bytesRead !== 512 || header.toString('utf8', 0, 100).replace(/\0.*$/, '') !== 'manifest.json') throw new Error('备份首项必须是 manifest.json。');
    const sizeText = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), size = /^[0-7]+$/.test(sizeText) ? parseInt(sizeText, 8) : NaN;
    if (!Number.isSafeInteger(size) || size < 1 || size > BACKUP_LIMITS.manifest) throw new Error('备份清单大小无效。');
    const body = Buffer.alloc(size); if ((await input.read(body, 0, size, 512)).bytesRead !== size) throw new Error('备份文件被截断。');
    return validateManifest(JSON.parse(body.toString('utf8')));
  } finally { await input.close(); }
}
async function extractValidated(archive: string, directory: string): Promise<BackupManifest> {
  const input = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await input.stat(); if (!info.isFile() || info.size < 1536 || info.size > BACKUP_LIMITS.archive || info.size % 512 !== 0) throw new Error('请选择完整且不超过 512 MiB 的 .algobak 普通文件。');
    let position = 0;
    const read = async (length: number) => { const buffer = Buffer.alloc(length); let received = 0; while (received < length) { const result = await input.read(buffer, received, length - received, position); if (!result.bytesRead) throw new Error('备份文件被截断。'); received += result.bytesRead; position += result.bytesRead; } return buffer; };
    let manifest: BackupManifest | undefined; const seen = new Set<string>();
    while (position < info.size) {
      const header = await read(512);
      if (header.every(byte => byte === 0)) {
        if (!(await read(512)).every(byte => byte === 0)) throw new Error('备份结束标记无效。');
        while (position < info.size) if (!(await read(512)).every(byte => byte === 0)) throw new Error('备份结束后存在额外内容。');
        if (!manifest || seen.size !== manifest.files.length) throw new Error('备份缺少清单中的文件。');
        return manifest;
      }
      const numeric = (start: number, length: number) => { const text = header.toString('ascii', start, start + length).replace(/\0.*$/, '').trim(); if (!/^[0-7]+$/.test(text)) throw new Error('备份 TAR 数字字段无效。'); return parseInt(text, 8); };
      const expectedChecksum = numeric(148, 8), checksumHeader = Buffer.from(header); checksumHeader.fill(32, 148, 156);
      if (checksumHeader.reduce((sum, byte) => sum + byte, 0) !== expectedChecksum || header.toString('ascii', 257, 263) !== 'ustar\0' || header.toString('ascii', 263, 265) !== '00'
        || ![0, 48].includes(header[156]) || !header.subarray(157, 257).every(byte => byte === 0) || !header.subarray(345, 500).every(byte => byte === 0)) throw new Error('备份只支持普通文件，不接受链接、扩展头或损坏的 TAR 头。');
      const name = header.toString('utf8', 0, 100).replace(/\0.*$/, ''), size = numeric(124, 12);
      if (!Number.isSafeInteger(size) || size < 1 || position + size > info.size) throw new Error('备份文件长度无效。');
      if (!manifest) {
        if (name !== 'manifest.json' || size > BACKUP_LIMITS.manifest) throw new Error('备份首项必须是有限大小的 manifest.json。');
        manifest = validateManifest(JSON.parse((await read(size)).toString('utf8')));
      } else {
        if (seen.has(name)) throw new Error('备份包含重复文件。'); pathLimit(name);
        const expected = manifest.files.find(file => file.path === name); if (!expected || expected.size !== size) throw new Error('备份文件与清单不符。');
        const target = join(directory, name); await mkdir(dirname(target), { recursive: true }); const output = await open(target, 'wx', 0o600);
        try {
          const hash = createHash('sha256'); let remaining = size;
          while (remaining) { const bytes = await read(Math.min(65536, remaining)); hash.update(bytes); await output.writeFile(bytes); remaining -= bytes.length; }
          if (hash.digest('hex') !== expected.sha256) throw new Error(`备份文件校验失败：${name}`);
          await output.sync();
        } finally { await output.close(); }
        seen.add(name);
      }
      const padding = (512 - size % 512) % 512; if (padding && !(await read(padding)).every(byte => byte === 0)) throw new Error('备份填充字节无效。');
    }
    throw new Error('备份缺少结束标记。');
  } finally { await input.close(); }
}
interface RestoreJournal { version: 1; id: string; phase: 'swapping' | 'committed'; entries: { name: typeof managedNames[number]; hadOriginal: boolean }[]; }
async function journalFor(directory: string): Promise<RestoreJournal | null> {
  const file = join(directory, JOURNAL); if (!(await exists(file))) return null;
  const j = JSON.parse((await readRegularFile(file, 16384)).toString('utf8')) as RestoreJournal;
  if (!j || j.version !== 1 || !idPattern.test(j.id) || !['swapping', 'committed'].includes(j.phase) || !Array.isArray(j.entries)
    || ![managedNames.length, managedNames.length - 1].includes(j.entries.length) || j.entries.some((entry, index) => entry.name !== managedNames[index] || typeof entry.hadOriginal !== 'boolean')) throw new Error('恢复日志损坏，已保留当前数据与回退文件。');
  const operation = await lstat(join(directory, `.restore-${j.id}`)); if (!operation.isDirectory() || operation.isSymbolicLink()) throw new Error('恢复暂存目录无效。'); return j;
}
async function rollback(directory: string, journal: RestoreJournal): Promise<void> {
  const operation = join(directory, `.restore-${journal.id}`);
  for (const entry of [...journal.entries].reverse()) {
    const current = join(directory, entry.name), original = join(operation, 'original', entry.name), prepared = join(operation, 'prepared', entry.name);
    if (await exists(original)) {
      const originalInfo = await lstat(original); if (originalInfo.isSymbolicLink()) throw new Error('回退文件不允许符号链接。');
      await rm(current, { recursive: true, force: true }); await rename(original, current);
    } else if (!entry.hadOriginal && !(await exists(prepared))) await rm(current, { recursive: true, force: true });
  }
}
/** Must run under the app single-instance lock, before any database handle is opened. */
export async function recoverInterruptedRestore(dataDirectory: string): Promise<{ recovered: boolean; outcome?: 'rolled-back' | 'committed' }> {
  const directory = resolve(dataDirectory), journal = await journalFor(directory); if (!journal) return { recovered: false };
  if (journal.phase === 'swapping') await rollback(directory, journal);
  await unlink(join(directory, JOURNAL)); await rm(join(directory, `.restore-${journal.id}`), { recursive: true, force: true });
  return { recovered: true, outcome: journal.phase === 'swapping' ? 'rolled-back' : 'committed' };
}
const AUTO_BACKUP_QUIET_MS = 15 * 60 * 1000;
export class BackupService {
  readonly directory: string; readonly backupDirectory: string;
  #phase: 'idle' | 'backup' | 'validating' | 'restoring' = 'idle'; #lastError: string | null = null;
  #autoDoneDay: string | null = null; #autoQuietUntil = 0; readonly #autoValidated = new Map<string, { stamp: string; summary: BackupSummary }>();
  constructor(private readonly options: BackupServiceOptions) { this.directory = resolve(options.dataDirectory); this.backupDirectory = join(this.directory, 'backups'); }
  status() { return { busy: this.#phase !== 'idle', phase: this.#phase, lastError: this.#lastError }; }
  #now() { return this.options.now?.() ?? new Date(); }
  async #operation<T>(phase: 'backup' | 'validating' | 'restoring', action: () => Promise<T>): Promise<T> {
    if (this.#phase !== 'idle') throw new Error('备份或恢复任务正在进行。');
    this.#phase = phase; this.#lastError = null;
    try { return await action(); } catch (error) { this.#lastError = error instanceof Error ? error.message : String(error); throw error; } finally { this.#phase = 'idle'; }
  }
  async #validate(file: string) {
    await mkdir(this.directory, { recursive: true }); const staging = await mkdtemp(join(this.directory, '.verify-'));
    try {
      const manifest = await extractValidated(resolve(file), staging), snapshot = await this.#inspectPackaged(join(staging, 'database.sqlite'));
      if (snapshot.schemaVersion !== manifest.databaseVersion) throw new Error('备份数据库版本与清单不匹配。');
      const settings = safeSettings(JSON.parse((await readRegularFile(join(staging, 'settings.json'), BACKUP_LIMITS.settings)).toString('utf8')));
      if (JSON.stringify(learningSettings(snapshot.learningSettings)) !== JSON.stringify(settings.learning)) throw new Error('备份学习设置与数据库快照不一致。');
      await this.#verifyReferences(staging, snapshot, manifest.files);
      return { staging, manifest, settings, summary: { path: resolve(file), manifest, bytes: (await stat(file)).size } as BackupSummary };
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  }
  /** Damage inside a backup file is a property of that file, not of the live database: it must not read as live damage. */
  async #inspectPackaged(path: string): Promise<BackupSnapshot> {
    try { return await this.options.inspectSnapshot(path); }
    catch (error) { if (isDatabaseCorruption(error)) throw new Error('备份中的数据库未通过完整性检查。'); throw error; }
  }
  async #verifyReferences(directory: string, snapshot: BackupSnapshot, files: BackupFile[]) {
    const referenced = new Set(['database.sqlite', 'settings.json']);
    for (const attachment of snapshot.attachments) {
      if (!CONTENT_HASH.test(attachment.hash)) throw new Error('数据库附件引用无效。');
      const path = `attachments/${attachment.hash}`, bytes = await readRegularFile(join(directory, path), BACKUP_LIMITS.attachment);
      if (bytes.length !== attachment.size || contentHash(bytes) !== attachment.hash || validateAttachment(bytes, attachment.name) !== attachment.mimeType) throw new Error('数据库附件与备份内容不一致。'); referenced.add(path);
    }
    for (const hash of snapshot.mediaHashes) {
      if (!CONTENT_HASH.test(hash)) throw new Error('数据库题面媒体引用无效。');
      const path = `media/${hash}`, bytes = await readRegularFile(join(directory, path), BACKUP_LIMITS.media);
      if (contentHash(bytes) !== hash) throw new Error('题面媒体校验失败。');
      validateAttachment(bytes, `media.${cachedMediaType(bytes).extension}`); referenced.add(path);
    }
    if (files.length !== referenced.size || files.some(file => !referenced.has(file.path))) throw new Error('备份文件集合与数据库快照引用不一致。');
  }
  async inspect(file: string): Promise<BackupSummary> {
    return this.#operation('validating', async () => { const validated = await this.#validate(file); await rm(validated.staging, { recursive: true, force: true }); return validated.summary; });
  }
  async list(): Promise<BackupSummary[]> {
    return this.#operation('validating', async () => {
      await mkdir(this.backupDirectory, { recursive: true }); const results: BackupSummary[] = [];
      for (const name of (await readdir(this.backupDirectory)).filter(name => /^(manual|automatic|before-restore)-[a-f0-9-]{36}\.algobak$/.test(name))) {
        try { const value = await this.#validate(join(this.backupDirectory, name)); results.push(value.summary); await rm(value.staging, { recursive: true, force: true }); }
        catch (error) { this.#lastError = `有备份未通过校验：${name}；${String(error)}`; }
      }
      return results.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
    });
  }
  async #create(kind: BackupKind, destination?: string, localDay: string | null = null, skipFingerprint?: string): Promise<BackupSummary | null> {
    await mkdir(this.directory, { recursive: true }); await mkdir(this.backupDirectory, { recursive: true });
    const staging = await mkdtemp(join(this.directory, '.backup-')); let temporary: string | undefined;
    try {
      await this.options.snapshotDatabase(join(staging, 'database.sqlite'));
      const snapshot = await this.options.inspectSnapshot(join(staging, 'database.sqlite'));
      const settings = safeSettings({ learning: snapshot.learningSettings, reminders: this.options.getReminderSettings(), aiProvider: this.options.getAiProvider?.() ?? null });
      await writeFile(join(staging, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
      const paths = new Set(['database.sqlite', 'settings.json']);
      for (const attachment of snapshot.attachments) { if (!CONTENT_HASH.test(attachment.hash)) throw new Error('附件引用无效。'); paths.add(`attachments/${attachment.hash}`); }
      for (const hash of snapshot.mediaHashes) { if (!CONTENT_HASH.test(hash)) throw new Error('题面媒体引用无效。'); paths.add(`media/${hash}`); }
      if (paths.size > BACKUP_LIMITS.files) throw new Error('备份文件数超过 5000。');
      for (const path of paths) if (path.includes('/')) { const bytes = await readRegularFile(join(this.directory, path), pathLimit(path)); await mkdir(dirname(join(staging, path)), { recursive: true }); await writeFile(join(staging, path), bytes, { mode: 0o600 }); }
      const files: BackupFile[] = [];
      for (const path of [...paths].sort()) files.push({ path, ...await fileHash(join(staging, path), pathLimit(path)) });
      await this.#verifyReferences(staging, snapshot, files);
      const fingerprint = contentHash(Buffer.from(JSON.stringify(files)));
      if (fingerprint === skipFingerprint) return null;
      const manifest = validateManifest({ format: 'algopractice-backup', formatVersion: 2, id: randomUUID(), appVersion: this.options.appVersion, databaseVersion: snapshot.schemaVersion,
        createdAt: this.#now().toISOString(), kind, localDay, dataFingerprint: fingerprint, files });
      const file = resolve(destination ?? join(this.backupDirectory, `${kind}-${manifest.id}.algobak`));
      if (await exists(file)) throw new Error('备份目标已存在，请选择新文件名。');
      temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.partial`); await writeTar(temporary, staging, manifest);
      if ((await stat(temporary)).size > BACKUP_LIMITS.archive) throw new Error('备份超过 512 MiB。');
      const validation = await this.#validate(temporary); await rm(validation.staging, { recursive: true, force: true });
      await link(temporary, file); return { path: file, manifest, bytes: (await stat(file)).size };
    } finally { if (temporary) await unlink(temporary).catch(() => {}); await rm(staging, { recursive: true, force: true }); }
  }
  create(kind: BackupKind = 'manual', destination?: string): Promise<BackupSummary> {
    if (!['manual', 'before-restore'].includes(kind)) return Promise.reject(new Error('自动备份由每日变化检查管理。'));
    return this.#operation('backup', async () => (await this.#create(kind, destination))!);
  }
  /** The newest manual or automatic backup in the backup folder that passes full validation. Candidates are validated
   * newest first and the search stops at the first valid one. Backups taken right before a restore are skipped: they
   * hold the data the user chose to replace. */
  async newestValidBackup(): Promise<BackupSummary | null> {
    return this.#operation('validating', async () => {
      const names = (await readdir(this.backupDirectory).catch(() => [] as string[])).filter(name => /^(manual|automatic)-[a-f0-9-]{36}\.algobak$/.test(name));
      const candidates: { path: string; created: number }[] = [];
      for (const name of names) {
        const path = join(this.backupDirectory, name);
        try { const manifest = await readManifest(path); if (manifest.kind !== 'before-restore') candidates.push({ path, created: Date.parse(manifest.createdAt) }); }
        catch { /* Not a readable backup; full validation would reject it too. */ }
      }
      for (const candidate of candidates.sort((a, b) => b.created - a.created)) {
        try { const value = await this.#validate(candidate.path); await rm(value.staging, { recursive: true, force: true }); return value.summary; }
        catch (error) { this.#lastError = `有备份未通过校验：${basename(candidate.path)}；${String(error)}`; }
      }
      return null;
    });
  }
  /** Automatic backups on disk, without validation: they only appear after #create validated them (temporary + link). */
  async automaticBackups(): Promise<{ path: string; id: string; modified: Date }[]> {
    const names = await readdir(this.backupDirectory).catch(() => [] as string[]), result: { path: string; id: string; modified: Date }[] = [];
    for (const name of names) {
      const id = /^automatic-([a-f0-9-]{36})\.algobak$/.exec(name)?.[1]; if (!id) continue;
      const info = await lstat(join(this.backupDirectory, name)).catch(() => null);
      if (info?.isFile()) result.push({ path: join(this.backupDirectory, name), id, modified: info.mtime });
    }
    return result;
  }
  /** The minute timer must not hold the busy lock for a full validation pass; other backup and interview actions are rejected while busy. */
  async autoBackup(timeZone: string): Promise<BackupSummary | null> {
    if (this.#phase !== 'idle') return null;
    const now = this.#now(), day = localClock(now, timeZone).day;
    if (this.#autoDoneDay === day || now.getTime() < this.#autoQuietUntil) return null;
    return this.#operation('backup', async () => {
      await mkdir(this.backupDirectory, { recursive: true });
      const backups: BackupSummary[] = [], present = new Set<string>();
      for (const name of (await readdir(this.backupDirectory)).filter(name => /^automatic-[a-f0-9-]{36}\.algobak$/.test(name))) {
        const path = join(this.backupDirectory, name), info = await stat(path).catch(() => null); if (!info) continue;
        const stamp = `${info.size}:${info.mtimeMs}`, cached = this.#autoValidated.get(name); present.add(name);
        if (cached?.stamp === stamp) { backups.push(cached.summary); continue; }
        try { const value = await this.#validate(path); backups.push(value.summary); this.#autoValidated.set(name, { stamp, summary: value.summary }); await rm(value.staging, { recursive: true, force: true }); }
        catch (error) { this.#autoValidated.delete(name); this.#lastError = `已有自动备份损坏，已保留：${String(error)}`; }
      }
      for (const name of [...this.#autoValidated.keys()]) if (!present.has(name)) this.#autoValidated.delete(name);
      if (backups.some(backup => backup.manifest.localDay === day)) { this.#autoDoneDay = day; return null; }
      backups.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
      const created = await this.#create('automatic', undefined, day, backups[0]?.manifest.dataFingerprint);
      if (!created) { this.#autoQuietUntil = this.#now().getTime() + AUTO_BACKUP_QUIET_MS; return null; }
      this.#autoDoneDay = day;
      for (const obsolete of [created, ...backups].slice(7)) await unlink(obsolete.path);
      return created;
    });
  }
  restore(file: string, expected?: Pick<BackupManifest, 'id' | 'dataFingerprint'>): Promise<RestoreResult> {
    return this.#restore(file, expected, null).then(result => ({ restored: true, preRestoreBackup: result.preRestoreBackup!, manifest: result.manifest }));
  }
  /** Startup recovery of a database that failed its integrity check, before anything opened it. No backup of the damaged
   * data can be made, so its files are first copied into `keptDirectory` (a new folder in the data directory). This
   * device's reminder and AI settings stay as they are, attachments and media keep every current file next to the
   * backup's, and credentials are not touched. The same journaled swap as restore() keeps it all-or-nothing. */
  async recoverDamaged(file: string, expected: Pick<BackupManifest, 'id' | 'dataFingerprint'>, keptDirectory: string): Promise<{ manifest: BackupManifest; keptDirectory: string }> {
    const result = await this.#restore(file, expected, keptDirectory);
    return { manifest: result.manifest, keptDirectory: result.keptDirectory! };
  }
  #restore(file: string, expected: Pick<BackupManifest, 'id' | 'dataFingerprint'> | undefined, keptName: string | null) {
    const damaged = keptName !== null;
    return this.#operation('restoring', async () => {
      if (await exists(join(this.directory, JOURNAL))) throw new Error('请先恢复上次中断的恢复事务，再开始新恢复。');
      if (this.options.lifecycle.hasActiveInterview()) throw new Error('活动面试未结束，不能恢复备份。');
      const validated = await this.#validate(file);
      let entered = false, closed = false, committed = false, safeToUnlock = true; let journal: RestoreJournal | undefined; let operation: string | undefined; let kept: string | undefined;
      try {
        if (expected && (validated.manifest.id !== expected.id || validated.manifest.dataFingerprint !== expected.dataFingerprint)) throw new Error('备份文件在预览后已变化，请重新预览。');
        await this.options.lifecycle.enterMaintenance(); entered = true;
        if (this.options.lifecycle.hasActiveInterview()) throw new Error('活动面试未结束，不能恢复备份。');
        const preRestoreBackup = damaged ? undefined : (await this.#create('before-restore'))!;
        if (keptName !== null) kept = await this.#keepDamagedDatabase(keptName);
        await this.options.lifecycle.closeDatabase(); closed = true;
        const id = randomUUID(); operation = join(this.directory, `.restore-${id}`); await mkdir(join(operation, 'original'), { recursive: true });
        const prepared = join(operation, 'prepared'); await rename(validated.staging, prepared);
        await rename(join(prepared, 'database.sqlite'), join(prepared, 'practice.sqlite'));
        if (damaged) await this.#keepDeviceSettings(prepared);
        else {
          await writeFile(join(prepared, REMINDER_SETTINGS_FILE), JSON.stringify(validated.settings.reminders), { mode: 0o600 });
          await writeFile(join(prepared, AI_PROVIDER_SETTINGS_FILE), JSON.stringify(validated.settings.aiProvider), { mode: 0o600 });
        }
        await mkdir(join(prepared, 'attachments'), { recursive: true }); await mkdir(join(prepared, 'media'), { recursive: true });
        if (damaged) await this.#keepContentFiles(prepared);
        const entries: RestoreJournal['entries'] = [];
        for (const name of managedNames) {
          const current = join(this.directory, name), hadOriginal = await exists(current);
          if (hadOriginal) { const info = await lstat(current); if (info.isSymbolicLink() || (['attachments', 'media'].includes(name) ? !info.isDirectory() : !info.isFile())) throw new Error('当前数据路径类型无效，已停止恢复。'); }
          entries.push({ name, hadOriginal });
        }
        journal = { version: 1, id, phase: 'swapping', entries }; await atomicJson(join(this.directory, JOURNAL), journal);
        for (const entry of entries) {
          if (entry.hadOriginal) await rename(join(this.directory, entry.name), join(operation, 'original', entry.name));
          if (await exists(join(prepared, entry.name))) await rename(join(prepared, entry.name), join(this.directory, entry.name));
        }
        await this.options.lifecycle.openDatabase(); closed = false;
        if (!damaged) await this.options.lifecycle.clearCredentials();
        journal.phase = 'committed'; await atomicJson(join(this.directory, JOURNAL), journal); committed = true;
        await recoverInterruptedRestore(this.directory); operation = undefined;
        return { preRestoreBackup, manifest: validated.manifest, keptDirectory: kept };
      } catch (error) {
        if (!committed) {
          try {
            if (journal) {
              if (!closed) { await this.options.lifecycle.closeDatabase(); closed = true; }
              await rollback(this.directory, journal); await unlink(join(this.directory, JOURNAL));
            }
            // A damaged database was not open before this call and is not reopened.
            if (closed && !damaged) { await this.options.lifecycle.openDatabase(); closed = false; }
          } catch (recoveryError) {
            safeToUnlock = false;
            throw new AggregateError([error, recoveryError], '恢复未完成且暂时无法重新打开原数据；已保持维护态，请重启恢复。');
          }
          // The originals are back in place, so the copy made of them is redundant.
          if (kept) await rm(kept, { recursive: true, force: true }).catch(() => {});
        }
        throw error;
      } finally {
        await rm(validated.staging, { recursive: true, force: true });
        if (operation && !(await exists(join(this.directory, JOURNAL)))) await rm(operation, { recursive: true, force: true });
        if (entered && safeToUnlock) await this.options.lifecycle.leaveMaintenance(committed);
      }
    });
  }
  /** Copies (never moves) the damaged database files, so they outlive the swap that removes the originals. */
  async #keepDamagedDatabase(name: string): Promise<string> {
    if (!/^damaged-\d{8}-\d{6}-[a-f0-9]{8}$/.test(name)) throw new Error('损坏数据的保留目录名称无效。');
    const kept = join(this.directory, name); await mkdir(kept, { mode: 0o700 });
    try {
      for (const file of ['practice.sqlite', 'practice.sqlite-wal', 'practice.sqlite-shm']) {
        const source = join(this.directory, file); if (!(await exists(source))) continue;
        const info = await lstat(source); if (!info.isFile()) throw new Error('当前数据路径类型无效，已停止恢复。');
        const target = join(kept, file); await copyFile(source, target, constants.COPYFILE_EXCL);
        const handle = await open(target, 'r+');
        try { if ((await handle.stat()).size !== info.size) throw new Error('损坏的数据库未能完整保留，已停止恢复。'); await handle.sync(); } finally { await handle.close(); }
      }
      return kept;
    } catch (error) { await rm(kept, { recursive: true, force: true }).catch(() => {}); throw error; }
  }
  /** This device's reminder and AI settings stay as they are; a damaged database says nothing about them. */
  async #keepDeviceSettings(prepared: string) {
    for (const name of [REMINDER_SETTINGS_FILE, AI_PROVIDER_SETTINGS_FILE]) {
      const current = join(this.directory, name); if (!(await exists(current))) continue;
      if (!(await lstat(current)).isFile()) throw new Error('当前数据路径类型无效，已停止恢复。');
      await copyFile(current, join(prepared, name), constants.COPYFILE_EXCL);
    }
  }
  /** Attachments and media are content-addressed: every current file stays, next to the backup's. */
  async #keepContentFiles(prepared: string) {
    for (const folder of ['attachments', 'media']) {
      const current = join(this.directory, folder); if (!(await exists(current))) continue;
      const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('当前数据路径类型无效，已停止恢复。');
      for (const name of await readdir(current)) {
        const source = join(current, name), target = join(prepared, folder, name);
        if (!(await lstat(source)).isFile() || await exists(target)) continue;
        try { await link(source, target); } catch { await copyFile(source, target, constants.COPYFILE_EXCL); }
      }
    }
  }
}
