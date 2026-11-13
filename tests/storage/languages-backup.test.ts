import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { LANGUAGES } from '../../src/shared/languages.ts';
import { restoreBackup } from '../restore-backup.ts';

const originalContent = { id: 'old', source: 'local', title: '原题', difficulty: '简单', tags: [],
  description: '旧题面不得更改', descriptionFormat: 'plain', constraints: [], mode: 'function',
  adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1], expected: 1 }],
  starter: { python: 'class Solution: pass', java: 'class Solution {}' } };

function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'tilian-languages '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('four languages, two answer formats and independent scopes survive backup/restore with revision CAS and immutable run identities', async t => {
  const root = directory(t), path = join(root, 'practice.sqlite'), store = new PracticeStore(path);
  try {
    const problem = store.upsertProblem({ ...originalContent, descriptionFormat: 'plain', mode: 'function', source: 'local',
      adapter: { method: 'solve', params: ['int'], returns: 'int' }, starter: Object.fromEntries(LANGUAGES.map(language => [language, `${language} template`])) });
    for (const language of LANGUAGES) for (const answerFormat of ['function', 'acm'] as const) for (const scopeId of ['practice', 'isolated']) {
      const code = `${language}-${answerFormat}-${scopeId}`;
      const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language, answerFormat, draftScopeId: scopeId });
      const draft = store.saveDraft({ problemId: problem.id, language, answerFormat, scopeId, code, expectedRevision: 0,
        ...(answerFormat === 'acm' ? { testConfig: { version: 1, compare: 'exact', cases: [{ stdin: language, expected: '' }] } } as const : {}) });
      assert.equal(draft.revision, 1);
      assert.throws(() => store.saveDraft({ problemId: problem.id, language, answerFormat, scopeId, code: 'stale', expectedRevision: 0 }), /revision conflict/);
      const run = store.saveRun({ attemptId: attempt.id, code, testSuiteVersion: 'suite', expectedOutputSource: 'none', adapterVersion: 'v1', runtimeVersion: `${language}-test`, status: 'completed', result: {} });
      assert.equal(run.language, language); assert.equal(run.answerFormat, answerFormat);
      assert.equal(store.getActiveAttempt(problem.id, language, 'practice', scopeId, answerFormat)?.id, attempt.id);
      if (scopeId === 'isolated') store.finishAttempt(attempt.id);
    }
    assert.equal(store.listAttempts(problem.id).length, 16);
    const backup = join(root, 'four-languages.sqlite'); await store.backupTo(backup);
    const restoredPath = join(root, 'restored.sqlite'); restoreBackup(backup, restoredPath);
    const restored = new PracticeStore(restoredPath);
    try {
      for (const language of LANGUAGES) for (const format of ['function', 'acm'] as const) for (const scope of ['practice', 'isolated']) {
        assert.equal(restored.getDraft(problem.id, language, scope, format)?.code, `${language}-${format}-${scope}`);
      }
      assert.equal(restored.listAttempts(problem.id).length, 16); restored.integrityCheck();
    } finally { restored.close(); }
  } finally { store.close(); }
});
