import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { PracticeStore, hashCode, testConfigDigest } from '../../src/storage/practice-store.ts';
import { buildPracticeAiContext, applyPracticeAiPatch } from '../../src/desktop/learning-context.ts';
import { buildRequestSnapshot } from '../../src/ai/context.ts';
import type { AiPatchApplication, AiRequestInput } from '../../src/shared/ai.ts';
import type { AcmTestConfig, AnswerFormat } from '../../src/shared/answer-format.ts';
import { config } from './helpers.ts';

const tests: AcmTestConfig = { version: 1, compare: 'normalized', cases: [{ stdin: '1\n', expected: '1\n' }] };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-ai-formats-')), store = new PracticeStore(join(directory, 'practice.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const problem = store.upsertProblem({ id: 'leetcode-cn:problem:two-sum', title: '测试', source: 'leetcode-cn', sourceId: '1',
    sourceUrl: 'https://leetcode.cn/problems/two-sum/', description: '原创测试题', descriptionFormat: 'plain', difficulty: '简单', tags: [], constraints: [],
    mode: 'function', starter: { python: 'class Solution: pass' }, adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1], expected: 1 }] });
  function attempt(answerFormat: AnswerFormat) {
    const result = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language: 'python', answerFormat });
    store.saveDraft({ problemId: problem.id, language: 'python', answerFormat, code: `# ${answerFormat}`, ...(answerFormat === 'acm' ? { testConfig: tests } : {}) });
    return result;
  }
  return { store, problem, attempt };
}
const request = (attemptId: string, runId?: string): AiRequestInput => ({ requestId: 'test-ai', attemptId, kind: 'diagnosis', question: '', ...(runId ? { runId } : {}) });

test('AI context resolves the requested format draft and only current test evidence; same code old tests stay historical', t => {
  const { store, problem, attempt } = fixture(t), fn = attempt('function'), acm = attempt('acm');
  assert.equal(buildPracticeAiContext(store, request(fn.id)).code, '# function');
  const digest = testConfigDigest(tests)!;
  const run = store.beginRun({ id: 'run-original-tests', attemptId: acm.id, code: '# acm', testSuiteVersion: digest, testConfigDigest: digest,
    testSnapshot: { cases: tests.cases, acmCompare: tests.compare, answerFormat: 'acm', specVersion: acm.specVersion, testConfigDigest: digest } as never,
    adapterVersion: 'none', runtimeVersion: 'Python 3.14.7' });
  store.finishRun(run.id, { status: 'passed', result: { stdout: '1\n', stderr: '', diagnostics: [], caseResults: [{ index: 0, status: 'passed', actual: '1\n', expected: '1\n' }] } });
  const current = buildPracticeAiContext(store, request(acm.id));
  assert.equal(current.answerFormat, 'acm'); assert.equal(current.run?.id, run.id); assert.equal(current.expectedOutputSource, 'user');
  assert.equal(current.official, null); assert.deepEqual(store.getDraft(problem.id, 'python', 'practice', 'acm')!.testConfig, tests, 'beginRun preserves stdin');
  store.saveDraft({ problemId: problem.id, language: 'python', answerFormat: 'acm', code: '# acm', testConfig: { ...tests, compare: 'exact' } });
  assert.equal(buildPracticeAiContext(store, request(acm.id)).run, null);
  const selected = buildPracticeAiContext(store, request(acm.id, run.id));
  assert.equal(selected.run, null); assert.equal(selected.previousRun?.run.id, run.id);
  assert.doesNotThrow(() => buildRequestSnapshot(request(acm.id, run.id), selected, config()));
  assert.throws(() => buildPracticeAiContext(store, request(fn.id, run.id)), /不属于/);
});

test('function evidence digest matches main runtime identity and cannot borrow ACM results', t => {
  const { store, problem, attempt } = fixture(t), fn = attempt('function');
  const digest = hashCode(JSON.stringify([problem.content.cases, 'normalized']));
  const run = store.beginRun({ id: 'function-run', attemptId: fn.id, code: '# function', testSuiteVersion: digest,
    testSnapshot: { cases: problem.content.cases, acmCompare: 'normalized', answerFormat: 'function', specVersion: fn.specVersion, testConfigDigest: null } as never,
    adapterVersion: 'adapter', runtimeVersion: 'Python 3.14.7' });
  store.finishRun(run.id, { status: 'completed', result: { diagnostics: [], caseResults: [], stdout: '', stderr: '' } });
  const context = buildPracticeAiContext(store, request(fn.id));
  assert.equal(context.testConfigDigest, digest); assert.equal(context.run?.testConfigDigest, digest);
  assert.doesNotThrow(() => buildRequestSnapshot(request(fn.id), context, config()));
});

