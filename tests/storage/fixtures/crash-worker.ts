import { DatabaseSync } from 'node:sqlite';
import { PracticeStore } from '../../../src/storage/practice-store.ts';

const dbPath = process.argv[2];
if (!dbPath || !process.send) throw new Error('Crash worker requires a database path and IPC');
const store = new PracticeStore(dbPath);
store.saveDraft({ problemId: 'crash-problem', language: 'python', code: 'COMMITTED' });
store.startAttempt({ id: 'committed-attempt', problemId: 'crash-problem', language: 'python', problemVersion: 'v1' });
store.beginRun({ id: 'committed-run', attemptId: 'committed-attempt', code: 'COMMITTED',
  testSuiteVersion: 'tests-v1', adapterVersion: 'adapter-v1', runtimeVersion: 'pending-inspection' });
store.close();

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA cache_size = 8; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
// Force enough dirty pages to exercise real SQLite/WAL recovery, not only JS heap rollback.
db.prepare('UPDATE drafts SET code = ?, code_hash = ?, revision = 2').run('UNCOMMITTED'.repeat(300_000), 'uncommitted-hash');
db.prepare(`INSERT INTO attempts (id, problem_id, language, problem_version, mode, started_at)
  SELECT 'rolledback-attempt', problem_id, language,
  problem_version, mode, started_at FROM attempts WHERE id = 'committed-attempt'`).run();
db.prepare(`INSERT INTO runs SELECT 'rolledback-run', 'rolledback-attempt', code, code_hash,
  test_suite_version, test_snapshot_json, adapter_version, runtime_version, status,
  result_json, created_at, finished_at FROM runs WHERE id = 'committed-run'`).run();
process.send({ state: 'transaction-open', pid: process.pid });
setInterval(() => {}, 1000);
