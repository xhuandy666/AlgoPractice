import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PracticeStore, hashCode } from '../../../src/storage/practice-store.ts';
import { demoContent } from '../../../src/shared/presentation.ts';
import { demoProblems } from '../../../src/shared/demo-problems.ts';
import { canonicalJson } from '../../../src/ai/canonical.ts';

// Synthetic statements, code and history only. Never copy an installed user's DB.
const file = process.argv[2], count = Number(process.argv[3]);
if (!file || existsSync(file) || !Number.isInteger(count) || count < 1 || count > 5000) throw new Error('Expected a new database path and 1–5000 synthetic problems');
mkdirSync(dirname(file), { recursive: true });
let store = new PracticeStore(file); store.close();
const now = new Date().toISOString();
const description = '<p>Given an array, calculate a running total and return its final value. Consider an empty array and negative elements.</p>'.repeat(40);
const code = 'class Solution:\n    def arrayTotal(self, nums):\n        return sum(nums)\n' + '# Long practice draft for performance testing\n'.repeat(450);
const db = new DatabaseSync(file);
try {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  const insertProblem = db.prepare('INSERT INTO problems VALUES (?)');
  const insertVersion = db.prepare('INSERT INTO problem_versions VALUES (?,?,?)');
  const insertHead = db.prepare('INSERT INTO library_problem_heads VALUES (?,?,?,?)');
  for (let index = 0; index < count; index++) {
    const content = { ...demoContent(demoProblems[0]), id: index === 0 ? 'array-total' : `perf-${index}`, title: index === 0 ? '数组求和' : `合成练习 ${index}`,
      descriptionFormat: 'html', description, starter: { python: code, java: 'class Solution {}' } };
    const text = canonicalJson(content), version = `sha256:${hashCode(text)}`;
    insertProblem.run(content.id); insertVersion.run(content.id, version, text); insertHead.run(content.id, version, now, now);
  }
  db.exec('COMMIT');
} finally { db.close(); }
store = new PracticeStore(file);
const problem = store.getProblem('array-total')!;
const attempt = store.startAttempt({ problemId: problem.id, language: 'python', problemVersion: problem.version, problemSnapshot: JSON.parse(JSON.stringify(problem.content)) });
store.saveDraft({ problemId: problem.id, language: 'python', code }); store.close();
const history = new DatabaseSync(file);
try {
  history.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  const insertRun = history.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  for (let index = 0; index < 20; index++) {
    const result = { status: 'passed', diagnostics: [], durationMs: 2, stdout: '', stderr: '', runtimeVersion: 'synthetic-performance-fixture', hostPlatform: 'synthetic',
      executionScope: 'local-user-code-not-sandboxed', caseResults: [{ index: 0, status: 'passed', actual: 3, expected: 3, stdout: '', stderr: '', durationMs: 1 }] };
    insertRun.run(`perf-run-${index}`, attempt.id, code, hashCode(code), 'fixture-suite', '{}', 'fixture-adapter', 'fixture-runtime', 'passed', JSON.stringify(result), now, now);
  }
  history.exec('COMMIT');
} finally { history.close(); }
console.log(JSON.stringify({ problems: count, descriptionChars: description.length, codeChars: code.length, historyRuns: 20 }));
