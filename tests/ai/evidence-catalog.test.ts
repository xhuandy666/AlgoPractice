import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AiService, AiServiceError, buildRequestSnapshot, canonicalJson, sha256, validateResponse } from '../../src/ai/index.ts';
import { buildEvidenceCatalog, resolveEvidenceReference } from '../../src/ai/evidence-catalog.ts';
import type { AiEvidenceReference, AiEvent, AiRequestInput, AiRequestSnapshot, AiTrustedContext } from '../../src/shared/ai.ts';
import { answer, config, context, input, MemoryRepository, mockVault, sseCompletion } from './helpers.ts';

function canonicalReference(entry: AiEvidenceReference & { referenceId: string }): AiEvidenceReference {
  const { referenceId: _id, ...reference } = entry;
  return reference;
}
function officialContext(status: 'accepted' | 'wrong_answer' | 'compile_error' | 'runtime_error' = 'accepted'): AiTrustedContext {
  const source = context(); source.run = null;
  source.official = { id: 'official-catalog', attemptId: source.attemptId, problemVersion: source.problemVersion,
    codeHash: sha256(source.code), status, statusMessage: status === 'accepted' ? 'Accepted' : status,
    passedCases: status === 'accepted' ? 5 : 2, totalCases: 5, runtime: '1 ms', memory: '18 MB',
    compileError: 'Line 2: SyntaxError: expected colon', runtimeError: 'Line 6: IndexError: list index out of range',
    input: '[1,2,3]', actualOutput: '0', expectedOutput: '6' };
  source.officialSubmissionId = source.official.id;
  return source;
}
function officialRequest(source: AiTrustedContext): AiRequestInput {
  return { ...input(), kind: 'official-review', officialSubmissionId: source.official!.id };
}
function snapshot(source = context(), request = input()): AiRequestSnapshot {
  return buildRequestSnapshot(request, source, config());
}
function wireAnswer(request: AiRequestInput, source: AiTrustedContext, referenceId: string) {
  return { ...answer(request, { ...source, run: null }), evidence: [{ referenceId }] };
}
function serviceFixture(source: AiTrustedContext, fetchImpl: typeof fetch) {
  const repository = new MemoryRepository(), events: AiEvent[] = [];
  const options = { repository, vault: mockVault(), resolveContext: () => source, resolveProvider: config,
    fetchImpl, onEvent: (event: AiEvent) => { events.push(event); } };
  return { repository, events, options, service: new AiService(options) };
}

test('sent evidence catalog is frozen with the clipped trusted snapshot and contains no historical run', () => {
  const source = context(), current = snapshot(source);
  assert.ok(current.evidenceCatalog?.length);
  assert.deepEqual(current.evidenceCatalog, buildEvidenceCatalog(current));
  const payload = JSON.parse(current.messages[1].content);
  assert.deepEqual(payload.learningContext.evidenceCatalog, current.evidenceCatalog);
  source.run!.caseResults[0].expected = 999;
  assert.equal(current.run!.caseResults[0].expected, 6);
  assert.equal(current.evidenceCatalog![0].quote, canonicalJson(current.run!.caseResults[0]));

  const old = context(), oldRun = old.run!; old.code += '# edited current code'; old.run = null;
  old.previousRun = { code: context().code, run: oldRun };
  const historical = snapshot(old, { ...input(), runId: oldRun.id });
  assert.equal(historical.previousRun?.run.id, oldRun.id);
  assert.deepEqual(historical.evidenceCatalog, []);
});

test('compile and runtime catalogs expose only applicable user diagnostics and exception streams', () => {
  for (const status of ['compile_error', 'runtime_error', 'timeout', 'output_limit'] as const) {
    const source = context();
    source.run = { ...source.run!, status, trustworthyExpected: false, caseResults: [],
      diagnostics: [{ source: 'user', message: 'Supplied user diagnostic' }, { source: 'runner', message: 'PRIVATE WRAPPER DIAGNOSTIC' }],
      stdout: 'Supplied stdout', stderr: 'Supplied stderr' };
    const current = snapshot(source), catalog = current.evidenceCatalog!;
    const expectedKind = status === 'compile_error' ? 'compiler' : 'exception';
    assert.ok(catalog.every(entry => entry.kind === expectedKind));
    assert.ok(catalog.some(entry => entry.quote === 'Supplied user diagnostic'));
    assert.ok(!canonicalJson(catalog).includes('PRIVATE WRAPPER DIAGNOSTIC'));
    assert.equal(catalog.some(entry => entry.quote === 'Supplied stdout'), status !== 'compile_error');
    assert.equal(catalog.some(entry => entry.quote === 'Supplied stderr'), status !== 'compile_error');
    for (const entry of catalog) assert.deepEqual(resolveEvidenceReference(entry.referenceId, current), canonicalReference(entry));
  }
});

