import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { integrityFailure } from '../storage/sqlite-integrity.ts';
import { isDatabaseCorruption } from './startup-errors.ts';

// A full integrity check reads the whole database (about 0.2 s for 100 MB with a warm cache, seconds for large cold
// files), so it does not run on every start. It runs on the next start after the running app saw SQLite report damage
// (an IPC call or the daily backup's integrity check of its snapshot); this marker carries that across the restart.
export const INTEGRITY_CHECK_REQUEST = '.integrity-check-requested';

export function requestIntegrityCheck(dataDirectory: string, now = new Date()): void {
  const file = join(dataDirectory, INTEGRITY_CHECK_REQUEST);
  if (existsSync(file)) return;
  const temporary = `${file}.${randomUUID()}.partial`;
  try { writeFileSync(temporary, `${JSON.stringify({ requestedAt: now.toISOString() })}\n`, { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}
export function integrityCheckRequested(dataDirectory: string): boolean { return existsSync(join(dataDirectory, INTEGRITY_CHECK_REQUEST)); }
export function clearIntegrityCheckRequest(dataDirectory: string): void { rmSync(join(dataDirectory, INTEGRITY_CHECK_REQUEST), { force: true }); }

/** 'unavailable': the file could not be checked for another reason (locked, no permission); it says nothing about damage. */
export type IntegrityVerdict = 'ok' | 'corrupt' | 'missing' | 'unavailable';

/** Runs `read` on a read-only connection, so a damaged file is never written (a read-write open of a file with a
 * damaged header deletes its -wal on close). SQLite creates an empty -wal and a -shm for a read-only connection to a
 * WAL database and cannot remove them; those it created are removed afterwards, so the directory looks as before. */
function readOnly(path: string, read: (db: DatabaseSync) => IntegrityVerdict): { verdict: IntegrityVerdict; error?: unknown } {
  if (!existsSync(path)) return { verdict: 'missing' };
  const created = [`${path}-wal`, `${path}-shm`].filter(file => !existsSync(file));
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const verdict = read(db);
    return verdict === 'corrupt' ? { verdict, error: integrityFailure() } : { verdict };
  } catch (error) {
    return { verdict: isDatabaseCorruption(error) ? 'corrupt' : 'unavailable', error };
  } finally {
    try { db?.close(); } catch { /* Nothing was written. */ }
    for (const file of created) {
      try { if (existsSync(file) && (file.endsWith('-shm') || statSync(file).size === 0)) rmSync(file); } catch { /* A leftover empty -wal or -shm is harmless. */ }
    }
  }
}
/** Full integrity check of the live database; committed transactions still in the WAL are part of it. */
export function checkDatabaseFile(path: string): { verdict: IntegrityVerdict; error?: unknown } {
  return readOnly(path, db => {
    const rows = db.prepare('PRAGMA integrity_check(1)').all() as { integrity_check?: unknown }[];
    return rows.length === 1 && rows[0].integrity_check === 'ok' ? 'ok' : 'corrupt';
  });
}
/** Cheap check on every start (the header and schema page, about a millisecond): a damaged header is caught before the
 * read-write open that would otherwise delete the file's -wal. */
export function probeDatabaseFile(path: string): { verdict: IntegrityVerdict; error?: unknown } {
  return readOnly(path, db => { db.prepare('SELECT count(*) FROM sqlite_schema').get(); return 'ok'; });
}
