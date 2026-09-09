import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROVIDER_PRESETS, createAiProviderPreset } from '../../src/shared/ai.ts';
import { AiServiceError, chatCompletion } from '../../src/ai/index.ts';
import { config, sseCompletion } from './helpers.ts';

const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const choice = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const counts = { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 };
const options = () => ({ config: config(), key: 'synthetic-protocol-key', messages: [{ role: 'user' as const, content: 'Return JSON.' }], signal: new AbortController().signal });
const response = (wire: string) => new Response(wire, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
const isCode = (code: string) => (error: unknown) => error instanceof AiServiceError && error.detail.code === code;

for (const preset of AI_PROVIDER_PRESETS) test(`${preset.label} sends its documented non-thinking options as top-level HTTP fields`, async () => {
  const provider = createAiProviderPreset(preset.id, 'profile-request');
  await chatCompletion({ ...options(), config: provider, fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, provider.model); assert.equal(body.max_tokens, 4096);
    assert.equal(body.temperature, 0.2); assert.equal(body.stream, true);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.extra_body, undefined); assert.equal(body.tools, undefined); assert.equal(body.enable_search, undefined);
    if (provider.compatibility === 'qwen') { assert.equal(body.enable_thinking, false); assert.equal(body.thinking, undefined); }
    else { assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.enable_thinking, undefined); }
    assert.deepEqual(body.stream_options, provider.includeUsage ? { include_usage: true } : undefined);
    return sseCompletion('{"ok":true}');
  } });
});
test('Legacy and explicitly generic configs do not send vendor extension parameters', async () => {
  for (const provider of [config(), { ...config(), compatibility: 'openai-compatible' as const }]) {
    await chatCompletion({ ...options(), config: provider, fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); assert.equal(body.thinking, undefined); assert.equal(body.enable_thinking, undefined);
      return sseCompletion('{"ok":true}');
    } });
  }
});
test('Qwen nullable-role deltas and its separate final usage packet are decoded without promoting reasoning', async () => {
  const wire = event(choice({ role: 'assistant', content: '', tool_calls: null, function_call: null }))
    + event(choice({ role: null, content: null, reasoning_content: 'PRIVATE-REASONING-FIXTURE' }))
    + event({ choices: [], usage: null }) + event({ choices: [], usage: {} })
    + event(choice({ role: null, content: '{"中文":', tool_calls: null, function_call: null }))
    + event(choice({ role: null, content: '"数组 🌳"}' }))
    + event(choice({ role: null, content: '' }, 'stop')) + event({ choices: [], usage: counts }) + 'data: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(wire), progress: number[] = [];
  const result = await chatCompletion({ ...options(), config: createAiProviderPreset('qwen-cn', 'nullable-role'), onProgress: bytes => progress.push(bytes), fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 5) controller.enqueue(bytes.slice(offset, offset + 5)); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(result.content, '{"中文":"数组 🌳"}'); assert.equal(result.usage?.totalTokens, 30);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-REASONING-FIXTURE')); assert.ok(progress.length > 1);
});
test('DeepSeek usage on its final content choice and SSE keepalive comments are accepted', async () => {
  const wire = ': keep-alive\n\n' + event(choice({ role: 'assistant', reasoning_content: 'PRIVATE-DEEPSEEK-REASONING', content: null }))
    + event(choice({ content: '{"ok":true}' }))
    + event({ ...choice({ content: '' }, 'stop'), usage: { ...counts, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 1 } }) + 'data: [DONE]\n\n';
  const result = await chatCompletion({ ...options(), config: createAiProviderPreset('deepseek-cn', 'final-choice-usage'), fetchImpl: async () => response(wire) });
  assert.equal(result.content, '{"ok":true}'); assert.equal(result.usage?.inputTokens, 21);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-DEEPSEEK-REASONING'));
});
test('GLM native final usage works without stream_options.include_usage', async () => {
  const wire = event(choice({ role: 'assistant', content: '{"ok":true}' }))
    + event({ ...choice({}, 'stop'), usage: counts }) + 'data: [DONE]\n\n';
  const result = await chatCompletion({ ...options(), config: createAiProviderPreset('glm-cn', 'glm-usage'), fetchImpl: async () => response(wire) });
  assert.equal(result.content, '{"ok":true}'); assert.equal(result.usage?.outputTokens, 9);
});
test('[DONE] closes a valid response without waiting for the server to close its socket', async () => {
  let cancelled = false;
  const wire = event(choice({ content: '{"ok":true}' }, 'stop')) + 'data: [DONE]\n\n';
  const result = await chatCompletion({ ...options(), signal: AbortSignal.timeout(1000), fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(wire)); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(result.content, '{"ok":true}'); assert.equal(cancelled, true);
});
for (const [name, wire] of [
  ['reasoning without an answer', event(choice({ reasoning_content: 'not-an-answer', content: null }, 'stop')) + 'data: [DONE]\n\n'],
  ['usage without an answer', event({ choices: [], usage: counts }) + 'data: [DONE]\n\n'],
  ['answer without a stop finish reason', event(choice({ content: '{"ok":true}' })) + 'data: [DONE]\n\n'],
  ['truncated JSON answer', event(choice({ content: '{"ok":true}' }, 'length')) + 'data: [DONE]\n\n'],
  ['wrong role', event(choice({ role: 'user', content: '{"ok":true}' }, 'stop')) + 'data: [DONE]\n\n'],
  ['missing done marker', event(choice({ content: '{"ok":true}' }, 'stop'))],
] as const) test(`Compatibility still rejects ${name}`, async () => {
  await assert.rejects(chatCompletion({ ...options(), fetchImpl: async () => response(wire) }), isCode('UNSUPPORTED_RESPONSE'));
});
test('Ignored reasoning and keepalive bytes still exhaust the response limit', async () => {
  for (const wire of [event(choice({ reasoning_content: 'R'.repeat(512 * 1024), content: null })), ': ' + ' '.repeat(512 * 1024) + '\n\n']) {
    await assert.rejects(chatCompletion({ ...options(), fetchImpl: async () => response(wire) }), isCode('RESPONSE_TOO_LARGE'));
  }
});
test('Provider HTTP failures do not automatically retry or expose error body content', async () => {
  for (const status of [401, 429, 503]) {
    let calls = 0;
    await assert.rejects(chatCompletion({ ...options(), config: createAiProviderPreset('qwen-cn', 'no-retry'), fetchImpl: async () => {
      calls++; return new Response('PRIVATE-ERROR-BODY', { status, headers: { 'retry-after': '2' } });
    } }), error => { assert.ok(error instanceof AiServiceError); assert.ok(!String(error).includes('PRIVATE-ERROR-BODY')); return true; });
    assert.equal(calls, 1);
  }
});
test('The entire HTTP request, including JSON escaping, is byte-bounded before any upload', async () => {
  for (const content of ['中'.repeat(44000), '\u0000'.repeat(22000)]) {
    let calls = 0;
    await assert.rejects(chatCompletion({ ...options(), messages: [{ role: 'user', content }], fetchImpl: async () => { calls++; return sseCompletion('{}'); } }), isCode('INVALID_REQUEST'));
    assert.equal(calls, 0);
  }
});
