import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { PracticeStore } from '../src/storage/practice-store.ts';
import type { ProblemContent } from '../src/shared/library.ts';

// Entirely authored fixture in a temporary profile. No user content or network.
const [directory, metadataPath] = process.argv.slice(2);
if (!directory || !metadataPath) throw new Error('Pass an isolated data directory and metadata path');
mkdirSync(directory, { recursive: true });
const code = 'class Solution:\n    def arrayTotal(self, nums: list[int]) -> int:\n        total = 0\n        for number in nums:\n            total += number\n        return total\n';
const problem: ProblemContent = {
  id: 'workbench-history-synthetic', source: 'leetcode-cn', sourceId: '987654',
  sourceUrl: 'https://leetcode.cn/problems/workbench-history-synthetic/', title: '工作台验收：数组累加', difficulty: '简单', tags: ['合成验收'],
  description: '合成验收题：返回数组中整数的总和。空数组返回零。', descriptionFormat: 'plain', constraints: [], mode: 'function',
  adapter: { method: 'arrayTotal', params: [{ array: 'int' }], returns: 'int' },
  cases: [{ args: [[1, 2, 3]], expected: 6 }, { args: [[]], expected: 0 }, { args: [[-3, 3, 7]], expected: 7 }],
  starter: { python: code, java: 'class Solution { public int arrayTotal(int[] nums) { return 0; } }' },
};
const now = Date.now();
mock.timers.enable({ apis: ['Date'], now: now - 3 * 86400000 });
const store = new PracticeStore(join(directory, 'practice.sqlite'));
const rows: { source: 'local' | 'official'; id: string; code: string; attemptId: string }[] = [];
try {
  const saved = store.upsertProblem(problem);
  for (let group = 0; group < 2; group++) {
    mock.timers.setTime(now - (3 - group) * 86400000);
    const attempt = store.startAttempt({ id: `workbench-history-attempt-${group}`, problemId: problem.id, problemVersion: saved.version, language: 'python' });
    for (let index = 0; index < 24; index++) {
      mock.timers.setTime(now - (3 - group) * 86400000 + (index + 1) * 60000);
      const historical = `${code}\n# archived approach ${group}-${index}\n`;
      const id = `workbench-history-${group}-${String(index).padStart(2, '0')}`;
      if (index % 2 === 0) {
        const row = store.saveRun({ id, attemptId: attempt.id, code: historical, testSuiteVersion: 'synthetic-v1',
          testSnapshot: JSON.parse(JSON.stringify({ cases: problem.cases })), adapterVersion: 'synthetic-adapter-v1', runtimeVersion: 'synthetic-python',
          status: 'passed', result: { status: 'passed', durationMs: 10, trustworthyExpected: true, diagnostics: [], stdout: '', stderr: '',
            caseResults: problem.cases.map((test, caseIndex) => ({ index: caseIndex, status: 'passed', expected: test.expected ?? null, actual: test.expected ?? null })) } });
        rows.push({ source: 'local', id: row.id, code: historical, attemptId: attempt.id });
      } else {
        const draft = store.saveDraft({ problemId: problem.id, language: 'python', code: historical });
        store.beginOfficialSubmission({ requestId: id, attemptId: attempt.id, code: historical, expectedDraftRevision: draft.revision,
          slug: 'workbench-history-synthetic', sourceId: '987654' });
        store.updateOfficialSubmission(id, { status: 'judging', submissionId: String(800000 + group * 100 + index) });
        store.updateOfficialSubmission(id, { status: 'completed', result: { status: 'accepted', statusCode: 10, statusMessage: 'Accepted', passedCases: 65, totalCases: 65, runtime: '3 ms', memory: '18 MB' } });
        rows.push({ source: 'official', id, code: historical, attemptId: attempt.id });
      }
    }
    store.finishAttempt(attempt.id, { code: `${code}\n# archived approach ${group}-23\n` });
  }
  mock.timers.setTime(now - 60000);
  const active = store.startAttempt({ id: 'workbench-history-current', problemId: problem.id, problemVersion: saved.version, language: 'python' });
  const draft = store.saveDraft({ problemId: problem.id, language: 'python', code });
  store.integrityCheck();
  writeFileSync(metadataPath, JSON.stringify({ synthetic: true, problem, code, active, draft, rows }, null, 2));
} finally { store.close(); mock.timers.reset(); }
