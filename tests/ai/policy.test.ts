import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestSnapshot, canonicalJson, sha256, validateResponse } from '../../src/ai/index.ts';
import type { AiRequestSnapshot, AiResponse } from '../../src/shared/ai.ts';
import { AiValidationError } from '../../src/ai/policy.ts';
import { answer, config, context, input } from './helpers.ts';
import { policyScenarios } from './policy-scenarios.ts';

for (const row of policyScenarios) test(`${row.id}: ${row.name} [automated fixture; human review pending]`, () => {
  const evaluate = () => validateResponse(row.raw ?? JSON.stringify(row.response), buildRequestSnapshot(row.request, row.context, config()));
  if (row.expected === 'accept') assert.doesNotThrow(evaluate); else assert.throws(evaluate);
});
test('At least 30 policy fixtures exist, and none are mislabeled as human reviewed', () => { assert.ok(policyScenarios.length >= 30); assert.ok(policyScenarios.every(row => row.humanReview === 'pending')); });

test('Legacy schema 1 records still validate under their original policy and hash contract', async () => {
  const { context, input, answer } = await import('./helpers.ts');
  const snapshot = buildRequestSnapshot(input(), context(), config());
  snapshot.policyVersion = 'algopractice-ai-policy-v1'; snapshot.promptVersion = 'algopractice-tutor-v1'; snapshot.level = 'L2'; snapshot.unlockCompleteSolution = false;
  const response = { ...answer(), schemaVersion: 1 as const, level: 'L2' as const };
  assert.deepEqual(validateResponse(JSON.stringify(response), snapshot), response);
  assert.throws(() => validateResponse(JSON.stringify({ ...response, completeSolution: { explanation: '旧记录', code: 'return 0' } }), snapshot));
});
test('Official acceptance can be reported only with matching supplied acceptance evidence', async () => {
  const { context, input, answer } = await import('./helpers.ts');
  const source = context(); source.official = { id: 'official-a', attemptId: source.attemptId, problemVersion: source.problemVersion, codeHash: source.run!.codeHash, status: 'accepted', statusMessage: 'Accepted' };
  const response = answer(); response.explanation = '这份代码已获得官方 AC。'; response.evidence = [{ kind: 'official', runId: 'official-a', quote: 'accepted' }];
  assert.doesNotThrow(() => validateResponse(JSON.stringify(response), buildRequestSnapshot(input(), source, config())));
  source.official.status = 'wrong_answer'; assert.throws(() => validateResponse(JSON.stringify(response), buildRequestSnapshot(input(), source, config())));
  source.official.status = 'accepted'; response.evidence[0].runId = 'another-submission'; assert.throws(() => validateResponse(JSON.stringify(response), buildRequestSnapshot(input(), source, config())));
});
test('Historical errors cannot be quoted as proof against the current code', async () => {
  const { context, input, answer } = await import('./helpers.ts');
  const source = context(), old = source.run!; source.previousRun = { code: source.code, run: old }; source.code += '# current version'; source.run = null;
  const response = answer(); response.evidence = [{ kind: 'test', runId: old.id, quote: 'wrong_answer', caseIndex: 0 }];
  assert.throws(() => validateResponse(JSON.stringify(response), buildRequestSnapshot({ ...input(), runId: old.id }, source, config())));
});

test('Official multiline diagnostics can be quoted verbatim without losing JSON escaping, and invented text is rejected', async () => {
  const { context, input, answer } = await import('./helpers.ts');
  const source = context(), diagnostic = 'Line 6: NameError\nname total is not defined';
  source.official = { id: 'official-error', attemptId: source.attemptId, problemVersion: source.problemVersion, codeHash: source.run!.codeHash, status: 'runtime_error', statusMessage: 'Runtime Error', runtimeError: diagnostic };
  const response = answer(); response.evidence = [{ kind: 'official', runId: 'official-error', quote: diagnostic }];
  const snapshot = buildRequestSnapshot(input(), source, config()); assert.doesNotThrow(() => validateResponse(JSON.stringify(response), snapshot));
  response.evidence[0].quote = 'Invented exception'; assert.throws(() => validateResponse(JSON.stringify(response), snapshot));
});

