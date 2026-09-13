import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AiService, AiServiceError, buildRequestSnapshot, canonicalJson, requestHash, sha256 } from '../../src/ai/index.ts';
import type { AiServiceOptions } from '../../src/ai/service.ts';
import type { AiEvent, AiProviderConfig, AiRequestInput } from '../../src/shared/ai.ts';
import { answer, config, context, input, jsonCompletion, MemoryRepository, mockVault, sseCompletion } from './helpers.ts';

function setup(fetcher?: typeof fetch) { const repository = new MemoryRepository(), source = context(), events: AiEvent[] = []; let calls = 0; const options: AiServiceOptions = { repository, vault: mockVault(), resolveContext: (_input: AiRequestInput) => source, resolveProvider: () => config() as AiProviderConfig | null, onEvent: (event: AiEvent) => { events.push(event); }, fetchImpl: fetcher ?? (async (_url, init) => { calls++; const messages = JSON.parse(String(init?.body)).messages; const sent = JSON.parse(messages[1].content); return sseCompletion(JSON.stringify(answer({ ...input(), kind: sent.kind }, source))); }) as typeof fetch }; const service = new AiService(options); return { service, repository, source, events, options, get calls() { return calls; } }; }

test('A validated streaming response is persisted with original hashes and provider usage; events contain no raw content', async () => { const fixture = setup(); const request = input(); const result = await fixture.service.request(request); assert.equal(result.status, 'completed'); assert.equal(result.snapshot.codeHash, sha256(fixture.source.code)); assert.equal(result.snapshot.runId, 'run-a'); assert.deepEqual(result.usage, { source: 'provider', inputTokens: 10, outputTokens: 20, totalTokens: 30, calls: 1 }); assert.ok(fixture.events.some(event => event.phase === 'receiving')); assert.ok(fixture.events.every(event => event.requestId === request.requestId && !Object.hasOwn(event, 'content') && !Object.hasOwn(event, 'response'))); assert.ok(!canonicalJson(fixture.repository.listAIRequests('attempt-a')).includes('synthetic-unit-key')); });
test('Same complete canonical request can reuse a completed answer, but new question or context cannot', async () => { const fixture = setup(), request = input(); const first = await fixture.service.request(request); const cached = await fixture.service.request({ ...request, requestId: 'request-cache' }); assert.equal(fixture.calls, 1); assert.equal(cached.cachedFromRequestId, first.id); assert.equal(cached.usage, null); await fixture.service.request({ ...request, requestId: 'request-new-question', question: '另一个问题' }); assert.equal(fixture.calls, 2); fixture.source.code += '# change'; fixture.source.run = null; await fixture.service.request({ ...request, requestId: 'request-new-code' }); assert.equal(fixture.calls, 3); });
test('A reused request ID is idempotent and cannot bind a different question', async () => { const fixture = setup(), request = input(); const first = await fixture.service.request(request); fixture.source.code += '# edited after request'; fixture.source.run = null; assert.deepEqual(await fixture.service.request(request), first); assert.equal(fixture.calls, 1); await assert.rejects(fixture.service.request({ ...request, question: 'different' }), error => error instanceof AiServiceError && error.detail.code === 'REQUEST_CONFLICT'); });
test('Concurrent identical IDs create only one provider call', async () => { let calls = 0; const request = input(); const fixture = setup(async () => { calls++; await delay(5); return sseCompletion(JSON.stringify(answer(request))); }); const [first, second] = await Promise.all([fixture.service.request(request), fixture.service.request(request)]); assert.equal(calls, 1); assert.deepEqual(first, second); });
test('One malformed answer is repaired once; raw answer is never stored or emitted', async () => { let calls = 0; const request = input(); const fixture = setup(async (_url, init) => { calls++; const body = JSON.parse(String(init?.body)); if (calls === 2) assert.match(body.messages.at(-1).content, /One format repair only/); return sseCompletion(calls === 1 ? 'UNVALIDATED-MODEL-DATA' : JSON.stringify(answer(request))); }); const result = await fixture.service.request(request); assert.equal(result.status, 'completed'); assert.equal(calls, 2); assert.equal(result.usage?.calls, 2); assert.equal(result.usage?.totalTokens, 60); assert.ok(fixture.events.some(event => event.phase === 'repairing')); assert.ok(!canonicalJson(result).includes('UNVALIDATED-MODEL-DATA')); assert.ok(!canonicalJson(fixture.events).includes('UNVALIDATED-MODEL-DATA')); });
test('Two invalid answers stop without a raw fallback or a third call', async () => { let calls = 0; const fixture = setup(async () => { calls++; return sseCompletion('INVALID-RAW-ANSWER'); }); const result = await fixture.service.request(input()); assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'FORMAT_INVALID'); assert.equal(calls, 2); assert.equal(result.response, null); assert.ok(!canonicalJson(result).includes('INVALID-RAW-ANSWER')); });
test('Active strict mode is checked before any model call, including a cached request ID', async () => { const fixture = setup(), request = input(); await fixture.service.request(request); fixture.source.mode = 'strict'; await assert.rejects(fixture.service.request(request), error => error instanceof AiServiceError && error.detail.code === 'STRICT_MODE'); assert.equal(fixture.calls, 1); });
test('A strict-mode change during a call suppresses its late answer', async () => { const request = input(); let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); const fixture = setup(async () => { await ready; return sseCompletion(JSON.stringify(answer(request))); }); const pending = fixture.service.request(request); await delay(5); fixture.source.mode = 'strict'; release(); const result = await pending; assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'STRICT_MODE'); assert.equal(result.response, null); });
test('Late provider completion after cancel cannot overwrite cancelled state', async () => { const request = input(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const fixture = setup(async () => { await gate; return sseCompletion(JSON.stringify(answer(request))); }); const pending = fixture.service.request(request); await delay(5); fixture.service.cancel(request.requestId); const cancelled = await pending; assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.response, null); release(); await delay(5); assert.equal(fixture.repository.getAIRequest(request.requestId)!.status, 'cancelled'); assert.ok(!fixture.events.some(event => event.phase === 'completed')); });
test('A response stays with its original request and code if the user edits during generation', async () => { const request = input(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const fixture = setup(async () => { await gate; return sseCompletion(JSON.stringify(answer(request))); }); const originalHash = sha256(fixture.source.code); const pending = fixture.service.request(request); await delay(5); fixture.source.code += '# later edit'; fixture.source.run = null; release(); const result = await pending; assert.equal(result.status, 'completed'); assert.equal(result.snapshot.codeHash, originalHash); assert.ok(fixture.events.every(event => event.codeHash === originalHash)); });
test('Stopped context preparation cannot create an AI record or later call the provider', async () => { const fixture = setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); fixture.options.resolveContext = async () => { await gate; return fixture.source; }; const service = new AiService(fixture.options); const request = input(); const pending = service.request(request); service.cancel(request.requestId); await assert.rejects(pending, error => error instanceof AiServiceError && error.detail.code === 'CANCELLED'); release(); await delay(1); assert.equal(fixture.repository.records.size, 0); assert.equal(fixture.calls, 0); });
test('Connection capability checks are cancellable through stopAll and late probes cannot pass', async () => { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const fixture = setup(async () => { await gate; return jsonCompletion('{"ok":true}'); }); const pending = fixture.service.testConnection(); await delay(5); await fixture.service.stopAll(); const result = await pending; assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'CANCELLED'); release(); await delay(1); assert.equal(result.status, 'failed'); assert.equal(fixture.repository.records.size, 0); });
test('Connection capability check reports actual fallback transport and missing usage honestly', async () => { const fixture = setup(async () => jsonCompletion('{"ok":true}', false)); const result = await fixture.service.testConnection(); assert.equal(result.status, 'passed'); assert.equal(result.streaming, false); assert.equal(result.structuredOutput, true); assert.equal(result.usageAvailable, false); assert.equal(result.usage, null); });
test('Unconfigured model and credentials never cause a provider call', async () => { const fixture = setup(); fixture.options.resolveProvider = () => null; const service = new AiService(fixture.options); assert.equal((await service.testConnection()).status, 'not-configured'); await assert.rejects(service.request(input()), error => error instanceof AiServiceError && error.detail.code === 'NOT_CONFIGURED'); assert.equal(fixture.calls, 0); const second = setup(); second.options.vault.withKey = async () => { throw new AiServiceError('NOT_CONFIGURED'); }; const result = await new AiService(second.options).request(input()); assert.equal(result.error?.code, 'NOT_CONFIGURED'); assert.equal(second.calls, 0); });
test('Patch is only prepared; stale code or inactive Attempt blocks applying it', async () => { const request = { ...input(), kind: 'diagnosis' as const }; const source = context(); const response = answer(request, source); response.patch = { baseCodeHash: sha256(source.code), edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] }; const fixture = setup(async () => sseCompletion(JSON.stringify(response))); const record = await fixture.service.request(request); assert.equal(record.status, 'completed'); const proposed = await fixture.service.preparePatch(record.id); assert.match(proposed.code, /return total/); assert.equal(proposed.expectedDraftRevision, 1); assert.equal(fixture.source.code, source.code); fixture.source.code += '# user edited'; fixture.source.run = null; await assert.rejects(fixture.service.preparePatch(record.id), error => error instanceof AiServiceError && error.detail.code === 'STALE_PATCH'); fixture.source.code = source.code; fixture.source.isActive = false; await assert.rejects(fixture.service.preparePatch(record.id), error => error instanceof AiServiceError && error.detail.code === 'STALE_PATCH'); });
test('Credential echoes are rejected without putting the Key into a repair prompt or persistent state', async () => { let calls = 0; const request = input(); const response = answer(request); response.explanation = 'synthetic-unit-key-12345'; const fixture = setup(async () => { calls++; return sseCompletion(JSON.stringify(response)); }); const result = await fixture.service.request(request); assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'POLICY_VIOLATION'); assert.equal(calls, 1); assert.ok(!canonicalJson(result).includes('synthetic-unit-key-12345')); });
test('Recovered pending requests become interrupted and are never reused as completed cache', async () => { const fixture = setup(), request = input(); const snapshot = buildRequestSnapshot(request, fixture.source, config()); fixture.repository.beginAIRequest({ id: request.requestId, attemptId: request.attemptId, requestHash: requestHash(snapshot), snapshot }); assert.equal(fixture.service.recoverInterrupted(), 1); const recovered = await fixture.service.request(request); assert.equal(recovered.status, 'interrupted'); assert.equal(fixture.calls, 0); await fixture.service.request({ ...request, requestId: 'retry-new-request' }); assert.equal(fixture.calls, 1); });
test('Corrupted completed snapshots and answers are not published as cached or idempotent responses', async () => { const fixture = setup(), request = input(); const first = await fixture.service.request(request); const saved = fixture.repository.records.get(first.id)!; saved.snapshot.messages[1].content += 'corruption'; await assert.rejects(fixture.service.request(request), error => error instanceof AiServiceError && error.detail.code === 'STORAGE'); const replacement = await fixture.service.request({ ...request, requestId: 'after-corrupt-cache' }); assert.equal(replacement.status, 'completed'); assert.equal(replacement.cachedFromRequestId, null); assert.equal(fixture.calls, 2); const latest = fixture.repository.records.get(replacement.id)!; latest.response!.explanation = '保证正确。'; await assert.rejects(fixture.service.request({ ...request, requestId: latest.id }), error => error instanceof AiServiceError && error.detail.code === 'STORAGE'); });
test('Resolver exception details cannot escape through request or provider configuration APIs', async () => { const fixture = setup(); fixture.options.resolveContext = () => { throw new Error('synthetic-sensitive-context-error'); }; const service = new AiService(fixture.options); await assert.rejects(service.request(input()), error => error instanceof AiServiceError && error.detail.code === 'INVALID_REQUEST' && !error.message.includes('synthetic-sensitive')); fixture.options.resolveProvider = () => { throw new Error('synthetic-sensitive-provider-error'); }; await assert.rejects(service.providerState(), error => error instanceof AiServiceError && error.detail.code === 'INVALID_CONFIG' && !error.message.includes('synthetic-sensitive')); });


