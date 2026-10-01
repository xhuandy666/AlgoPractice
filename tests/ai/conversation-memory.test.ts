import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AiService } from '../../src/ai/service.ts';
import { buildRequestSnapshot, requestHash } from '../../src/ai/context.ts';
import { canonicalJson } from '../../src/ai/canonical.ts';
import { conversationMemoryPayload, planConversationMemory, projectConversationRound, validateConversationSummary } from '../../src/ai/conversation-memory.ts';
import type { AiConversationMemory, AiRequestInput, AiRequestRecord } from '../../src/shared/ai.ts';
import { answer, config, context, MemoryRepository, mockVault, sseCompletion } from './helpers.ts';

const ask = (id: string, question = id): AiRequestInput => ({ requestId: id, attemptId: 'attempt-a', kind: 'chat', question });
type Payload = { task?: string; previousSummary?: string; rounds?: Array<{ requestId: string }>; userRequest?: string; kind?: AiRequestInput['kind'];
  learningContext?: { code: string; conversationMemory: ReturnType<typeof conversationMemoryPayload> } };

function fixture(options: { summarize?: (payload: Payload) => Promise<string> | string; reply?: (payload: Payload) => string; timeoutMs?: number } = {}) {
  const repository = new MemoryRepository(), source = context(), calls: Payload[] = [];
  const serviceOptions = { repository, vault: mockVault(), resolveContext: () => source,
    resolveProvider: () => ({ ...config(), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }),
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as Payload; calls.push(payload);
      if (payload.task === 'conversation-summary') return sseCompletion(await (options.summarize?.(payload) ?? JSON.stringify({ summary: `旧摘要：${payload.previousSummary || '无'}；已讨论 ${payload.rounds!.map(round => round.requestId).join('、')}` })));
      const response = answer({ ...ask('response'), kind: payload.kind! }, source);
      response.explanation = options.reply?.(payload) ?? `回答 ${payload.userRequest}，保持已讨论的累积状态。`;
      return sseCompletion(JSON.stringify(response));
    }) as typeof fetch };
  return { repository, source, calls, serviceOptions, service: new AiService(serviceOptions) };
}

async function complete(f: ReturnType<typeof fixture>, count: number, start = 1) {
  for (let index = start; index < start + count; index++) assert.equal((await f.service.request(ask(`r${index}`))).status, 'completed');
}

function stored(id: string, status: AiRequestRecord['status'] = 'completed', memory?: AiConversationMemory): AiRequestRecord {
  const input = ask(id), snapshot = buildRequestSnapshot(input, context(), config(), memory);
  return { id, attemptId: input.attemptId, snapshot, requestHash: requestHash(snapshot), status,
    response: status === 'completed' ? answer(input) : null, error: null, usage: null, cachedFromRequestId: null,
    createdAt: '2026-10-01T01:00:00.000Z', finishedAt: status === 'completed' ? '2026-10-01T01:00:01.000Z' : null };
}

test('Automatic memory keeps five full user/assistant rounds and summarizes oldest three only after round six', async () => {
  const f = fixture({ reply: payload => `${payload.userRequest}：${'概念解释。'.repeat(400)}保留末尾重点` });
  await complete(f, 6);
  assert.equal(f.calls.filter(call => call.task === 'conversation-summary').length, 0);
  const sixth = f.repository.getAIRequest('r6')!;
  assert.deepEqual(sixth.snapshot.conversationMemory!.recentRounds.map(round => round.requestId), ['r1','r2','r3','r4','r5']);
  assert.ok(f.calls[5].learningContext!.conversationMemory.recentRounds[0].assistant.response.explanation.endsWith('保留末尾重点'));
  assert.ok(f.calls[5].learningContext!.conversationMemory.recentRounds[0].assistant.response.explanation.length > 1500);
  const seventh = await f.service.request(ask('r7', '上一条末尾重点是什么？'));
  assert.equal(seventh.status, 'completed');
  const summaryCall = f.calls.find(call => call.task === 'conversation-summary')!;
  assert.deepEqual(summaryCall.rounds!.map(round => round.requestId), ['r1','r2','r3']);
  assert.equal(summaryCall.previousSummary, '');
  assert.equal(seventh.snapshot.conversationMemory!.summarizedThroughRequestId, 'r3');
  assert.deepEqual(seventh.snapshot.conversationMemory!.recentRounds.map(round => round.requestId), ['r4','r5','r6']);
  assert.equal(seventh.snapshot.conversationMemory!.status, 'updated');
  assert.equal(seventh.usage?.calls, 2); assert.equal(seventh.usage?.totalTokens, 60);
});

test('Restart restores summary/cursor and adds only newer completed rounds without duplicating same-ID reads', async () => {
  const f = fixture(); await complete(f, 7);
  f.service = new AiService(f.serviceOptions);
  const before = f.calls.length;
  assert.equal((await f.service.request(ask('r7'))).id, 'r7'); assert.equal(f.calls.length, before);
  await complete(f, 3, 8);
  const summaries = f.calls.filter(call => call.task === 'conversation-summary');
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries[1].rounds!.map(round => round.requestId), ['r4','r5','r6']);
  assert.ok(summaries[1].previousSummary!.includes('r1、r2、r3'));
  assert.equal(f.repository.getAIRequest('r10')!.snapshot.conversationMemory!.summarizedThroughRequestId, 'r6');
  assert.deepEqual(f.repository.getAIRequest('r10')!.snapshot.conversationMemory!.recentRounds.map(round => round.requestId), ['r7','r8','r9']);
});