test('Validation repair hints are fixed internal guidance; public errors expose only safe legacy fields', async () => {
  const { AiValidationError, validationRepairHint } = await import('../../src/ai/policy.ts');
  const { publicAiError } = await import('../../src/ai/errors.ts');
  const error = new AiValidationError('quote');
  assert.match(error.repairHint, /exactly match supplied/);
  Object.assign(error, { providerBody: 'PRIVATE-ERROR-TEXT', cause: new Error('PRIVATE-CAUSE-TEXT'), message: 'PRIVATE-MESSAGE-TEXT' });
  Object.assign(error.detail, { message: 'PRIVATE-DETAIL-MESSAGE', repairHint: 'PRIVATE-HINT', providerBody: 'PRIVATE-DETAIL-BODY' });
  const exposed = publicAiError(error);
  assert.deepEqual(Object.keys(exposed).sort(), ['code', 'message', 'retryable', 'validationReason']); assert.equal(exposed.code, 'POLICY_VIOLATION'); assert.equal(exposed.validationReason, 'quote'); assert.ok(!JSON.stringify(exposed).includes('PRIVATE')); assert.ok(!JSON.stringify(exposed).includes('repairHint'));
  assert.ok(!JSON.stringify(publicAiError(new Error('PRIVATE-UNKNOWN-ERROR'))).includes('PRIVATE'));
  assert.throws(() => new AiValidationError('PRIVATE-UNLISTED-HINT' as never), candidate => !String(candidate).includes('PRIVATE'));
  const forged = Object.create(AiValidationError.prototype); forged.repairHint = 'PRIVATE-FORGED-HINT';
  assert.ok(!validationRepairHint(forged).includes('PRIVATE'));
});

test('Rejected response categories provide actionable fixed repair hints without weakening rejection', async () => {
  const { AiValidationError } = await import('../../src/ai/policy.ts');
  const { context, input, answer } = await import('./helpers.ts');
  const baseline = buildRequestSnapshot(input(), context(), config());
  const cases: Array<{ mutate: (response: ReturnType<typeof answer>, snapshot: typeof baseline) => void; expected: RegExp }> = [
    { mutate: response => { response.kind = 'diagnosis'; }, expected: /original requested kind/ },
    { mutate: response => { response.evidence = [{ runId: 'other', kind: 'test', quote: 'wrong_answer', caseIndex: 0 }]; }, expected: /supplied current-code local run/ },
    { mutate: response => { response.evidence = [{ runId: 'run-a', kind: 'test', quote: 'invented', caseIndex: 0 }]; }, expected: /exactly match supplied/ },
    { mutate: response => { response.patch = { baseCodeHash: '0'.repeat(64), edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] }; }, expected: /exact current codeHash/ },
    { mutate: (response, snapshot) => { snapshot.clippedFields.push('codeWithLineNumbers'); response.patch = { baseCodeHash: snapshot.codeHash, edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] }; }, expected: /numbered reference view is incomplete/ },
    { mutate: (response, snapshot) => { response.patch = { baseCodeHash: snapshot.codeHash, edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] }; }, expected: /supporting supplied evidence or a reasoned code-based inference/ },
    { mutate: response => { response.explanation = '代码已获得官方 AC。'; }, expected: /Check official-success claims against the supplied/ },
    { mutate: response => { response.explanation = '所有测试都已通过。'; }, expected: /Check local-success claims against the supplied/ },
    { mutate: response => { response.explanation = '答案一定正确。'; }, expected: /Remove absolute guarantees/ },
  ];
  for (const row of cases) {
    const snapshot = structuredClone(baseline), response = answer(); row.mutate(response, snapshot);
    assert.throws(() => validateResponse(JSON.stringify(response), snapshot), error => { assert.ok(error instanceof AiValidationError); assert.match(error.repairHint, row.expected); return true; });
  }
});