test('Provider settings load without probing a locked OS keychain, with or without a saved Key', { timeout: 1000 }, async () => {
  for (const hasKey of [false, true]) {
    const fixture = setup(); let probes = 0;
    fixture.options.vault.secureStorageAvailable = () => { probes++; return new Promise<boolean>(() => {}); };
    fixture.options.vault.hasKey = async () => hasKey;
    const service = new AiService(fixture.options);
    assert.deepEqual(await service.providerState(), { config: config(), hasKey, secureStorageAvailable: null });
    fixture.options.resolveProvider = () => null;
    assert.deepEqual(await service.providerState(), { config: null, hasKey: false, secureStorageAvailable: null });
    assert.equal(probes, 0);
  }
});

test('An empty request invokes the coach; a direct full-solution request works without unlock and remains a preview', async () => {
  const empty = setup(); const emptyResult = await empty.service.request(input()); assert.equal(emptyResult.status, 'completed'); assert.equal(emptyResult.snapshot.question, ''); assert.equal(empty.calls, 1);
  const request = { ...input(), question: '请给我完整代码并解释' }, response = answer(request); response.completeSolution = { explanation: '累加后返回结果。', code: 'class Solution:\n    def solve(self, nums):\n        return sum(nums)\n' };
  const fixture = setup(async () => sseCompletion(JSON.stringify(response))), before = fixture.source.code;
  const result = await fixture.service.request(request); assert.equal(result.status, 'completed'); assert.equal(result.response?.completeSolution?.code, response.completeSolution.code);
  assert.equal(result.snapshot.level, undefined); assert.equal(result.snapshot.unlockCompleteSolution, undefined);
  assert.equal((await fixture.service.preparePatch(result.id)).code, response.completeSolution.code); assert.equal(fixture.source.code, before);
});
test('Official results changing the context invalidate completed response cache', async () => {
  const fixture = setup(); fixture.source.official = { id: 'official-one', attemptId: fixture.source.attemptId, problemVersion: fixture.source.problemVersion, codeHash: sha256(fixture.source.code), status: 'wrong_answer', statusMessage: 'Wrong Answer', passedCases: 2, totalCases: 10 };
  const first = await fixture.service.request(input()); fixture.source.official = { ...fixture.source.official, id: 'official-two', status: 'accepted', statusMessage: 'Accepted', passedCases: 10 };
  const second = await fixture.service.request(input()); assert.equal(first.status, 'completed'); assert.equal(second.status, 'completed'); assert.equal(second.cachedFromRequestId, null); assert.equal(fixture.calls, 2);
});

