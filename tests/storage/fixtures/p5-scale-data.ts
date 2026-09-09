import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../../../src/ai/canonical.ts';
import { PracticeStore, hashCode } from '../../../src/storage/practice-store.ts';
import type { RunResult } from '../../../src/runner/types.ts';
import type { ProblemContent } from '../../../src/shared/library.ts';

export const SCALE_COUNTS = { problems: 5000, attempts: 100, runs: 10000, notes: 2000, noteVersions: 4000, longAttemptRuns: 5000 };
const base = Date.parse('2026-09-01T00:00:00.000Z');
const at = (index: number) => new Date(base + index * 1000).toISOString();
const id = (index: number) => `scale:${String(index).padStart(5, '0')}`;

/** Real schema-5 SQLite rows with large bodies; synthetic workload, never claimed as user activity. */
export function createScaleFixture(dbPath: string) {
  if (existsSync(dbPath)) throw new Error('Scale fixture destination must be new');
  new PracticeStore(dbPath).close();
  const db = new DatabaseSync(dbPath), versions: string[] = [];
  const statementBody = 'PROBLEM_BODY_EXCLUDED_FROM_LIST '.repeat(160);
  const codeBody = '# RUN_CODE_EXCLUDED_FROM_LIST\n'.repeat(300);
  const runBody = 'RUN_RESULT_EXCLUDED_FROM_LIST '.repeat(290);
  const noteBody = 'NOTE_BODY_EXCLUDED_FROM_LIST '.repeat(300);
  const started = performance.now();
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    const insertProblem = db.prepare('INSERT INTO problems VALUES (?)');
    const insertVersion = db.prepare('INSERT INTO problem_versions VALUES (?, ?, ?)');
    const insertHead = db.prepare('INSERT INTO library_problem_heads VALUES (?, ?, ?, ?)');
    for (let index = 0; index < SCALE_COUNTS.problems; index++) {
      const runnable = index % 5 !== 0;
      const content: ProblemContent = { id: id(index), title: `${index % 103 === 0 ? '目标' : '算法'}题 ${index}`, difficulty: ['简单', '中等', '困难'][index % 3],
        tags: [index % 3 === 0 ? '二分' : '数组', `batch-${index % 20}`], source: 'file', description: runnable ? statementBody : '',
        descriptionFormat: 'plain', constraints: ['fixture only'], mode: 'acm', cases: runnable ? [{ stdin: '1 2', expected: '3' }] : [],
        starter: runnable ? index % 2 === 0 ? { python: 'print(sum(map(int, input().split())))' } : { java: 'class Main { public static void main(String[] args) { System.out.println(3); } }' } : {} };
      const snapshot = canonicalJson(content), version = `sha256:${hashCode(snapshot)}`; versions.push(version);
      insertProblem.run(content.id); insertVersion.run(content.id, version, snapshot); insertHead.run(content.id, version, at(index), at(index));
    }
    db.prepare('INSERT INTO study_lists VALUES (?, ?, ?, ?, ?, ?, ?)').run('scale-list', 'P5 规模题单', 'file', null, 1, at(0), at(0));
    db.prepare('INSERT INTO list_chapters VALUES (?, ?, ?, ?, ?)').run('scale-list', 'chapter', '前一千题', null, 0);
    const insertListItem = db.prepare('INSERT INTO list_items VALUES (?, ?, ?, ?, ?)');
    for (let index = 0; index < 1000; index++) insertListItem.run('scale-list', `item-${index}`, id(index), 'chapter', index);
    const insertAttempt = db.prepare('INSERT INTO attempts(id,problem_id,language,problem_version,mode,started_at,draft_scope_id) VALUES (?,?,?,?,?,?,?)');
    for (let index = 0; index < SCALE_COUNTS.attempts; index++) {
      const problemIndex = index * 10 + (index % 2 ? 1 : 2);
      insertAttempt.run(`scale-attempt-${index}`, id(problemIndex), index % 2 ? 'java' : 'python', versions[problemIndex], 'practice', at(index * 100), 'practice');
    }
    const insertRun = db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const latest = new Map<number, { id: string; code: string; hash: string }>();
    for (let index = 0; index < SCALE_COUNTS.runs; index++) {
      const attemptIndex = index < 5000 ? 0 : 1 + Math.floor((index - 5000) / 51), runId = `scale-run-${index}`;
      const status = index % 4 === 0 ? 'wrong_answer' : 'passed', actual = status === 'passed' ? '3' : '9';
      const code = attemptIndex % 2 ? `${codeBody.replace(/^#/gm, '//')}\nclass Main { public static void main(String[] args) { System.out.println(${actual}); } } // ${index}` : `${codeBody}\nprint(${actual}) # ${index}`;
      const codeHash = hashCode(code);
      const result = JSON.stringify({ status, diagnostics: [], durationMs: index % 50, stdout: runBody, stderr: '',
        runtimeVersion: 'synthetic-scale-fixture', hostPlatform: 'synthetic-scale-fixture', executionScope: 'local-user-code-not-sandboxed',
        caseResults: [{ index: 0, status, actual, expected: '3', stdout: runBody, stderr: '', durationMs: 1 }] } satisfies RunResult);
      insertRun.run(runId, `scale-attempt-${attemptIndex}`, code, codeHash, 'scale-suite', JSON.stringify({ cases: [{ stdin: '1 2', expected: '3' }], provenance: statementBody }),
        'scale-adapter', 'scale-runtime', status, result, at(attemptIndex * 100 + 1 + (index % 60)), at(attemptIndex * 100 + 2 + (index % 60)));
      latest.set(attemptIndex, { id: runId, code, hash: codeHash });
    }
    const finish = db.prepare('UPDATE attempts SET ended_at=?,final_code=?,final_code_hash=?,final_draft_revision=1,final_last_run_id=?,last_run_matches_final=1 WHERE id=?');
    for (const [index, run] of latest) finish.run(at(index * 100 + 99), run.code, run.hash, run.id, `scale-attempt-${index}`);
    const insertNote = db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertNoteVersion = db.prepare('INSERT INTO note_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let index = 0; index < SCALE_COUNTS.notes; index++) {
      const noteId = `scale-note-${index}`; insertNote.run(noteId, index % 2 ? 'topic' : 'problem', index % 2 ? `topic-${index}` : id(index), 2, 1, at(index), at(index + 1));
      insertNoteVersion.run(noteId, 1, `已确认 ${index}`, `${noteBody} historical-token-${index}`, JSON.stringify(['历史', `batch-${index % 20}`]), 'user', 'confirmed', null, at(index));
      insertNoteVersion.run(noteId, 2, `笔记 ${index}`, `${noteBody} current-token-${index}`, JSON.stringify(['当前', `batch-${index % 20}`]), 'user', 'draft', null, at(index + 1));
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
    if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Invalid scale fixture');
    return { ...SCALE_COUNTS, schemaVersion: db.prepare('PRAGMA user_version').get()!.user_version, dbPath: resolve(dbPath), bytes: statSync(dbPath).size,
      seedMs: performance.now() - started, bodies: { problemChars: statementBody.length, runCodeChars: codeBody.length, runResultChars: runBody.length * 2, runTestSnapshotChars: statementBody.length, noteVersionChars: noteBody.length } };
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node --import tsx tests/storage/fixtures/p5-scale-data.ts /new/path/practice.sqlite');
  console.log(JSON.stringify(createScaleFixture(resolve(process.argv[2])), null, 2));
}
