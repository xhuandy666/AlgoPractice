import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Test fixture: copy a SQLite snapshot (PracticeStore.backupTo) to a new path and verify it,
 * so a test can open it as a separate store. The app itself restores through BackupService. */
export function restoreBackup(backupPath: string, destination: string): string {
  if (existsSync(destination)) throw new Error('Restore destination must not exist');
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    copyFileSync(backupPath, temporary);
    const db = new DatabaseSync(temporary, { readOnly: true });
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
      if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('SQLite foreign key check failed');
    } finally { db.close(); }
    linkSync(temporary, destination);
    return destination;
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