test('Empty-code invented Run evidence gets a fixed evidence-empty repair hint and a valid second answer', async () => {
  const source = context(); source.code = ''; source.run = null;
  const request = input(), unsupported = answer(request, source);
  unsupported.evidence = [{ runId: 'NONEXISTENT-PRIVATE-PROVIDER-RUN', kind: 'test', quote: 'PRIVATE-PROVIDER-QUOTE', caseIndex: 0 }];
  let calls = 0;
  const fixture = setup(async (_url, init) => {
    calls++; const messages = JSON.parse(String(init?.body)).messages;
    if (calls === 1) return sseCompletion(JSON.stringify(unsupported));
    const parts = messages[1].content.split('\n\n'); assert.equal(parts.length, 2);
    const repair = JSON.parse(parts[1]);
    assert.deepEqual(Object.keys(repair).sort(), ['reason', 'repairHint', 'task']); assert.equal(repair.reason, 'POLICY_VIOLATION');
    assert.match(repair.repairHint, /no matching run.*evidence:\[\]/);
    assert.ok(!JSON.stringify(messages).includes('PRIVATE-PROVIDER')); assert.ok(!JSON.stringify(messages).includes('NONEXISTENT'));
    const valid = answer(request, source); valid.explanation = '先确认要返回的是两个不同下标，试着用一个短数组描述它们需要满足的关系。';
    return sseCompletion(JSON.stringify(valid));
  });
  fixture.source.code = source.code; fixture.source.run = null;
  const result = await fixture.service.request(request); assert.equal(result.status, 'completed'); assert.equal(result.usage?.calls, 2); assert.equal(calls, 2); assert.deepEqual(result.response?.evidence, []);
  assert.ok(!canonicalJson([result, fixture.events]).includes('PRIVATE-PROVIDER')); assert.ok(!canonicalJson([result, fixture.events]).includes('repairHint'));
});

