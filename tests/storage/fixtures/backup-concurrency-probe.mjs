import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PracticeStore } from '../../../src/storage/practice-store.ts';

const results = [];
const summarizeError = error => ({ message: error.message, code: error.code, errcode: error.errcode, errstr: error.errstr });
for (const mode of ['shared-before', 'shared-after', 'readonly', 'readonly-pinned']) {
  let successes = 0; const failures = [];
  for (let index = 0; index < 12; index++) {
    const directory = mkdtempSync(join(tmpdir(), 'algopractice-native-backup-'));
    const path = join(directory, 'source.sqlite'), destination = join(directory, 'backup.sqlite');
    const writer = new DatabaseSync(path); let source = writer;
    try {
      writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE evidence (id INTEGER PRIMARY KEY, value INTEGER, data BLOB); INSERT INTO evidence VALUES (1, 0, zeroblob(3145728));');
      if (mode.startsWith('readonly')) source = new DatabaseSync(path, { readOnly: true });
      if (mode === 'readonly-pinned') { source.exec('BEGIN'); source.prepare('SELECT value FROM evidence').get(); }
      if (mode === 'shared-before') writer.exec('BEGIN IMMEDIATE; UPDATE evidence SET value = 1 WHERE id = 1;');
      const pending = backup(source, destination, { rate: 10 }).then(() => ({ success: true }), error => ({ success: false, error: summarizeError(error) }));
      if (mode !== 'shared-before') writer.exec('BEGIN IMMEDIATE; UPDATE evidence SET value = 1 WHERE id = 1;');
      const result = await pending;
      writer.exec('ROLLBACK');
      if (result.success) {
        const saved = new DatabaseSync(destination, { readOnly: true });
        try {
          if (saved.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || saved.prepare('SELECT value FROM evidence').get().value !== 0) throw new Error('Backup snapshot is not the committed value');
        } finally { saved.close(); }
        successes++;
      } else failures.push(result.error);
    } finally { if (source !== writer) source.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  const result = { mode, count: 12, successes, failures }; results.push(result); console.log(JSON.stringify(result));
}

let successes = 0; const failures = [];
for (let index = 0; index < 40; index++) {
  const directory = mkdtempSync(join(tmpdir(), 'algopractice-store-backup-'));
  const store = new PracticeStore(join(directory, 'practice.sqlite'));
  try {
    store.startAttempt({ problemId: 'p1', language: 'python', problemVersion: 'v1', problemSnapshot: { padding: 'x'.repeat(3 * 1024 * 1024) } });
    store.saveDraft({ problemId: 'p1', language: 'python', code: 'generation-0' });
    const pending = store.backupTo(join(directory, 'backup.sqlite')).then(() => ({ success: true }), error => ({ success: false, error: summarizeError(error) }));
    for (let generation = 1; generation <= 8; generation++) {
      store.saveDraft({ problemId: 'p1', language: 'python', code: `generation-${generation}` });
      await new Promise(resolve => setImmediate(resolve));
    }
    const result = await pending; if (result.success) successes++; else failures.push(result.error);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
const storeResult = { mode: 'PracticeStore-current', count: 40, successes, failures }; results.push(storeResult); console.log(JSON.stringify(storeResult));
const output = process.argv[2] ?? new URL('../../../evidence/p3/backup-concurrency-probe.json', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
writeFileSync(output, JSON.stringify({ recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch, sourceSha256: sha256(readFileSync(new URL('../../../src/storage/practice-store.ts', import.meta.url))), probeSha256: sha256(readFileSync(new URL(import.meta.url))), results }, null, 2) + '\n');
