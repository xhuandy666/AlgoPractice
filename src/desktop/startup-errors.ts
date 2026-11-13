import { SQLITE_INTEGRITY_FAILURE } from '../storage/sqlite-integrity.ts';

export interface StartupFailure { kind: 'version' | 'disk-full' | 'permission' | 'corrupt' | 'settings' | 'unknown'; title: string; message: string; }

// SQLite primary result codes (node:sqlite puts the extended code on `errcode`; the low byte is the primary code).
const SQLITE = { PERM: 3, BUSY: 5, LOCKED: 6, READONLY: 8, IOERR: 10, CORRUPT: 11, FULL: 13, CANTOPEN: 14, AUTH: 23, NOTADB: 26 } as const;

/** The error, its causes and the members of AggregateErrors, breadth-first and bounded. */
function errorChain(error: unknown): unknown[] {
  const seen: unknown[] = [], queue: unknown[] = [error];
  while (queue.length && seen.length < 16) {
    const current = queue.shift();
    if (current === undefined || current === null || seen.includes(current)) continue;
    seen.push(current);
    if (current instanceof Error) { if (current.cause !== undefined) queue.push(current.cause); if (current instanceof AggregateError) queue.push(...current.errors); }
  }
  return seen;
}
function sqliteCode(error: unknown): number | null {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && Number.isInteger(code) ? code & 0xff : null;
}

/** One classifier for startup dialogs and for the offer to restore a damaged database. Earlier classes win: a
 * database of another version, a full disk, missing permissions, I/O or lock errors are never treated as damage, because
 * replacing the file would not fix them and would lose newer data. Damage is recognised only by SQLite's own codes or
 * the app's integrity-check error, never by similar wording from elsewhere ("URI malformed"). */
export function startupFailureKind(error: unknown): StartupFailure['kind'] {
  const errors = errorChain(error), codes = new Set(errors.map(sqliteCode).filter((code): code is number => code !== null));
  const text = errors.map(item => item instanceof Error ? `${item.message}\n${String((item as NodeJS.ErrnoException).code ?? '')}` : String(item)).join('\n');
  if (/Unsupported schema version/i.test(text)) return 'version';
  if (/ENOSPC|SQLITE_FULL|database or disk is full/i.test(text) || codes.has(SQLITE.FULL)) return 'disk-full';
  if (/EACCES|EPERM|SQLITE_READONLY|readonly|read-only|permission denied/i.test(text) || codes.has(SQLITE.READONLY) || codes.has(SQLITE.PERM) || codes.has(SQLITE.AUTH)) return 'permission';
  const transient = [SQLITE.IOERR, SQLITE.BUSY, SQLITE.LOCKED, SQLITE.CANTOPEN].some(code => codes.has(code));
  if (!transient && (codes.has(SQLITE.CORRUPT) || codes.has(SQLITE.NOTADB) || errors.some(item => (item as { code?: unknown })?.code === SQLITE_INTEGRITY_FAILURE))) return 'corrupt';
  if (/设置文件|Unexpected.*JSON|JSON.*position|JSON.*end/i.test(text)) return 'settings';
  return 'unknown';
}
/** SQLite reported that the database file itself is damaged (see startupFailureKind for what never counts). */
export function isDatabaseCorruption(error: unknown): boolean { return startupFailureKind(error) === 'corrupt'; }

/** Keep recovery instructions local and avoid putting raw exception payloads into logs or dialogs. */
export function startupFailure(error: unknown, dataDirectory: string): StartupFailure {
  const kind = startupFailureKind(error); let title = '题炼暂时无法启动'; let action = '保留此数据目录。可重新启动；若仍失败，先复制整个目录，再用匹配版本的应用和已验证备份恢复。';
  if (kind === 'version') { title = '当前版本无法读取此数据'; action = '此数据由其他版本的题炼创建。来自 0.x 旧版本的数据，当前版本不再读取，请继续使用旧版本打开；来自更新版本的数据，请使用相同或更新的题炼。请勿删除数据库或强行打开。'; }
  else if (kind === 'disk-full') { title = '磁盘空间不足'; action = '请释放磁盘空间后重新打开。请勿通过删除数据库、附件或备份来解决启动问题。'; }
  else if (kind === 'permission') { title = '数据目录不可写'; action = '请确认当前用户对数据目录有读写权限，且目录所在磁盘可写。请勿通过覆盖数据库解决权限问题；修复权限后重新打开。'; }
  else if (kind === 'corrupt') { title = '数据文件未通过完整性检查'; action = '请先复制整个数据目录。使用已验证的完整备份恢复到独立目录，保留当前文件用于排查；请勿重建或覆盖现有数据库。'; }
  else if (kind === 'settings') { title = '本机设置未能读取'; action = '请保留数据目录中的设置文件及完整备份。检查最近的手动编辑或恢复操作，修复设置后重试；数据库不会因为设置错误而重建。'; }
  return { kind, title, message: `${action}\n\n数据目录：${dataDirectory}` };
}