function officialContext() {
  const source = context(); source.run = null;
  source.official = { id: 'official-synthetic', attemptId: source.attemptId, problemVersion: source.problemVersion, codeHash: sha256(source.code),
    status: 'accepted', statusMessage: 'Accepted', passedCases: 5, totalCases: 5, runtime: '1 ms', memory: '18 MB' };
  return source;
}

test('Official JSON projections can reorder fields, normalize nullable caseIndex, and survive persisted cache reads', async () => {
  const projections = [
    '{ "totalCases": 5, "status": "accepted", "passedCases": 5 }',
    '"status": "accepted", "totalCases": 5, "passedCases": 5',
  ];
  for (const quote of projections) {
    const source = officialContext(), request = input(); let calls = 0;
    const wireAnswer = { ...answer(request, source), explanation: '官方已通过全部用例。当前没有本地运行记录。',
      evidence: [{ runId: source.official!.id, kind: 'official', quote, caseIndex: null }] };
    const fixture = setup(async () => { calls++; return sseCompletion(JSON.stringify(wireAnswer)); });
    Object.assign(fixture.source, source);
    const first = await fixture.service.request(request);
    assert.equal(first.status, 'completed', JSON.stringify(first.error)); assert.equal(calls, 1);
    const expectedEvidence = [{ runId: source.official!.id, kind: 'official', quote: canonicalJson({ passedCases: 5, status: 'accepted', totalCases: 5 }) }];
    assert.deepEqual(first.response?.evidence, expectedEvidence);
    assert.deepEqual(fixture.repository.getAIRequest(first.id)?.response?.evidence, expectedEvidence);
    assert.ok(!fixture.events.some(event => event.phase === 'repairing'));

    // A new service has no in-memory request state: both idempotent reads and
    // a new request must validate the persisted normalized answer again.
    const restarted = new AiService(fixture.options);
    assert.deepEqual(await restarted.request(request), first);
    const cached = await restarted.request({ ...request, requestId: `${request.requestId}-cached` });
    assert.equal(cached.status, 'completed'); assert.equal(cached.cachedFromRequestId, first.id);
    assert.equal(cached.usage, null); assert.deepEqual(cached.response, first.response); assert.equal(calls, 1);
    assert.deepEqual(fixture.repository.getAIRequest(cached.id)?.response?.evidence, expectedEvidence);
  }
});

