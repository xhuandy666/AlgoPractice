/** Authored local HTTP/SSE fixtures only. No external service, real model, Keychain or personal data. Node >= 24. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AiService } from '../src/ai/index.ts';
import { AI_PROVIDER_PRESETS, createAiProviderPreset } from '../src/shared/ai.ts';
import { answer, context, input, MemoryRepository, mockVault } from './ai/helpers.ts';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.P5_AI_EVIDENCE_DIR ?? resolve(project, 'evidence/p5/ai-protocol'));
const report = { startedAt: new Date().toISOString(), kind: 'authored-local-http-protocol-fixtures', realModelTested: false,
  realCredentialsUsed: false, osCredentialStoreTested: false, externalRequests: 0, assertions: [], sourceHashes: {}, result: 'running' };
const services = [], requests = [];
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
let mode = 'valid', repairCount = 0, activeRequest = input();
function wire(profile, content) {
  const start = ': keep-alive\n\n' + event(chunk({ role: 'assistant', content: null, reasoning_content: 'PRIVATE-AUTHORED-THINKING' }));
  const body = event(chunk({ role: profile === 'qwen-cn' ? null : 'assistant', content }));
  const end = profile === 'qwen-cn'
    ? event(chunk({ role: null, content: '' }, 'stop')) + event({ choices: [], usage })
    : event({ ...chunk({}, 'stop'), usage });
  return start + body + end + 'data: [DONE]\n\n';
}
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) { raw += part; if (raw.length > 160000) throw new Error('fixture request too large'); }
    const body = JSON.parse(raw), profile = request.url.split('/')[1];
    assert.equal(request.headers.authorization, 'Bearer synthetic-unit-key-12345');
    assert.ok(!raw.includes('synthetic-unit-key-12345'));
    requests.push({ profile, body });
    if (mode === 'rate-limit') { response.writeHead(429, { 'Retry-After': '2' }); response.end('PRIVATE-AUTHORED-ERROR'); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (mode === 'slow') {
      response.write(event(chunk({ reasoning_content: 'PRIVATE-AUTHORED-LATE', content: null })));
      const timer = setTimeout(() => { if (!response.destroyed) response.end(wire(profile, JSON.stringify(answer(activeRequest)))); }, 180);
      response.once('close', () => clearTimeout(timer)); return;
    }
    const probe = body.messages[0].content.startsWith('Connection capability check');
    const content = probe ? '{"ok":true}' : mode === 'repair' && repairCount++ === 0 ? 'PRIVATE-AUTHORED-INVALID' : JSON.stringify(answer(activeRequest));
    response.write(wire(profile, content));
    // Intentionally keep the socket open: a valid [DONE] must terminate client reading itself.
  } catch { response.writeHead(500); response.end('fixture failed'); }
});
const check = (name, operation) => { operation(); report.assertions.push({ name, passed: true }); };
await mkdir(output, { recursive: true });
try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const localFetch = (url, options) => {
    if (new URL(String(url)).origin !== origin) { report.externalRequests++; throw new Error('External traffic prohibited by local fixture harness.'); }
    return fetch(url, options);
  };
  check('Creating presets performs no HTTP calls', () => assert.equal(requests.length, 0));
  for (const preset of AI_PROVIDER_PRESETS) {
    const repository = new MemoryRepository(), source = context(), events = [];
    const provider = { ...createAiProviderPreset(preset.id, `local-${preset.id}`), baseUrl: `${origin}/${preset.id}/v1`, timeoutMs: 3000 };
    const service = new AiService({ repository, vault: mockVault(), resolveContext: () => source, resolveProvider: () => provider,
      fetchImpl: localFetch, onEvent: event => events.push(event) });
    services.push(service);
    const probe = await service.testConnection();
    check(`${preset.id}: real loopback HTTP connection probe parses SSE and usage`, () => {
      assert.equal(probe.status, 'passed'); assert.equal(probe.streaming, true); assert.equal(probe.structuredOutput, true); assert.equal(probe.usage?.totalTokens, 30);
    });
    activeRequest = input(); const result = await service.request(activeRequest);
    check(`${preset.id}: validated adaptive response persists without reasoning`, () => {
      assert.equal(result.status, 'completed'); assert.equal(result.response.schemaVersion, 2); assert.equal(result.response.level, undefined); assert.equal(result.snapshot.question, '');
      assert.ok(!JSON.stringify([result, events]).includes('PRIVATE-AUTHORED'));
    });
    const beforeCache = requests.length, cached = await service.request({ ...activeRequest, requestId: `cache-${preset.id}` });
    check(`${preset.id}: cache reuses a validated answer without another HTTP request`, () => {
      assert.equal(cached.cachedFromRequestId, activeRequest.requestId); assert.equal(requests.length, beforeCache);
    });
    source.mode = 'strict'; await assert.rejects(service.request(input())); source.mode = 'practice';
    check(`${preset.id}: Active strict mode prevent HTTP traffic`, () => assert.equal(requests.length, beforeCache));
    const sent = requests.find(entry => entry.profile === preset.id).body;
    check(`${preset.id}: sends only the selected vendor's explicit options`, () => {
      if (preset.id === 'qwen-cn') { assert.equal(sent.enable_thinking, false); assert.equal(sent.thinking, undefined); }
      else { assert.deepEqual(sent.thinking, { type: 'disabled' }); assert.equal(sent.enable_thinking, undefined); }
      assert.deepEqual(sent.response_format, { type: 'json_object' }); assert.equal(sent.extra_body, undefined); assert.equal(sent.tools, undefined);
      assert.deepEqual(sent.stream_options, provider.includeUsage ? { include_usage: true } : undefined);
    });
  }
  const repository = new MemoryRepository(), events = [], source = context();
  const provider = { ...createAiProviderPreset('qwen-cn', 'failure-profile'), baseUrl: `${origin}/qwen-cn/v1`, timeoutMs: 3000 };
  const service = new AiService({ repository, vault: mockVault(), resolveContext: () => source, resolveProvider: () => provider, fetchImpl: localFetch, onEvent: event => events.push(event) });
  services.push(service);
  mode = 'repair'; activeRequest = input(); let before = requests.length;
  const repaired = await service.request(activeRequest);
  check('Invalid format gets exactly one repair with the same system/user role order', () => {
    assert.equal(repaired.status, 'completed'); assert.equal(requests.length - before, 2); assert.equal(repaired.usage.calls, 2);
    assert.deepEqual(requests.at(-1).body.messages.map(message => message.role), ['system', 'user']);
    assert.ok(requests.at(-1).body.messages[1].content.includes('One format repair only'));
    assert.ok(!JSON.stringify([...repository.records.values(), events]).includes('PRIVATE-AUTHORED-INVALID'));
  });
  mode = 'rate-limit'; activeRequest = { ...input(), question: '新的限流测试。' }; before = requests.length;
  const limited = await service.request(activeRequest);
  check('HTTP 429 is actionable and is not retried automatically', () => {
    assert.equal(limited.status, 'failed'); assert.equal(limited.error.code, 'RATE_LIMITED'); assert.equal(limited.error.retryAfterMs, 2000);
    assert.equal(requests.length - before, 1); assert.ok(!JSON.stringify(limited).includes('PRIVATE-AUTHORED-ERROR'));
  });
  mode = 'slow'; activeRequest = { ...input(), question: '新的取消测试。' }; before = requests.length;
  const pending = service.request(activeRequest);
  for (let tries = 0; tries < 100 && requests.length === before; tries++) await delay(5);
  assert.equal(requests.length, before + 1); service.cancel(activeRequest.requestId);
  const cancelled = await pending; await delay(220);
  check('Cancellation closes the local HTTP stream and late content never replaces terminal state', () => {
    assert.equal(cancelled.status, 'cancelled'); assert.equal(repository.getAIRequest(activeRequest.requestId).status, 'cancelled');
    assert.ok(!JSON.stringify([...repository.records.values(), events]).includes('PRIVATE-AUTHORED'));
  });
  check('No external endpoint was contacted', () => assert.equal(report.externalRequests, 0));
  for (const file of ['src/shared/ai.ts', 'src/ai/canonical.ts', 'src/ai/provider.ts', 'src/ai/service.ts']) {
    report.sourceHashes[file] = createHash('sha256').update(await readFile(resolve(project, file))).digest('hex');
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = String(error.message); process.exitCode = 1;
} finally {
  await Promise.all(services.map(service => service.stopAll()));
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'protocol-development.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ result: report.result, assertions: report.assertions.length, report: resolve(output, 'protocol-development.json'), ...(report.failure ? { failure: report.failure } : {}) }) + '\n');
}