test('catalog uses actual test indexes and excludes missing, untrusted and clipped test values', () => {
  const source = context();
  source.run!.caseResults = [
    { index: 11, status: 'wrong_answer', expected: 6, actual: 0 },
    { index: 4, status: 'passed', expected: 0, actual: 0 },
    { index: 15, status: 'completed', actual: 0 },
    { index: 16, status: 'passed', actual: 0 },
    { index: 17, status: 'wrong_answer', expected: 'x'.repeat(1000), actual: 0 },
    { index: 18, status: 'wrong_answer', expected: 6, actual: 'y'.repeat(1000) },
    { index: 19, status: 'runtime_error', expected: 6, actual: 0 },
    { index: 20, status: 'passed', expected: 0, actual: 0 },
    { index: 21, status: 'passed', expected: 0, actual: 0 },
  ];
  const current = snapshot(source);
  assert.deepEqual(current.evidenceCatalog!.map(entry => entry.caseIndex), [11, 4, 20]);
  assert.ok(current.clippedFields.includes('run.cases.4.expected'));
  assert.ok(current.clippedFields.includes('run.cases.5.actual'));
  assert.ok(current.clippedFields.includes('run.caseResults'));
  assert.ok(!canonicalJson(current.evidenceCatalog).includes('[结果过长，已省略]'));
  for (const entry of current.evidenceCatalog!) {
    assert.equal(entry.quote, canonicalJson(current.run!.caseResults.find(result => result.index === entry.caseIndex)));
  }
  const untrusted = snapshot({ ...source, run: { ...source.run!, trustworthyExpected: false } });
  assert.deepEqual(untrusted.evidenceCatalog, []);
});

test('official catalogs bind normalized verdict metadata and supplied diagnostic and case text without a local case index', () => {
  for (const status of ['accepted', 'wrong_answer', 'compile_error', 'runtime_error'] as const) {
    const source = officialContext(status), current = snapshot(source, officialRequest(source)), catalog = current.evidenceCatalog!;
    assert.equal(catalog.length, 6);
    assert.ok(catalog.every(entry => entry.kind === 'official' && entry.runId === source.official!.id && !Object.hasOwn(entry, 'caseIndex')));
    assert.ok(catalog.some(entry => JSON.parse(entry.quote.startsWith('{') ? entry.quote : '{}').status === status));
    for (const field of ['compileError', 'runtimeError', 'input', 'actualOutput', 'expectedOutput'] as const) {
      assert.ok(catalog.some(entry => entry.quote === source.official![field]));
    }
    for (const entry of catalog) assert.deepEqual(resolveEvidenceReference(entry.referenceId, current), canonicalReference(entry));
  }
});

