import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AiServiceError, chatCompletion, combineUsage } from '../../src/ai/index.ts';
import { config, jsonCompletion, sseCompletion, sseText } from './helpers.ts';

const options = () => ({ config: config(), key: 'synthetic-provider-key', messages: [{ role: 'user' as const, content: 'fixture' }], signal: new AbortController().signal });
const isCode = (code: string) => (error: unknown) => error instanceof AiServiceError && error.detail.code === code;
test('SSE decoder handles UTF-8 codepoints split across actual byte chunks', async () => { const content = '{"中文":"树与链表 🌳"}', bytes = new TextEncoder().encode(sseText(content)); const events: number[] = [];
  const result = await chatCompletion({ ...options(), onProgress: count => events.push(count), fetchImpl: async () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }) });
  assert.equal(result.content, content); assert.equal(result.streaming, true); assert.equal(result.usage?.totalTokens, 30); assert.ok(events.length > 2); assert.ok(events.every((value, index) => index === 0 || value > events[index - 1])); });
test('Provider request has a fixed destination, no cookies or redirects, and does not place its key in the model messages', async () => {
  await chatCompletion({ ...options(), fetchImpl: async (url, init) => { assert.equal(url, 'https://provider.example.invalid/v1/chat/completions'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-provider-key'); const body = JSON.parse(String(init?.body)); assert.equal(body.stream, true); assert.equal(body.model, 'fixture-model'); assert.equal(body.stream_options.include_usage, true); assert.ok(!String(init?.body).includes('synthetic-provider-key')); assert.equal(body.response_format, undefined); return sseCompletion('{"ok":true}'); } });
});
test('Optional JSON mode and stream usage options are explicit provider configuration', async () => { await chatCompletion({ ...options(), config: { ...config(), jsonMode: true, includeUsage: false }, fetchImpl: async (_url, init) => { const body = JSON.parse(String(init?.body)); assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.stream_options, undefined); return jsonCompletion('{"ok":true}', false); } }); });
for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMITED'], [500, 'PROVIDER'], [400, 'UNSUPPORTED_RESPONSE']] as const) test(`HTTP ${status} is classified without retaining error bodies`, async () => {
  await assert.rejects(chatCompletion({ ...options(), fetchImpl: async () => new Response('private-provider-body-secret', { status, headers: { 'retry-after': '999999' } }) }), error => { assert.ok(isCode(code)(error)); assert.ok(!String(error).includes('private-provider-body-secret')); if (status === 429) assert.equal((error as AiServiceError).detail.retryAfterMs, 300000); return true; });
});
test('Network exceptions are classified without exposing arbitrary error text', async () => { await assert.rejects(chatCompletion({ ...options(), fetchImpl: async () => { throw new Error('unsafe-network-body-secret'); } }), error => { assert.ok(isCode('NETWORK')(error)); assert.ok(!String(error).includes('unsafe-network-body-secret')); return true; }); });
test('Declared and streamed response size limits both stop oversized output', async () => {
  await assert.rejects(chatCompletion({ ...options(), fetchImpl: async () => new Response('tiny', { headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024) } }) }), isCode('RESPONSE_TOO_LARGE'));
  await assert.rejects(chatCompletion({ ...options(), fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'application/json' } }) }), isCode('RESPONSE_TOO_LARGE'));
});
for (const [name, body, type] of [
  ['malformed SSE JSON', 'data: {bad}\n\ndata: [DONE]\n\n', 'text/event-stream'],
  ['missing final marker', sseText('{}').replace('data: [DONE]\n\n', ''), 'text/event-stream'],
  ['truncated choice', sseText('{}').replace('"finish_reason":"stop"', '"finish_reason":"length"'), 'text/event-stream'],
  ['tool call', 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{}]},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', 'text/event-stream'],
  ['unexpected content type', '{}', 'text/html'],
  ['non-string content', '{"choices":[{"message":{"role":"assistant","content":[{}]},"finish_reason":"stop"}]}', 'application/json'],
] as const) test(`Unsupported protocol is rejected: ${name}`, async () => { await assert.rejects(chatCompletion({ ...options(), fetchImpl: async () => new Response(body, { headers: { 'content-type': type } }) }), isCode('UNSUPPORTED_RESPONSE')); });
test('Abort and timeout have separate fixed error codes, even if fetch resolves late', async () => {
  for (const timeout of [false, true]) {
    const controller = new AbortController(); let release!: (value: Response) => void; const late = new Promise<Response>(resolve => { release = resolve; });
    const pending = chatCompletion({ ...options(), signal: controller.signal, fetchImpl: () => late });
    controller.abort(timeout ? new DOMException('fixture-timeout', 'TimeoutError') : undefined);
    await assert.rejects(pending, isCode(timeout ? 'TIMEOUT' : 'CANCELLED')); release(sseCompletion('{}')); await delay(1);
  }
});
test('Usage is only provider-reported; partial unknown counts stay unknown after repair aggregation', () => {
  assert.equal(combineUsage([null, null]), null);
  assert.deepEqual(combineUsage([{ source: 'provider', inputTokens: 10, outputTokens: 20, totalTokens: 30, calls: 1 }, null]), { source: 'provider', inputTokens: null, outputTokens: null, totalTokens: null, calls: 2 });
});
