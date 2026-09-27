import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { PracticeStore, hashCode, testConfigDigest } from '../../src/storage/practice-store.ts';
import { resolvePracticeSpec, serializeAcmTestConfig, validateAcmTestConfig, type AcmTestConfig } from '../../src/shared/answer-format.ts';
import { stripAnswerFormatSchema } from './fixtures/pre-v8.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-answer-format-')), dbPath = join(directory, 'practice.sqlite');
  const store = new PracticeStore(dbPath);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const problem = store.upsertProblem({ id: 'leetcode-cn:problem:fixture', source: 'leetcode-cn', sourceId: '1', sourceUrl: 'https://leetcode.cn/problems/two-sum/',
    title: '原创测试', description: '用于测试格式隔离', difficulty: '简单', descriptionFormat: 'plain', constraints: [], tags: [], mode: 'function',
    starter: { python: 'class Solution: pass', java: 'class Solution {}' }, adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1], expected: 1 }] });
  return { directory, dbPath, store, problem };
}
const tests: AcmTestConfig = { version: 1, compare: 'normalized', cases: [{ stdin: '' }, { stdin: '1\n', expected: '' }] };

test('two languages and two formats have independent persistent drafts and active attempts', t => {
  const { store, problem } = fixture(t);
  for (const language of ['python', 'java'] as const) for (const answerFormat of ['function', 'acm'] as const) {
    const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language, answerFormat });
    const code = `${language}-${answerFormat}`;
    const draft = store.saveDraft({ problemId: problem.id, language, answerFormat, code, ...(answerFormat === 'acm' ? { testConfig: tests } : {}) });
    assert.equal(draft.answerFormat, answerFormat);
    assert.equal(store.getActiveAttempt(problem.id, language, 'practice', 'practice', answerFormat)?.id, attempt.id);
    assert.equal(store.getDraft(problem.id, language, 'practice', answerFormat)?.code, code);
  }
  assert.equal(store.listAttempts(problem.id).length, 4);
  assert.equal(store.getDraft(problem.id, 'python')?.code, 'python-function', 'old callers retain native format');
  const acm = store.getActiveAttempt(problem.id, 'python', 'practice', 'practice', 'acm')!;
  assert.throws(() => store.beginOfficialSubmission({ requestId: 'acm-official', attemptId: acm.id, code: 'python-acm', slug: 'two-sum', sourceId: '1' }), /ACM/);
  store.integrityCheck();
});

test('ACM test edits increment draft revision, stale prior results, and restore the original input configuration', t => {
  const { store, problem } = fixture(t), answerFormat = 'acm' as const;
  const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language: 'python', answerFormat });
  const draft = store.saveDraft({ problemId: problem.id, language: 'python', answerFormat, code: 'print(1)', testConfig: tests });
  const digest = testConfigDigest(tests)!;
  assert.equal(digest, hashCode(serializeAcmTestConfig(tests)));
  assert.equal(draft.testConfigDigest, digest);
  const run = store.beginRun({ id: 'acm-run', attemptId: attempt.id, code: draft.code, expectedDraftRevision: draft.revision,
    answerFormat, specVersion: attempt.specVersion, testConfigDigest: digest, testSuiteVersion: digest,
    testSnapshot: { cases: tests.cases, acmCompare: tests.compare, answerFormat, specVersion: attempt.specVersion, testConfigDigest: digest } as never,
    adapterVersion: 'acm-none-v1', runtimeVersion: 'Python 3.14.7' });
  store.finishRun(run.id, { status: 'completed', result: { status: 'completed' } });
  const changed = store.saveDraft({ problemId: problem.id, language: 'python', answerFormat, code: draft.code,
    expectedRevision: draft.revision, testConfig: { ...tests, compare: 'exact' } });
  assert.equal(changed.revision, draft.revision + 1); assert.notEqual(changed.testConfigDigest, digest);
  assert.equal(store.finishAttempt(attempt.id).lastRunMatchesFinal, false);
  const restored = store.restoreRunAsDraft(run.id, { requestId: 'restore-acm' });
  assert.equal(restored.attempt.answerFormat, answerFormat); assert.deepEqual(restored.draft.testConfig, tests);
  assert.equal(store.listSubmissionHistory({ problemId: problem.id, language: 'python', answerFormat: 'function' }).total, 0);
  assert.equal(store.listSubmissionHistory({ problemId: problem.id, language: 'python', answerFormat }).items[0].answerFormat, 'acm');
});