function acceptedSnapshot(): AiRequestSnapshot {
  const source = context();
  source.code = 'class Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for i, value in enumerate(nums):\n            if target - value in seen:\n                return (i, seen[target - value])\n            seen[value] = i\n';
  source.problem = { title: '两数之和', description: '找到和为 target 的两个不同下标，返回顺序不限。', constraints: ['恰好一个答案'] };
  source.run = { ...source.run!, codeHash: sha256(source.code), status: 'passed', caseResults: [{ index: 0, status: 'passed', actual: [1, 0], expected: [0, 1] }, { index: 1, status: 'passed', actual: [2, 1], expected: [1, 2] }, { index: 2, status: 'passed', actual: [1, 0], expected: [0, 1] }] };
  source.official = { id: 'official-accepted', attemptId: source.attemptId, codeHash: sha256(source.code), problemVersion: source.problemVersion, status: 'accepted', statusMessage: 'Accepted', passedCases: 65, totalCases: 65, runtime: '0 ms', memory: '20.3 MB' };
  return buildRequestSnapshot(input(), source, config());
}
function expectReason(response: unknown, snapshot: AiRequestSnapshot, reason: string): void {
  assert.throws(() => validateResponse(JSON.stringify(response), snapshot), error => error instanceof AiValidationError && error.detail.validationReason === reason);
}

test('Current official and local success facts do not depend on a model citation or magic acceptance word', () => {
  for (const kind of ['hint', 'diagnosis'] as const) {
    const snapshot = acceptedSnapshot(); snapshot.kind = kind;
    for (const quote of [null, 'Accepted', '"passedCases":65']) {
      const response = { ...answer(), kind, explanation: '官方已通过这份代码，提交记录为 65/65。', evidence: quote === null ? [] : [{ kind: 'official' as const, runId: snapshot.official!.id, quote }] };
      assert.doesNotThrow(() => validateResponse(JSON.stringify(response), snapshot));
    }
    snapshot.official = null;
    assert.doesNotThrow(() => validateResponse(JSON.stringify({ ...answer(), kind, explanation: '本地所有测试都已通过，共 3 个用例。', evidence: [] }), snapshot));
  }
});

test('Success cannot borrow missing, stale, foreign-attempt or unsuccessful source facts without any citation', () => {
  for (const source of ['official', 'run'] as const) {
    for (const mutation of ['missing', 'codeHash', 'problemVersion', 'attemptId', 'status'] as const) {
      const snapshot = acceptedSnapshot();
      if (mutation === 'missing') snapshot[source] = null;
      else if (mutation === 'status') snapshot[source]!.status = 'wrong_answer';
      else snapshot[source]![mutation] = 'foreign-value';
      const response = { ...answer(), explanation: source === 'official' ? '官方已通过这份代码。' : '本地所有测试都已通过。', evidence: [] };
      expectReason(response, snapshot, source === 'official' ? 'officialSuccess' : 'localSuccess');
    }
  }
  for (const mutation of ['untrusted', 'missing-expected', 'case-failure', 'no-cases']) {
    const snapshot = acceptedSnapshot();
    if (mutation === 'untrusted') snapshot.run!.trustworthyExpected = false;
    if (mutation === 'missing-expected') delete snapshot.run!.caseResults[0].expected;
    if (mutation === 'case-failure') snapshot.run!.caseResults[0].status = 'wrong_answer';
    if (mutation === 'no-cases') snapshot.run!.caseResults = [];
    expectReason({ ...answer(), explanation: '本地所有测试都已通过。' }, snapshot, 'localSuccess');
  }
});

test('Official acceptance cannot certify local failures and local passes cannot certify an official failure', () => {
  const snapshot = acceptedSnapshot(); snapshot.run!.status = 'wrong_answer'; snapshot.run!.caseResults[0].status = 'wrong_answer';
  expectReason({ ...answer(), explanation: '本地所有测试都已通过。', evidence: [{ kind: 'official', runId: snapshot.official!.id, quote: 'Accepted' }] }, snapshot, 'localSuccess');
  assert.doesNotThrow(() => validateResponse(JSON.stringify({ ...answer(), explanation: '官方已通过；本地还没有全部通过。' }), snapshot));
  const localOnly = acceptedSnapshot(); localOnly.official!.status = 'wrong_answer'; localOnly.official!.statusMessage = 'Wrong Answer';
  expectReason({ ...answer(), explanation: '官方所有测试都已通过。' }, localOnly, 'officialSuccess');
  assert.doesNotThrow(() => validateResponse(JSON.stringify({ ...answer(), explanation: '本地所有测试都已通过。' }), localOnly));
  assert.doesNotThrow(() => validateResponse(JSON.stringify({ ...answer(), explanation: '官方尚未全部通过，先查看失败结果。' }), localOnly));
});