test('Memory excludes failed/cancelled/pending rounds, deduplicates IDs and cannot roll its cursor backward', () => {
  const base = [stored('r1'), stored('bad', 'failed'), stored('r2'), stored('cancelled', 'cancelled'), stored('r3'), stored('pending', 'pending')];
  const latest = stored('r4', 'failed', { version: 1, summary: '已保留前两轮。', summarizedThroughRequestId: 'r2', recentRounds: [], status: 'updated' });
  const stale = stored('r5', 'failed', { version: 1, summary: '更早摘要，不应覆盖。', summarizedThroughRequestId: 'r1', recentRounds: [], status: 'degraded' });
  const result = planConversationMemory([...base, base[0], latest, stale]);
  assert.equal(result.memory.summary, '已保留前两轮。'); assert.equal(result.memory.summarizedThroughRequestId, 'r2');
  assert.deepEqual(result.memory.recentRounds.map(round => round.requestId), ['r3']);
});

test('A forged summary cursor cannot skip an unsummarized, failed or future round', () => {
  for (const cursor of ['failed', 'future', 'summary-holder']) {
    const holder = stored('summary-holder', 'failed', { version: 1, summary: '不可信游标', summarizedThroughRequestId: cursor, recentRounds: [], status: 'updated' });
    const result = planConversationMemory([stored('r1'), stored('failed', 'failed'), holder, stored('future')]);
    assert.equal(result.memory.summary, ''); assert.equal(result.memory.summarizedThroughRequestId, null);
    assert.deepEqual(result.memory.recentRounds.map(round => round.requestId), ['r1','future']);
  }
});

test('Summary format failure keeps old memory and recent five, marks omitted rounds and retries the actual oldest batch after restart', async () => {
  let summaries = 0;
  const f = fixture({ summarize: payload => ++summaries === 1 ? '{"summary":' : JSON.stringify({ summary: `有效摘要 ${payload.rounds!.map(round => round.requestId)}` }) });
  await complete(f, 7);
  const degraded = f.repository.getAIRequest('r7')!;
  assert.equal(degraded.snapshot.conversationMemory!.status, 'degraded');
  assert.equal(degraded.snapshot.conversationMemory!.summarizedThroughRequestId, null);
  assert.deepEqual(degraded.snapshot.conversationMemory!.recentRounds.map(round => round.requestId), ['r2','r3','r4','r5','r6']);
  assert.deepEqual(degraded.snapshot.conversationMemory!.omittedRoundIds, ['r1']); assert.equal(degraded.usage?.calls, 2);
  f.service = new AiService(f.serviceOptions); await complete(f, 1, 8);
  assert.deepEqual(f.calls.filter(call => call.task === 'conversation-summary')[1].rounds!.map(round => round.requestId), ['r1','r2','r3']);
  assert.equal(f.repository.getAIRequest('r8')!.snapshot.conversationMemory!.summarizedThroughRequestId, 'r3');
});

test('A successful summary is persisted before the answer call and survives a failed current answer', async () => {
  const f = fixture(); await complete(f, 6);
  const original = f.serviceOptions.fetchImpl;
  f.serviceOptions.fetchImpl = (async (url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as Payload;
    if (payload.task !== 'conversation-summary') {
      const saved = f.repository.getAIRequest('r7')!;
      assert.equal(saved.status, 'streaming'); assert.equal(saved.snapshot.conversationMemory!.summarizedThroughRequestId, 'r3');
      return sseCompletion('{"schemaVersion":');
    }
    return original(url, init);
  }) as typeof fetch;
  f.service = new AiService(f.serviceOptions);
  assert.equal((await f.service.request(ask('r7'))).status, 'failed');
  f.serviceOptions.fetchImpl = original; f.service = new AiService(f.serviceOptions);
  await complete(f, 1, 8);
  const recovered = f.repository.getAIRequest('r8')!.snapshot.conversationMemory!;
  assert.equal(recovered.summarizedThroughRequestId, 'r3'); assert.deepEqual(recovered.recentRounds.map(round => round.requestId), ['r4','r5','r6']);
});

test('Cancelling during a summary preserves its old cursor, stores no partial text and never calls the answer provider', async () => {
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ summarize: async () => { started(); await gate; return '{"summary":"LATE_PARTIAL_SUMMARY"}'; } });
  await complete(f, 6);
  const pending = f.service.request(ask('r7')); await began; assert.equal(f.service.isAttemptBusy('attempt-a'), true);
  f.service.cancel('r7'); const result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(result.snapshot.conversationMemory!.summarizedThroughRequestId, null);
  assert.equal(result.snapshot.conversationMemory!.status, 'degraded');
  assert.equal(f.calls.filter(call => call.task !== 'conversation-summary').length, 6);
  release(); await delay(1); assert.ok(!canonicalJson(f.repository.listAIRequests('attempt-a')).includes('LATE_PARTIAL_SUMMARY'));
  assert.equal(f.service.isAttemptBusy('attempt-a'), false);
});