test('Compiler and exception evidence with caseIndex null completes and persists without a case index', async () => {
  for (const [kind, status, quote] of [
    ['compiler', 'compile_error', 'SyntaxError: expected colon'],
    ['exception', 'runtime_error', 'IndexError: list index out of range'],
  ] as const) {
    const source = context(), request = { ...input(), kind: 'diagnosis' as const }; let calls = 0;
    source.run = { ...source.run!, status, diagnostics: [{ source: 'user', message: quote }], caseResults: [] };
    const wireAnswer = { ...answer(request, { ...source, run: null }), evidence: [{ runId: source.run.id, kind, quote, caseIndex: null }] };
    const fixture = setup(async () => { calls++; return sseCompletion(JSON.stringify(wireAnswer)); });
    Object.assign(fixture.source, source);
    const result = await fixture.service.request(request);
    assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(calls, 1);
    assert.deepEqual(result.response?.evidence, [{ runId: source.run.id, kind, quote }]);
    const stored = fixture.repository.getAIRequest(result.id)!;
    assert.ok(!Object.hasOwn(stored.response!.evidence[0], 'caseIndex'));
    assert.deepEqual((await new AiService(fixture.options).request(request)).response, stored.response);
    assert.equal(calls, 1);
  }
});

test('Forged official citations fail after one repair with a safe validation reason and no raw model answer in persisted state', async () => {
  const cases = [
    { quote: '{"totalCases":5,"passedCases":4}', runId: 'official-synthetic', reason: 'quote' },
    { quote: '{"totalCases":"5","passedCases":5}', runId: 'official-synthetic', reason: 'quote' },
    { quote: '{"status":"accepted","inventedField":"SYNTHETIC-RAW-MODEL-RESPONSE"}', runId: 'official-synthetic', reason: 'quote' },
    { quote: '{"totalCases":5,"passedCases":5}', runId: 'SYNTHETIC-RAW-MODEL-RESPONSE', reason: 'officialRun' },
  ];
  for (const candidate of cases) {
    const source = officialContext(), request = input(), marker = 'SYNTHETIC-RAW-MODEL-RESPONSE'; let calls = 0;
    const wireAnswer = { ...answer(request, source), title: marker,
      evidence: [{ runId: candidate.runId, kind: 'official', quote: candidate.quote, caseIndex: null }] };
    const fixture = setup(async (_url, init) => {
      calls++;
      const messages = JSON.parse(String(init?.body)).messages;
      assert.ok(!JSON.stringify(messages).includes(marker));
      if (calls === 2) {
        const parts = messages.at(-1).content.split('\n\n'); assert.equal(parts.length, 2);
        const repair = JSON.parse(parts[1]);
        assert.equal(repair.reason, 'POLICY_VIOLATION'); assert.equal(typeof repair.repairHint, 'string');
        assert.deepEqual(Object.keys(repair).sort(), ['reason', 'repairHint', 'task']);
      }
      return sseCompletion(JSON.stringify(wireAnswer));
    });
    Object.assign(fixture.source, source);
    const result = await fixture.service.request(request);
    assert.equal(result.status, 'failed'); assert.equal(result.response, null); assert.equal(result.cachedFromRequestId, null);
    assert.equal(result.error?.code, 'POLICY_VIOLATION'); assert.equal(result.error?.validationReason, candidate.reason);
    assert.equal(result.error?.retryable, false);
    assert.deepEqual(Object.keys(result.error!).sort(), ['code', 'message', 'retryable', 'validationReason']);
    assert.deepEqual(result.error, new AiServiceError('POLICY_VIOLATION', { validationReason: candidate.reason as 'quote' | 'officialRun' }).detail);
    assert.equal(calls, 2); assert.equal(result.usage?.calls, 2);
    assert.equal(fixture.events.filter(event => event.phase === 'repairing').length, 1);
    assert.equal(fixture.events.filter(event => event.phase === 'failed').length, 1);
    assert.ok(!fixture.events.some(event => event.phase === 'completed'));
    const stored = fixture.repository.listAIRequests(source.attemptId);
    assert.equal(stored.length, 1); assert.deepEqual(stored[0].error, result.error); assert.equal(stored[0].response, null);
    const published = canonicalJson([result, stored, fixture.events]);
    assert.ok(!published.includes(marker)); assert.ok(!published.includes('repairHint'));
    assert.deepEqual(await new AiService(fixture.options).request(request), result); assert.equal(calls, 2);
  }
});