for (const disclaimer of ['官方通过不代表本地所有测试都通过。', '官方 Accepted 并不能说明本地所有测试都通过。']) {
  test(`A source-qualified negation remains a disclaimer: ${disclaimer}`, () => {
    const snapshot = acceptedSnapshot(); snapshot.run = null;
    assert.doesNotThrow(() => validateResponse(JSON.stringify({ ...answer(), explanation: disclaimer }), snapshot));
    for (const separator of ['但', '，', '；']) {
      expectReason({ ...answer(), explanation: `${disclaimer.slice(0, -1)}${separator}本地所有测试都通过。` }, snapshot, 'localSuccess');
    }
    expectReason({ ...answer(), explanation: disclaimer.replace('不代表', '代表').replace('并不能说明', '说明') }, snapshot, 'localSuccess');
  });
}

test('An explicit official full-count success needs accepted status and cannot borrow a preceding negation', () => {
  const snapshot = acceptedSnapshot(); snapshot.official!.status = 'wrong_answer'; snapshot.official!.statusMessage = 'Wrong Answer';
  expectReason({ ...answer(), explanation: '官方测试已全数通过。' }, snapshot, 'officialSuccess');
  assert.doesNotThrow(() => validateResponse(JSON.stringify({ ...answer(), explanation: '官方测试尚未全数通过。' }), snapshot));
  expectReason({ ...answer(), explanation: '不能说明本地所有测试都通过，但官方测试已全数通过。' }, snapshot, 'officialSuccess');
  snapshot.official!.status = 'accepted'; snapshot.official!.statusMessage = 'Accepted';
  assert.doesNotThrow(() => validateResponse(JSON.stringify({ ...answer(), explanation: '官方测试已全数通过。' }), snapshot));
});

test('JSON evidence accepts verified projections and formatting, rebuilding newly accepted quotes from trusted values', () => {
  const snapshot = acceptedSnapshot();
  const fields = { status: 'accepted', passedCases: 65, totalCases: 65, runtime: '0 ms', memory: '20.3 MB' };
  const officialQuotes = [JSON.stringify(fields, null, 2), '"status":"accepted","passedCases":65,"totalCases":65,"runtime":"0 ms","memory":"20.3 MB"'];
  for (const quote of officialQuotes) {
    const response = { ...answer(), evidence: [{ kind: 'official', runId: snapshot.official!.id, quote, caseIndex: null }] };
    const validated = validateResponse(JSON.stringify(response), snapshot);
    assert.deepEqual(validated.evidence, [{ kind: 'official', runId: snapshot.official!.id, quote: canonicalJson(fields) }]);
    assert.deepEqual(validateResponse(canonicalJson(validated), snapshot), validated);
  }
  const testQuote = JSON.stringify({ status: 'passed', expected: [0, 1], actual: [1, 0], index: 0 }, null, 2);
  const testResponse = { ...answer(), evidence: [{ kind: 'test', runId: snapshot.run!.id, quote: testQuote, caseIndex: 0 }] };
  assert.equal(validateResponse(JSON.stringify(testResponse), snapshot).evidence[0].quote, canonicalJson(snapshot.run!.caseResults[0]));
  const duplicate = { ...answer(), evidence: [{ kind: 'official', runId: snapshot.official!.id, quote: '"status":"UNVERIFIED-TEXT","status":"accepted"' }] };
  const normalized = validateResponse(JSON.stringify(duplicate), snapshot);
  assert.equal(normalized.evidence[0].quote, '{"status":"accepted"}'); assert.ok(!canonicalJson(normalized).includes('UNVERIFIED-TEXT'));
});

