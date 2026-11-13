import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { BackupManifest, BackupSnapshot, BackupSummary, RestoreLifecycle } from '../shared/maintenance';
import { BackupService } from './backup-service';
import { checkDatabaseFile, clearIntegrityCheckRequest, integrityCheckRequested, probeDatabaseFile } from './database-health';
import { isDatabaseCorruption } from './startup-errors';

// Opening the database at startup, with an offer to restore it from a backup when SQLite says the file is damaged.
//
// Never automatic: the user chooses, with the backup's time in front of them, and the default without a choice is to
// change nothing. A restore is offered only when the live file itself fails a full integrity check; a newer schema, a
// failed migration, a full disk, missing permissions, I/O or lock errors never lead here (see startupFailureKind).

type LogFields = Record<string, string | number | boolean | null>;
export type RecoveryAction = 'restore' | 'open' | 'quit';
export interface DamagedDatabasePrompt { title: string; message: string; detail: string; buttons: string[]; actions: RecoveryAction[]; defaultId: number; cancelId: number; }

/** How old the backup is, for the restore decision ("约 3 小时前"). */
export function describeAge(createdAt: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(createdAt)) / 60_000);
  if (!(minutes >= 1)) return '刚刚';
  if (minutes < 60) return `约 ${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `约 ${hours} 小时前` : `约 ${Math.floor(hours / 24)} 天前`;
}
const two = (value: number) => String(value).padStart(2, '0');
function localTime(value: string): string { const date = new Date(value); return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`; }
/** A new folder in the data directory for the copy of the damaged files, e.g. damaged-20261113-094500-1a2b3c4d. */
export function keptDirectoryName(now: Date, random = randomBytes(4).toString('hex')): string {
  return `damaged-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}-${random}`;
}

/** Null when there is nothing to offer (no valid backup and the file cannot be opened): the usual startup error applies. */
export function damagedDatabasePrompt(input: { backup: BackupSummary | null; canOpen: boolean; keptPath: string; dataDirectory: string; now: Date; formatTime?(value: string): string }): DamagedDatabasePrompt | null {
  const { backup, canOpen } = input, title = '数据文件已损坏';
  if (!backup) {
    if (!canOpen) return null;
    return { title, message: '题炼的数据库未通过完整性检查，且未找到可用的备份。', detail: `可继续打开，但部分记录可能无法读取或保存。建议先复制整个数据目录：\n${input.dataDirectory}`,
      buttons: ['继续打开', '退出'], actions: ['open', 'quit'], defaultId: 0, cancelId: 1 };
  }
  const { createdAt, kind } = backup.manifest;
  const detail = [`备份时间：${(input.formatTime ?? localTime)(createdAt)}（${describeAge(createdAt, input.now)}，${kind === 'automatic' ? '自动' : '手动'}备份）`,
    '恢复后，这份备份之后的练习、笔记和复习记录会丢失。', '', '损坏的数据库会先复制保留到：', input.keptPath, '本机的提醒设置、AI 设置、附件和登录状态保持不变。',
    ...(canOpen ? ['', '也可暂不恢复、继续打开，但部分记录可能无法读取或保存。'] : [])].join('\n');
  return canOpen
    ? { title, message: '题炼的数据库未通过完整性检查，可用最近的备份恢复。', detail, buttons: ['用这份备份恢复', '暂不恢复，继续打开', '退出'], actions: ['restore', 'open', 'quit'], defaultId: 0, cancelId: 2 }
    : { title, message: '题炼的数据库未通过完整性检查，无法打开，可用最近的备份恢复。', detail, buttons: ['用这份备份恢复', '退出'], actions: ['restore', 'quit'], defaultId: 0, cancelId: 1 };
}

export interface OpenWithRecoveryOptions<T> {
  dataDirectory: string; appVersion: string;
  inspectSnapshot(path: string): BackupSnapshot | Promise<BackupSnapshot>;
  /** Opens the store and runs the startup steps that read it; closes what it opened before throwing. */
  open(): T;
  close(store: T): void;
  /** Shows the prompt and returns the index of the chosen button. */
  ask(prompt: DamagedDatabasePrompt): Promise<number>;
  log(event: string, fields: LogFields): void;
  now?(): Date;
}
export type OpenWithRecoveryResult<T> = { store: T; restored?: { manifest: BackupManifest; keptDirectory: string } } | { quit: true };

/** Must run under the single-instance lock, after recoverInterruptedRestore and before anything opens the database. */
export async function openWithRecovery<T>(options: OpenWithRecoveryOptions<T>): Promise<OpenWithRecoveryResult<T>> {
  const { dataDirectory } = options, databasePath = join(dataDirectory, 'practice.sqlite'), now = options.now?.() ?? new Date();
  let damage: unknown = null, canOpen = false;
  if (integrityCheckRequested(dataDirectory)) {
    // The running app saw damage last time; check before opening, because opening writes.
    const checked = checkDatabaseFile(databasePath);
    options.log('database.integrity-checked', { result: checked.verdict });
    if (checked.verdict === 'ok' || checked.verdict === 'missing') clearIntegrityCheckRequest(dataDirectory);
    if (checked.verdict === 'corrupt') { damage = checked.error; canOpen = true; }
  }
  if (damage === null) {
    // A damaged header is caught read-only, before the read-write open that would delete the file's -wal on close.
    const probe = probeDatabaseFile(databasePath);
    if (probe.verdict === 'corrupt') damage = probe.error;
  }
  if (damage === null) {
    try { return { store: options.open() }; }
    catch (error) {
      // A failed copy, snapshot or check elsewhere must never get a healthy file replaced: the live file decides.
      if (!isDatabaseCorruption(error) || checkDatabaseFile(databasePath).verdict !== 'corrupt') throw error;
      damage = error;
    }
  }
  options.log('database.damaged', { operation: canOpen ? 'integrity-check' : 'open' });
  let opened: T | undefined;
  const lifecycle: RestoreLifecycle = {
    hasActiveInterview: () => false, enterMaintenance: async () => {}, clearCredentials: async () => {}, leaveMaintenance: () => {},
    closeDatabase: () => { if (opened !== undefined) { const store = opened; opened = undefined; options.close(store); } },
    openDatabase: () => { opened = options.open(); },
  };
  const backups = new BackupService({ dataDirectory, appVersion: options.appVersion, inspectSnapshot: options.inspectSnapshot, lifecycle, now: options.now,
    snapshotDatabase: () => Promise.reject(new Error('损坏的数据库不能再备份。')), getReminderSettings: () => { throw new Error('启动恢复不创建新备份。'); } });
  const backup = await backups.newestValidBackup().catch(() => null), keptDirectory = keptDirectoryName(now);
  const prompt = damagedDatabasePrompt({ backup, canOpen, keptPath: join(dataDirectory, keptDirectory), dataDirectory, now });
  if (!prompt) throw damage;
  const action = prompt.actions[await options.ask(prompt)] ?? 'quit';
  options.log('database.recovery-choice', { result: action });
  if (action === 'quit') return { quit: true };
  // The request stays: the next start checks again and asks again while the file is damaged.
  if (action === 'open') return { store: options.open() };
  const restored = await backups.recoverDamaged(backup!.path, backup!.manifest, keptDirectory);
  if (opened === undefined) throw new Error('恢复后的数据库未能打开。');
  clearIntegrityCheckRequest(dataDirectory);
  options.log('database.restored', { result: backup!.manifest.kind });
  return { store: opened, restored };
}
