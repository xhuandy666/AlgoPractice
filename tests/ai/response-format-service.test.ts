import test from 'node:test';
import assert from 'node:assert/strict';
import { AiService, canonicalJson } from '../../src/ai/index.ts';
import type { AiEvent } from '../../src/shared/ai.ts';
import { config, context, input, MemoryRepository, mockVault, sseCompletion } from './helpers.ts';

function fixture(contents: string[]) {
  const source = context(), repository = new MemoryRepository(), events: AiEvent[] = [];
  let calls = 0;
  const service = new AiService({ repository, vault: mockVault(), resolveContext: () => source, resolveProvider: config,
    onEvent: event => events.push(event), fetchImpl: async (_url, init) => {
      calls++; const body = String(init?.body);
      if (calls > 1) assert.match(body, /One format repair only/);
      return sseCompletion(contents[Math.min(calls - 1, contents.length - 1)]);
    } });
  return { source, repository, events, service, calls: () => calls };
}

test('Compact wrapped chat is normalized once, persisted completely and read idempotently without another provider call', async () => {
  const raw = { schemaVersion: 2, kind: 'chat', explanation: '先用短数组检查累积值，说明每一步已经处理了哪些元素。' };
  const value = fixture([`下面是建议：\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``]);
  const request = { ...input(), kind: 'chat' as const };
  const result = await value.service.request(request);
  assert.equal(result.status, 'completed'); assert.equal(value.calls(), 1);
  assert.equal(result.response?.explanation, raw.explanation); assert.equal(result.response?.patch, null);
  assert.equal(result.response?.completeSolution, null); assert.deepEqual(result.response?.evidence, []);
  assert.ok(!value.events.some(event => event.phase === 'repairing'));
  assert.deepEqual(value.repository.getAIRequest(result.id)?.response, result.response);
  const reused = await value.service.request(request);
  assert.equal(reused.id, result.id); assert.deepEqual(reused.response, result.response);
  assert.equal(value.calls(), 1);
});

test('Natural chat is shown only after validation and cannot acquire a patch or evidence', async () => {
  const raw = '可以先试 [1, 2, 3]：每次迭代前，累积值应代表前面已经处理的元素。';
  const value = fixture([raw]);
  const result = await value.service.request({ ...input(), kind: 'chat' });
  assert.equal(result.status, 'completed'); assert.equal(value.calls(), 1);
  assert.equal(result.response?.explanation, raw); assert.equal(result.response?.patch, null);
  assert.equal(result.response?.completeSolution, null); assert.deepEqual(result.response?.evidence, []);
  assert.ok(!canonicalJson(value.events).includes(raw));
});

test('An incomplete old-style hint answer is compatible without turning the hint into a code action', async () => {
  const raw = { schemaVersion: 2, kind: 'hint', explanation: '想一想，循环结束后应该返回哪个已经维护好的值？' };
  const value = fixture([JSON.stringify(raw)]);
  const result = await value.service.request({ ...input(), kind: 'hint' });
  assert.equal(result.status, 'completed'); assert.equal(value.calls(), 1);
  assert.equal(result.response?.kind, 'hint'); assert.equal(result.response?.patch, null);
  assert.equal(result.response?.completeSolution, null); assert.deepEqual(result.response?.inferences, []);
});

for (const variant of ['truncated', 'extra-object', 'unknown-tools', 'wrong-kind', 'forged-evidence', 'false-success'] as const) {
  test(`Unsafe response ${variant} still repairs at most once and never persists raw model content`, async () => {
    const marker = 'UNVALIDATED-FORMAT-FIXTURE';
    const raw = variant === 'truncated' ? `{"schemaVersion":2,"kind":"chat","explanation":"${marker}`
      : variant === 'extra-object' ? `{"schemaVersion":2,"kind":"chat","explanation":"${marker}"}\n{"extra":true}`
      : JSON.stringify({ schemaVersion: 2, kind: variant === 'wrong-kind' ? 'diagnosis' : 'chat', explanation: variant === 'false-success' ? `代码已获得官方 AC。${marker}` : marker,
        ...(variant === 'unknown-tools' ? { tools: [{ name: 'execute' }] } : {}),
        ...(variant === 'forged-evidence' ? { evidence: [{ runId: 'not-current-run', kind: 'test', caseIndex: 0, quote: 'wrong_answer' }] } : {}) });
    const value = fixture([raw]);
    const result = await value.service.request({ ...input(), kind: 'chat' });
    assert.equal(result.status, 'failed'); assert.equal(value.calls(), 2); assert.equal(result.response, null);
    assert.equal(value.events.filter(event => event.phase === 'repairing').length, 1);
    assert.ok(!canonicalJson([result, value.repository.getAIRequest(result.id), value.events]).includes(marker));
  });
}

test('Key echoes in normalized text or wrapper prose remain rejected before persistence or format repair', async () => {
  for (const raw of ['先思考 synthetic-unit-key-12345 应怎样处理。', `synthetic-unit-key-12345\n${JSON.stringify({ schemaVersion: 2, kind: 'chat', explanation: '检查累积值。' })}`]) {
    const value = fixture([raw]);
    const result = await value.service.request({ ...input(), kind: 'chat' });
    assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'POLICY_VIOLATION');
    assert.equal(value.calls(), 1); assert.equal(result.response, null);
    assert.ok(!canonicalJson([result, value.events]).includes('synthetic-unit-key-12345'));
  }
});
