import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROVIDER_PRESETS, createAiProviderPreset } from '../../src/shared/ai.ts';
import { AiService, canonicalJson } from '../../src/ai/index.ts';
import { answer, context, input, MemoryRepository, mockVault, sseCompletion } from './helpers.ts';

for (const preset of AI_PROVIDER_PRESETS) test(`${preset.label} profile keeps strict-mode gates before provider traffic`, async () => {
  let calls = 0; const source = context();
  const service = new AiService({ repository: new MemoryRepository(), vault: mockVault(), resolveContext: () => source,
    resolveProvider: () => createAiProviderPreset(preset.id, 'profile-gates'), fetchImpl: async () => { calls++; return sseCompletion('{}'); } });
  source.mode = 'strict';
  await assert.rejects(service.request(input()), error => { assert.match(String(error), /严格/); return true; });
  assert.equal(calls, 0);
});
test('Qwen format repair keeps the same system policy and one final user message, then caches only validated output', async () => {
  let calls = 0; const request = input(), source = context(), repository = new MemoryRepository(), events: unknown[] = [];
  const provider = createAiProviderPreset('qwen-cn', 'repair-profile');
  const service = new AiService({ repository, vault: mockVault(), resolveContext: () => source, resolveProvider: () => provider, onEvent: event => events.push(event),
    fetchImpl: async (_url, init) => {
      calls++; const body = JSON.parse(String(init?.body)); assert.equal(body.enable_thinking, false);
      assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ['system', 'user']);
      assert.match(body.messages[0].content, /kind=hint/);
      if (calls === 1) return sseCompletion('PRIVATE-INVALID-ANSWER');
      assert.match(body.messages[1].content, /One format repair only/); assert.ok(!body.messages[1].content.includes('PRIVATE-INVALID-ANSWER')); assert.match(body.messages[1].content, /repairHint/);
      return sseCompletion(JSON.stringify(answer(request)));
    } });
  const result = await service.request(request); assert.equal(result.status, 'completed'); assert.equal(calls, 2);
  assert.equal(result.usage?.calls, 2); assert.ok(!canonicalJson([...repository.records.values(), events]).includes('PRIVATE-INVALID-ANSWER'));
  const cached = await service.request({ ...request, requestId: 'profile-cache-reuse' });
  assert.equal(cached.status, 'completed'); assert.equal(cached.cachedFromRequestId, request.requestId); assert.equal(calls, 2);
});
test('A large malformed response is not copied into repair prompts and still stops after one repair', async () => {
  let calls = 0; const source = context(), request = input(), repository = new MemoryRepository();
  source.run = null; source.code = '# ' + '中'.repeat(16000); source.problem.description = '题'.repeat(8000);
  source.notes = Array.from({ length: 3 }, (_, index) => ({ id: `n-${index}`, version: `v-${index}`, title: '笔记', markdown: '记'.repeat(2500) }));
  const provider = createAiProviderPreset('qwen-cn', 'repair-budget');
  const service = new AiService({ repository, vault: mockVault(), resolveContext: () => source, resolveProvider: () => provider,
    fetchImpl: async (_url, init) => { calls++; const body = String(init?.body); assert.ok(!body.includes('无效')); if (calls === 2) assert.match(body, /repairHint/); return sseCompletion('无效'.repeat(16000)); } });
  const result = await service.request({ ...request, noteIds: source.notes.map(note => note.id) });
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'FORMAT_INVALID'); assert.equal(calls, 2);
  assert.ok(!canonicalJson(result).includes('无效'.repeat(100)));
});