test('patch revalidation isolates the format, rejects intervening test edits and preserves saved stdin', t => {
  const { store, problem, attempt } = fixture(t); attempt('function'); const acm = attempt('acm');
  const context = buildPracticeAiContext(store, request(acm.id));
  const patch: AiPatchApplication = { requestId: 'patch', attemptId: acm.id, problemId: problem.id, problemVersion: problem.version,
    language: 'python', draftScopeId: 'practice', expectedDraftRevision: context.draftRevision, baseCodeHash: hashCode(context.code), code: 'print(1)',
    answerFormat: context.answerFormat, specVersion: context.specVersion, testConfigDigest: context.testConfigDigest };
  assert.throws(() => applyPracticeAiPatch(store, { ...patch, answerFormat: 'function' }), /已经变化/);
  const saved = applyPracticeAiPatch(store, patch);
  assert.equal(saved.code, 'print(1)'); assert.deepEqual(saved.testConfig, tests);
  assert.equal(store.getDraft(problem.id, 'python', 'practice', 'function')!.code, '# function');
  const next = { ...patch, baseCodeHash: saved.codeHash, expectedDraftRevision: saved.revision };
  store.saveDraft({ problemId: problem.id, language: 'python', answerFormat: 'acm', code: saved.code,
    testConfig: { ...tests, cases: [{ stdin: '', expected: '' }] } });
  assert.throws(() => applyPracticeAiPatch(store, next), /已经变化/);
});

test('ended ACM AI archive freezes final code and tests even when a new same-scope practice changes both', t => {
  const { store, problem, attempt } = fixture(t), acm = attempt('acm');
  const finished = store.finishAttempt(acm.id);
  assert.deepEqual(finished.finalTestConfig, tests);
  const next = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language: 'python', answerFormat: 'acm' });
  store.saveDraft({ problemId: problem.id, language: 'python', answerFormat: 'acm', code: 'new practice', testConfig: { ...tests, compare: 'exact' } });
  const old = buildPracticeAiContext(store, request(acm.id)), active = buildPracticeAiContext(store, request(next.id));
  assert.equal(old.code, '# acm'); assert.deepEqual(old.testConfig, tests); assert.equal(old.isActive, false);
  assert.equal(active.code, 'new practice'); assert.equal(active.testConfig?.compare, 'exact');
});

test('beginRun rejects a stale test snapshot atomically and cannot overwrite another format', t => {
  const { store, problem, attempt } = fixture(t); attempt('function'); const acm = attempt('acm');
  const old = store.getDraft(problem.id, 'python', 'practice', 'acm')!;
  const other = { ...tests, compare: 'exact' as const }, digest = testConfigDigest(other)!;
  assert.throws(() => store.beginRun({ id: 'stale', attemptId: acm.id, code: 'overwriting code', expectedDraftRevision: old.revision,
    testSuiteVersion: digest, testConfigDigest: digest, testSnapshot: { cases: other.cases, acmCompare: other.compare, testConfigDigest: digest } as never,
    adapterVersion: 'none', runtimeVersion: 'Python 3.14.7' }), /tests have changed/);
  assert.deepEqual(store.getDraft(problem.id, 'python', 'practice', 'acm'), old);
  assert.equal(store.getDraft(problem.id, 'python', 'practice', 'function')!.code, '# function');
  assert.equal(store.getRun('stale'), undefined);
});

test('hint and code check read the current editor draft without any local run or official submission', t => {
  const { store, problem, attempt } = fixture(t), fn = attempt('function');
  for (const kind of ['hint', 'diagnosis'] as const) {
    const input: AiRequestInput = { requestId: `no-run-${kind}`, attemptId: fn.id, kind, question: '' };
    const context = buildPracticeAiContext(store, input);
    assert.equal(context.code, '# function'); assert.equal(context.run, null); assert.equal(context.official, null);
    assert.equal(context.problem.description, problem.content.description);
    assert.doesNotThrow(() => buildRequestSnapshot(input, context, config()));
  }
});

test('official analysis requires an actual completed submission of this attempt and freezes its code revision', t => {
  const { store, problem, attempt } = fixture(t), fn = attempt('function');
  const draft = store.getDraft(problem.id, 'python', 'practice', 'function')!;
  const row = store.beginOfficialSubmission({ requestId: 'official-ai-source', attemptId: fn.id, code: draft.code,
    expectedDraftRevision: draft.revision, slug: 'two-sum', sourceId: '1' });
  const input: AiRequestInput = { requestId: 'official-ai', attemptId: fn.id, kind: 'official-review', question: '', officialSubmissionId: row.id };
  assert.throws(() => buildPracticeAiContext(store, input), /有效的判题/);
  store.updateOfficialSubmission(row.id, { status: 'judging', submissionId: '101' });
  store.updateOfficialSubmission(row.id, { status: 'completed', result: { status: 'wrong_answer', statusMessage: 'Wrong Answer', input: '1', actualOutput: '0', expectedOutput: '1' } });
  store.saveDraft({ problemId: problem.id, language: 'python', answerFormat: 'function', code: '# newer unsent implementation' });
  const context = buildPracticeAiContext(store, input);
  assert.equal(context.code, row.code); assert.equal(context.draftRevision, row.draftRevision);
  assert.equal(context.official?.id, row.id); assert.equal(context.official?.codeHash, row.codeHash);
  assert.equal(context.official?.status, 'wrong_answer'); assert.doesNotThrow(() => buildRequestSnapshot(input, context, config()));
  assert.throws(() => buildPracticeAiContext(store, { ...input, kind: 'diagnosis' }), /只有官方分析/);
  assert.throws(() => buildPracticeAiContext(store, { ...input, officialSubmissionId: 'missing' }), /有效的判题/);
  const acm = attempt('acm'); assert.throws(() => buildPracticeAiContext(store, { ...input, attemptId: acm.id }), /有效的判题/);
});
