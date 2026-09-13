import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestSnapshot, validateResponse } from '../../src/ai/index.ts';
import { config } from './helpers.ts';
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
  assert.deepEqual(Object.keys(exposed).sort(), ['code', 'message', 'retryable']); assert.equal(exposed.code, 'POLICY_VIOLATION'); assert.ok(!JSON.stringify(exposed).includes('PRIVATE')); assert.ok(!JSON.stringify(exposed).includes('repairHint'));
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
    { mutate: response => { response.explanation = '代码已获得官方 AC。'; }, expected: /No matching accepted official result/ },
    { mutate: response => { response.explanation = '所有测试都已通过。'; }, expected: /No matching trustworthy passed local run/ },
    { mutate: response => { response.explanation = '答案一定正确。'; }, expected: /Remove absolute guarantees/ },
  ];
  for (const row of cases) {
    const snapshot = structuredClone(baseline), response = answer(); row.mutate(response, snapshot);
    assert.throws(() => validateResponse(JSON.stringify(response), snapshot), error => { assert.ok(error instanceof AiValidationError); assert.match(error.repairHint, row.expected); return true; });
  }
});