test('JSON evidence projections reject changed or unknown values, incomplete nested values and prose paraphrases', () => {
  const snapshot = acceptedSnapshot();
  for (const quote of ['{}', '"status":"wrong_answer"', '"passedCases":"65"', '"invented":65', '"status":"accepted","invented":65', '官方通过 65/65 个用例']) {
    expectReason({ ...answer(), evidence: [{ kind: 'official', runId: snapshot.official!.id, quote }] }, snapshot, 'quote');
  }
  for (const quote of ['"actual":[1]', '"actual":[0,1]', '"actual":{"0":1,"1":0}', '"expected":[0,1],"status":"wrong_answer"']) {
    expectReason({ ...answer(), evidence: [{ kind: 'test', runId: snapshot.run!.id, quote, caseIndex: 0 }] }, snapshot, 'quote');
  }
});

test('Bound evidence keeps exact source identity and accepts null caseIndex only for non-test references', () => {
  const snapshot = acceptedSnapshot();
  for (const source of ['official', 'run'] as const) {
    const reference = source === 'official' ? { kind: 'official', runId: snapshot.official!.id, quote: 'Accepted', caseIndex: null } : { kind: 'test', runId: snapshot.run!.id, quote: 'passed', caseIndex: 0 };
    const response = { ...answer(), evidence: [reference] };
    for (const mutation of ['codeHash', 'problemVersion', 'attemptId']) {
      const changed = structuredClone(snapshot); changed[source]![mutation as 'codeHash' | 'problemVersion' | 'attemptId'] = 'foreign-value';
      expectReason(response, changed, source === 'official' ? 'officialRun' : 'localRun');
    }
    expectReason({ ...response, evidence: [{ ...reference, runId: 'invented-id' }] }, snapshot, source === 'official' ? 'officialRun' : 'localRun');
  }
  expectReason({ ...answer(), evidence: [{ kind: 'official', runId: snapshot.official!.id, quote: 'Accepted', caseIndex: 0 }] }, snapshot, 'officialRun');
  expectReason({ ...answer(), evidence: [{ kind: 'test', runId: snapshot.run!.id, quote: 'passed', caseIndex: null }] }, snapshot, 'testCase');
  for (const kind of ['compiler', 'exception'] as const) {
    const diagnostic = acceptedSnapshot(); diagnostic.run!.status = kind === 'compiler' ? 'compile_error' : 'runtime_error';
    diagnostic.run!.diagnostics = [{ source: 'user', message: 'A supplied diagnostic.' }];
    const response = { ...answer(), evidence: [{ kind, runId: diagnostic.run!.id, quote: 'A supplied diagnostic.', caseIndex: null }] };
    assert.ok(!Object.hasOwn(validateResponse(JSON.stringify(response), diagnostic).evidence[0], 'caseIndex'));
    expectReason({ ...response, evidence: [{ ...response.evidence[0], caseIndex: 0 }] }, diagnostic, 'shape');
  }
});

test('Negated guarantees are allowed locally, while positive guarantees in another clause are still rejected', () => {
  const snapshot = acceptedSnapshot();
  for (const explanation of ['这次官方结果为 Accepted，但它不保证对所有输入都正确。', '通过用例并不能保证绝对正确。', '这不是完全正确的证明。', '无法保证一定通过。', '不能声称代码完全正确。', 'This is not guaranteed to pass.', 'This does not guarantee correctness.']) {
    assert.doesNotThrow(() => validateResponse(JSON.stringify({ ...answer(), explanation }), snapshot), explanation);
  }
  for (const explanation of ['不保证效率，但保证正确。', '不保证效率但保证正确。', '虽然无法保证速度，不过答案完全正确。', '它并非绝对正确；修改后保证通过。', 'This is not guaranteed efficient, but definitely correct.', '代码保证正确。']) {
    expectReason({ ...answer(), explanation }, snapshot, 'guarantee');
  }
});

test('Previously accepted exact evidence strings and response shapes retain their stored representation', () => {
  const snapshot = acceptedSnapshot();
  const response: AiResponse = { ...answer(), explanation: '官方已通过这份代码。', evidence: [{ kind: 'official', runId: snapshot.official!.id, quote: 'Accepted' }, { kind: 'test', runId: snapshot.run!.id, quote: canonicalJson(snapshot.run!.caseResults[0]), caseIndex: 0 }] };
  assert.equal(canonicalJson(validateResponse(canonicalJson(response), snapshot)), canonicalJson(response));
});