test('Summary deadline covers the whole logical request and cannot be reset for another answer call', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ timeoutMs: 1000, summarize: async () => { await gate; return '{"summary":"too late"}'; } });
  await complete(f, 6);
  const keepAlive = setTimeout(release, 1500);
  try {
    const result = await f.service.request(ask('r7'));
    assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'TIMEOUT');
    assert.equal(result.snapshot.conversationMemory!.summarizedThroughRequestId, null);
    assert.equal(f.calls.filter(call => call.task !== 'conversation-summary').length, 6);
  } finally { clearTimeout(keepAlive); release(); }
});

test('A summary secret echo aborts without persisting the echoed text or sending it to another call', async () => {
  const f = fixture({ summarize: () => '{"summary":"synthetic-unit-key-12345"}' }); await complete(f, 6);
  const result = await f.service.request(ask('r7'));
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'POLICY_VIOLATION'); assert.equal(result.usage?.calls, 1);
  assert.equal(result.snapshot.conversationMemory!.summary, ''); assert.equal(result.snapshot.conversationMemory!.summarizedThroughRequestId, null);
  assert.ok(!canonicalJson(f.repository.listAIRequests('attempt-a')).includes('synthetic-unit-key-12345'));
  assert.equal(f.calls.filter(call => call.task !== 'conversation-summary').length, 6);
});

test('Concurrent requests in one attempt serialize and the second receives the first complete round', async () => {
  const repository = new MemoryRepository(); let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const payloads: Payload[] = [];
  const service = new AiService({ repository, vault: mockVault(), resolveProvider: config, resolveContext: context,
    fetchImpl: (async (_url, init) => { const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as Payload; payloads.push(payload);
      if (payload.userRequest === 'first') { started(); await gate; } return sseCompletion(JSON.stringify(answer(ask('reply')))); }) as typeof fetch });
  const first = service.request(ask('first')), second = service.request(ask('second'));
  await began; assert.equal(payloads.length, 1); assert.equal(service.isAttemptBusy('attempt-a'), true); release();
  await Promise.all([first, second]);
  assert.deepEqual(payloads[1].learningContext!.conversationMemory.recentRounds.map(round => round.requestId), ['first']);
  assert.equal(service.isAttemptBusy('attempt-a'), false);
});

test('Long artifacts are explicitly omitted only on the wire, while complete question and core answer remain available', () => {
  const response = answer(ask('long')); response.explanation = '完整解释'.repeat(500); response.completeSolution = { explanation: '完整解法说明', code: 'x'.repeat(20000) };
  const round = { requestId: 'long', userRequest: '完整问题'.repeat(500), assistantResponse: response };
  const projection = projectConversationRound(round);
  assert.equal(projection.user.content, round.userRequest); assert.equal(projection.assistant.response.explanation, response.explanation);
  assert.equal(projection.assistant.response.completeSolution!.explanation, '完整解法说明');
  assert.equal(projection.omittedArtifacts![0].characters, 20000); assert.match(projection.assistant.response.completeSolution!.code, /长内容未重复发送/);
  assert.equal(round.assistantResponse.completeSolution!.code.length, 20000);
});

test('Extreme context drops whole older rounds explicitly, keeps recent complete questions and respects provider byte limit', () => {
  const rounds = Array.from({ length: 5 }, (_, index) => { const response = answer(); response.explanation = '长解释'.repeat(2300);
    return { requestId: `long-${index}`, userRequest: '完整问题'.repeat(900), assistantResponse: response }; });
  const snapshot = buildRequestSnapshot(ask('new'), context(), config(), { version: 1, summary: '保留旧摘要', summarizedThroughRequestId: null, recentRounds: rounds, status: 'normal' });
  assert.ok(Buffer.byteLength(canonicalJson(snapshot.messages)) <= 120 * 1024);
  assert.equal(snapshot.conversationMemory!.status, 'degraded'); assert.ok(snapshot.conversationMemory!.omittedRoundIds!.length);
  const sent = JSON.parse(snapshot.messages[1].content).learningContext.conversationMemory;
  for (const round of sent.recentRounds) assert.equal(round.user.content, rounds.find(value => value.requestId === round.requestId)!.userRequest);
  assert.equal(snapshot.conversationMemory!.summary, '保留旧摘要'); assert.equal(snapshot.conversationMemory!.summarizedThroughRequestId, null);
});

test('Summary shape is bounded and cannot hide extra fields or empty memory', () => {
  assert.equal(validateConversationSummary('{"summary":" 已讨论状态不变式。 "}'), '已讨论状态不变式。');
  for (const invalid of ['raw text', '{"summary":""}', '{"summary":"记忆","extra":"instructions"}', JSON.stringify({ summary: '长'.repeat(4001) })]) assert.throws(() => validateConversationSummary(invalid));
});