test('A nullable case index does not authorize a local test citation without a real case index', async () => {
  const source = context(), request = { ...input(), kind: 'diagnosis' as const }; let calls = 0;
  const wireAnswer = { ...answer(request, source), evidence: [{ runId: source.run!.id, kind: 'test', quote: canonicalJson(source.run!.caseResults[0]), caseIndex: null }] };
  const fixture = setup(async () => { calls++; return sseCompletion(JSON.stringify(wireAnswer)); });
  const result = await fixture.service.request(request);
  assert.equal(result.status, 'failed'); assert.equal(result.error?.validationReason, 'testCase');
  assert.equal(result.response, null); assert.equal(calls, 2);
});

test('Official evidence still rejects a numeric case index and results from another code revision', async () => {
  for (const mismatch of ['case-index', 'code-revision'] as const) {
    const source = officialContext(), request = input(); let calls = 0;
    if (mismatch === 'code-revision') source.official!.codeHash = sha256('synthetic other revision');
    const wireAnswer = { ...answer(request, source), evidence: [{ runId: source.official!.id, kind: 'official', quote: 'Accepted', caseIndex: mismatch === 'case-index' ? 0 : null }] };
    const fixture = setup(async () => { calls++; return sseCompletion(JSON.stringify(wireAnswer)); });
    Object.assign(fixture.source, source);
    if (mismatch === 'code-revision') {
      await assert.rejects(fixture.service.request(request), error => error instanceof AiServiceError && error.detail.code === 'INVALID_REQUEST');
      assert.equal(calls, 0); assert.equal(fixture.repository.records.size, 0);
      continue;
    }
    const result = await fixture.service.request(request);
    assert.equal(result.status, 'failed'); assert.equal(result.error?.validationReason, 'officialRun');
    assert.equal(result.response, null); assert.equal(calls, 2);
  }
});