test('reference IDs cannot replay across code, attempt, problem, answer format or test configuration identities', () => {
  const source = { ...context(), answerFormat: 'function' as const, specVersion: 'function-v1', testConfigDigest: 'a'.repeat(64) };
  source.run = { ...source.run!, answerFormat: source.answerFormat, specVersion: source.specVersion, testConfigDigest: source.testConfigDigest };
  const current = snapshot(source), entry = current.evidenceCatalog![0];
  const mutations: Array<(value: AiRequestSnapshot) => void> = [
    value => { value.attemptId = 'foreign-attempt'; },
    value => { value.codeHash = sha256('different code'); },
    value => { value.problemVersion = 'different-version'; },
    value => { value.answerFormat = 'acm'; value.run!.answerFormat = 'acm'; },
    value => { value.specVersion = 'function-v2'; value.run!.specVersion = 'function-v2'; },
    value => { value.testConfigDigest = 'b'.repeat(64); value.run!.testConfigDigest = 'b'.repeat(64); },
    value => { value.run!.id = 'other-local-run'; },
    value => { value.run!.caseResults[0].expected = 999; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(current); mutate(changed);
    assert.equal(resolveEvidenceReference(entry.referenceId, changed), null);
  }
  const official = officialContext(), submitted = snapshot(official, officialRequest(official)), officialId = submitted.evidenceCatalog![0].referenceId;
  submitted.official!.id = 'other-official-submission';
  assert.equal(resolveEvidenceReference(officialId, submitted), null);
});

test('unmatched current metadata and ACM official results never enter the catalog', () => {
  const source = { ...context(), answerFormat: 'function' as const, specVersion: 'function-v1', testConfigDigest: 'a'.repeat(64) };
  source.run = { ...source.run!, answerFormat: source.answerFormat, specVersion: source.specVersion, testConfigDigest: source.testConfigDigest };
  const current = snapshot(source);
  for (const field of ['answerFormat', 'specVersion', 'testConfigDigest'] as const) {
    const changed = structuredClone(current);
    if (field === 'answerFormat') changed.run!.answerFormat = 'acm';
    if (field === 'specVersion') changed.run!.specVersion = 'different';
    if (field === 'testConfigDigest') changed.run!.testConfigDigest = 'b'.repeat(64);
    assert.deepEqual(buildEvidenceCatalog(changed), []);
  }
  const official = snapshot(officialContext()); official.answerFormat = 'acm';
  assert.deepEqual(buildEvidenceCatalog(official), []);
});

test('forged frozen catalog entries and added IDs are independently checked against source evidence', () => {
  const current = snapshot(), id = current.evidenceCatalog![0].referenceId;
  for (const mutate of [
    (entry: NonNullable<AiRequestSnapshot['evidenceCatalog']>[number]) => { entry.quote = 'PRIVATE FORGED QUOTE'; },
    (entry: NonNullable<AiRequestSnapshot['evidenceCatalog']>[number]) => { entry.runId = 'foreign-run'; },
    (entry: NonNullable<AiRequestSnapshot['evidenceCatalog']>[number]) => { entry.kind = 'official'; },
    (entry: NonNullable<AiRequestSnapshot['evidenceCatalog']>[number]) => { entry.caseIndex = 99; },
  ]) {
    const changed = structuredClone(current); mutate(changed.evidenceCatalog![0]);
    const payload = JSON.parse(changed.messages[1].content); payload.learningContext.evidenceCatalog = changed.evidenceCatalog;
    changed.messages[1].content = canonicalJson(payload);
    assert.equal(resolveEvidenceReference(id, changed), null);
  }
  const changed = structuredClone(current);
  changed.evidenceCatalog!.push({ referenceId: 'ev-forged', runId: current.run!.id, kind: 'test', quote: 'invented', caseIndex: 0 });
  assert.equal(resolveEvidenceReference('ev-forged', changed), null);
  assert.equal(resolveEvidenceReference(id, { ...current, evidenceCatalog: undefined }), null);
  assert.equal(resolveEvidenceReference('ev-unknown', current), null);
});

test('catalog IDs are deterministic, duplicates collapse, and entry and UTF-8 budgets bound duplicated evidence', () => {
  const current = snapshot(), reordered = structuredClone(current);
  reordered.run!.caseResults[0] = { expected: 6, actual: 0, status: 'wrong_answer', index: 0 };
  assert.deepEqual(buildEvidenceCatalog(reordered), buildEvidenceCatalog(current));

  const many = structuredClone(current);
  many.run = { ...many.run!, status: 'compile_error', trustworthyExpected: false, caseResults: [],
    diagnostics: Array.from({ length: 50 }, (_, index) => ({ source: 'user', message: `Diagnostic ${index}: ${'x'.repeat(80)}` })) };
  const entries = buildEvidenceCatalog(many);
  assert.equal(entries.length, 20);
  assert.deepEqual(entries, buildEvidenceCatalog(many));
  assert.ok(Buffer.byteLength(canonicalJson(entries)) <= 16 * 1024);
  many.run.diagnostics = Array.from({ length: 30 }, () => ({ source: 'user', message: 'One repeated diagnostic' }));
  assert.equal(buildEvidenceCatalog(many).length, 1);
  many.run.diagnostics = Array.from({ length: 10 }, (_, index) => ({ source: 'user', message: `${index}:${'界'.repeat(1990)}` }));
  const multibyte = buildEvidenceCatalog(many);
  assert.ok(multibyte.length > 0 && multibyte.length < many.run.diagnostics.length);
  assert.ok(Buffer.byteLength(canonicalJson(multibyte)) <= 16 * 1024);
});

test('new wire references normalize into the existing canonical evidence protocol and reject mixed metadata', () => {
  const source = context(), request = { ...input(), kind: 'diagnosis' as const }, current = snapshot(source, request), entry = current.evidenceCatalog![0];
  const wire = wireAnswer(request, source, entry.referenceId);
  assert.deepEqual(validateResponse(JSON.stringify(wire), current).evidence, [canonicalReference(entry)]);
  for (const evidence of [
    [{ referenceId: 'ev-unknown' }], [{ referenceId: entry.referenceId, runId: 'invented-run' }],
    [{ referenceId: entry.referenceId, quote: 'invented quote' }], [{ referenceId: entry.referenceId, kind: 'official', caseIndex: 0 }],
  ]) assert.throws(() => validateResponse(JSON.stringify({ ...wire, evidence }), current), AiServiceError);
});

test('local compiler, exception, test and official feedback complete once, persist canonical citations and survive service restart', async () => {
  const compile = context(); compile.run = { ...compile.run!, status: 'compile_error', trustworthyExpected: false,
    diagnostics: [{ source: 'user', message: 'SyntaxError: expected colon' }], caseResults: [] };
  const cases = [
    { source: compile, request: { ...input(), kind: 'diagnosis' as const }, kind: 'compiler' },
    { source: context(), request: { ...input(), kind: 'diagnosis' as const }, kind: 'test' },
    ...(['runtime_error', 'timeout', 'output_limit'] as const).map(status => {
      const source = context(); source.run = { ...source.run!, status, trustworthyExpected: false, caseResults: [],
        diagnostics: [{ source: 'user', message: `Supplied ${status} diagnostic` }], stdout: '', stderr: '' };
      return { source, request: { ...input(), kind: 'diagnosis' as const }, kind: 'exception' };
    }),
    ...(['accepted', 'wrong_answer', 'compile_error', 'runtime_error'] as const).map(status => {
      const source = officialContext(status); return { source, request: officialRequest(source), kind: 'official' };
    }),
  ];
  for (const { source, request, kind } of cases) {
    let calls = 0; let sentEntry: (AiEvidenceReference & { referenceId: string }) | undefined;
    const fixture = serviceFixture(source, async (_url, init) => {
      calls++; const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      sentEntry = payload.learningContext.evidenceCatalog.find((entry: AiEvidenceReference) => entry.kind === kind);
      assert.ok(sentEntry);
      return sseCompletion(JSON.stringify(wireAnswer(request, source, sentEntry.referenceId)));
    });
    const result = await fixture.service.request(request);
    assert.equal(result.status, 'completed', canonicalJson(result.error)); assert.equal(calls, 1);
    assert.deepEqual(result.response!.evidence, [canonicalReference(sentEntry!)]);
    assert.deepEqual(fixture.repository.getAIRequest(result.id)!.response!.evidence, result.response!.evidence);
    assert.ok(!fixture.events.some(event => event.phase === 'repairing'));
    assert.ok(!Object.hasOwn(result.response!.evidence[0], 'referenceId'));
    assert.deepEqual(await new AiService(fixture.options).request(request), result);
    assert.equal(calls, 1);
  }
});

test('unknown references get only one fixed repair, with no rejected model text in the next prompt or persisted state', async () => {
  const source = context(), request = { ...input(), kind: 'diagnosis' as const }, marker = 'PRIVATE-REJECTED-CATALOG-ANSWER';
  let calls = 0;
  const fixture = serviceFixture(source, async (_url, init) => {
    calls++; const messages = JSON.parse(String(init?.body)).messages;
    assert.ok(!canonicalJson(messages).includes(marker));
    if (calls === 2) {
      const [original, repairText] = messages[1].content.split('\n\n');
      const repair = JSON.parse(repairText), catalog = JSON.parse(original).learningContext.evidenceCatalog;
      assert.deepEqual(Object.keys(repair).sort(), ['allowedEvidence', 'evidenceItemFormat', 'reason', 'repairHint', 'task']);
      assert.deepEqual(repair.allowedEvidence, catalog.map((entry: AiEvidenceReference & { referenceId: string }) => ({ referenceId: entry.referenceId, kind: entry.kind })));
      assert.deepEqual(Object.keys(repair.evidenceItemFormat), ['referenceId']);
      assert.equal(repair.reason, 'POLICY_VIOLATION'); assert.match(repair.repairHint, /referenceId|catalog/);
    }
    return sseCompletion(JSON.stringify({ ...wireAnswer(request, source, 'ev-private-invented-reference'), title: marker }));
  });
  const result = await fixture.service.request(request);
  assert.equal(result.status, 'failed'); assert.equal(result.error?.validationReason, 'evidenceReference');
  assert.equal(result.response, null); assert.equal(calls, 2); assert.equal(result.usage?.calls, 2);
  assert.equal(fixture.events.filter(event => event.phase === 'repairing').length, 1);
  assert.ok(!canonicalJson([result, fixture.events, [...fixture.repository.records.values()]]).includes(marker));
  assert.ok(!canonicalJson(result.error).includes('repairHint'));
  assert.deepEqual(await new AiService(fixture.options).request(request), result); assert.equal(calls, 2);
});

test('a fixed reference repair can recover using the original sent catalog without accepting invented metadata', async () => {
  const source = context(), request = { ...input(), kind: 'diagnosis' as const }; let calls = 0;
  const fixture = serviceFixture(source, async (_url, init) => {
    calls++; const messages = JSON.parse(String(init?.body)).messages;
    const payload = JSON.parse(messages[1].content.split('\n\n')[0]);
    const referenceId = calls === 1 ? 'ev-unknown' : payload.learningContext.evidenceCatalog[0].referenceId;
    return sseCompletion(JSON.stringify(wireAnswer(request, source, referenceId)));
  });
  const result = await fixture.service.request(request);
  assert.equal(result.status, 'completed', canonicalJson(result.error)); assert.equal(calls, 2);
  assert.deepEqual(result.response!.evidence, [canonicalReference(result.snapshot.evidenceCatalog![0])]);
});

test('catalog answers retain network classification and reject key echoes without a format repair', async () => {
  for (const failure of ['network', 'key'] as const) {
    const source = context(), request = { ...input(), kind: 'diagnosis' as const }; let calls = 0;
    const fixture = serviceFixture(source, async (_url, init) => {
      calls++;
      if (failure === 'network') throw new Error('PRIVATE PROVIDER FAILURE');
      const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return sseCompletion(JSON.stringify({ ...wireAnswer(request, source, payload.learningContext.evidenceCatalog[0].referenceId),
        explanation: 'synthetic-unit-key-12345' }));
    });
    const result = await fixture.service.request(request);
    assert.equal(result.status, 'failed'); assert.equal(result.error?.code, failure === 'network' ? 'NETWORK' : 'POLICY_VIOLATION');
    assert.equal(result.response, null); assert.equal(calls, 1); assert.ok(!fixture.events.some(event => event.phase === 'repairing'));
    assert.ok(!canonicalJson([result, fixture.events]).includes('PRIVATE PROVIDER FAILURE'));
    assert.ok(!canonicalJson([result, fixture.events]).includes('synthetic-unit-key-12345'));
  }
});

test('strict mode and cancellation suppress catalog-based late answers and do not overwrite terminal state', async () => {
  const initiallyStrict = { ...context(), mode: 'strict' as const }; let strictCalls = 0;
  const initialFixture = serviceFixture(initiallyStrict, async () => { strictCalls++; return sseCompletion('{}'); });
  await assert.rejects(initialFixture.service.request(input()), error => error instanceof AiServiceError && error.detail.code === 'STRICT_MODE');
  assert.equal(strictCalls, 0); assert.equal(initialFixture.repository.records.size, 0);

  for (const action of ['strict', 'cancel'] as const) {
    const source = context(), request = { ...input(), kind: 'diagnosis' as const };
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    const fixture = serviceFixture(source, async (_url, init) => {
      const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      const raw = JSON.stringify(wireAnswer(request, source, payload.learningContext.evidenceCatalog[0].referenceId));
      ready(); await gate; return sseCompletion(raw);
    });
    const pending = fixture.service.request(request); await started;
    if (action === 'strict') { source.mode = 'strict'; release(); } else fixture.service.cancel(request.requestId);
    const result = await pending;
    assert.equal(result.status, action === 'strict' ? 'failed' : 'cancelled');
    assert.equal(result.error?.code, action === 'strict' ? 'STRICT_MODE' : 'CANCELLED'); assert.equal(result.response, null);
    release(); await delay(5);
    assert.equal(fixture.repository.getAIRequest(result.id)!.status, result.status);
    assert.ok(!fixture.events.some(event => event.phase === 'completed'));
  }
});