test('ACM free spec never reuses function args; unknown expected and empty expected remain different', t => {
  const { problem } = fixture(t), spec = resolvePracticeSpec(problem.content, problem.version, 'acm');
  assert.equal(spec.specVersion, 'acm-free-v1'); assert.equal(problem.content.mode, 'function');
  assert.deepEqual(spec.content.cases, [{ stdin: '' }]); assert.equal(spec.content.adapter, undefined);
  assert.match(spec.content.starter.java!, /public class Main/);
  assert.notEqual(testConfigDigest({ ...tests, cases: [{ stdin: '' }] }), testConfigDigest({ ...tests, cases: [{ stdin: '', expected: '' }] }));
  assert.throws(() => validateAcmTestConfig({ ...tests, cases: [{ stdin: '', expected: null }] }));
  assert.throws(() => validateAcmTestConfig({ ...tests, cases: Array.from({ length: 51 }, () => ({ stdin: '' })) }));
  assert.throws(() => resolvePracticeSpec({ ...problem.content, mode: 'acm' }, problem.version, 'function'));
  assert.doesNotThrow(() => resolvePracticeSpec({ ...problem.content, adapter: undefined }, problem.version, 'function'));
});

test('real v7 upgrade preserves native ACM, finished immutability, unknown drafts, and a recoverable backup', t => {
  const { store, dbPath, directory, problem } = fixture(t);
  const native = store.upsertProblem({ ...problem.content, id: 'local:acm', source: 'local', mode: 'acm', adapter: undefined,
    cases: [{ stdin: '', expected: '' }], starter: { python: 'pass' } });
  const attempt = store.startAttempt({ problemId: native.id, problemVersion: native.version, language: 'python' });
  store.finishAttempt(attempt.id, { code: 'original ACM' });
  store.saveDraft({ problemId: 'orphan', language: 'java', code: 'unknown retained' });
  const oldFunction = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language: 'python' });
  store.finishAttempt(oldFunction.id, { code: 'finished original function' });
  store.upsertProblem({ ...problem.content, mode: 'acm', adapter: undefined, cases: [{ stdin: '' }], starter: { python: 'pass' } });
  store.close();
  const old = new DatabaseSync(dbPath); stripAnswerFormatSchema(old); old.close();
  const upgraded = new PracticeStore(dbPath);
  try {
    assert.equal(PracticeStore.inspectBackupSnapshot(upgraded.migrationBackupPath!).schemaVersion, 7);
    const restoredPath = join(directory, 'restored-v7.sqlite');
    PracticeStore.restoreBackup(upgraded.migrationBackupPath!, restoredPath);
    const restored = new PracticeStore(restoredPath);
    try { assert.equal(restored.getAttempt(attempt.id)?.answerFormat, 'acm'); assert.equal(restored.listLegacyDrafts('orphan')[0].code, 'unknown retained'); restored.integrityCheck(); }
    finally { restored.close(); }
    assert.equal(upgraded.getAttempt(attempt.id)?.answerFormat, 'acm');
    assert.equal(upgraded.getDraft(native.id, 'python', 'practice', 'acm')?.code, 'original ACM');
    assert.equal(upgraded.listLegacyDrafts(problem.id)[0].code, 'finished original function', 'a new ACM head cannot relabel an old function draft');
    assert.equal(upgraded.getDraft(problem.id, 'python', 'practice', 'acm'), undefined);
    assert.equal(upgraded.listLegacyDrafts('orphan')[0].code, 'unknown retained');
    assert.equal(upgraded.getDraft('orphan', 'java', 'practice', 'function'), undefined);
    upgraded.saveDraft({ problemId: 'orphan', language: 'java', answerFormat: 'function', code: 'new explicit draft' });
    assert.equal(upgraded.listLegacyDrafts('orphan')[0].code, 'unknown retained');
    assert.throws(() => upgraded.finishAttempt(attempt.id, { code: 'overwrite' }), /different final/);
    upgraded.integrityCheck();
  } finally { upgraded.close(); }
  const reopened = new PracticeStore(dbPath);
  try { assert.equal(reopened.migrationBackupPath, null); assert.equal(reopened.listLegacyDrafts('orphan').length, 1); } finally { reopened.close(); }
});
