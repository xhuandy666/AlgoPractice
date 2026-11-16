import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from 'electron';
import { test } from 'node:test';
import { createUpdateFetch } from '../../src/desktop/update-transport.ts';

class FakeResponse extends Readable {
  headers: Record<string, string | string[]> = { 'content-type': 'application/octet-stream' };
  statusCode = 200; statusMessage = 'OK'; rawHeaders: string[] = [];
  _read() {}
}
class FakeRequest extends EventEmitter {
  ended = false; aborts = 0; message?: FakeResponse;
  end() { this.ended = true; this.emit('finish'); this.emit('close'); return this; }
  abort() {
    this.aborts++; this.message?.destroy(); this.emit('abort');
    // Electron can emit errors after its Writable closes, including a deliberately cancelled redirect.
    this.emit('error', new Error('late cancellation error')); this.emit('close');
  }
  response(message = new FakeResponse()) { this.message = message; this.emit('response', message as unknown as IncomingMessage); return message; }
}
function fixture() {
  const requests: FakeRequest[] = [], options: ClientRequestConstructorOptions[] = [];
  const fetch = createUpdateFetch(input => { options.push(input); const request = new FakeRequest(); requests.push(request); return request as unknown as ClientRequest; });
  return { fetch, requests, options };
}
const url = 'https://github.com/xhuandy666/AlgoPractice/releases/download/v0.97.0/fixture.dmg';

test('GET options preserve explicit headers/cache and never use app credentials or referrers', async () => {
  const f = fixture(), pending = f.fetch(url, { headers: [['Accept', 'application/octet-stream'], ['X-Fixture', 'yes']], cache: 'no-store', credentials: 'include', redirect: 'manual' });
  assert.deepEqual(f.options[0], { url, method: 'GET', headers: { accept: 'application/octet-stream', 'x-fixture': 'yes' },
    credentials: 'omit', useSessionCookies: false, redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer', bypassCustomProtocolHandlers: true });
  assert.equal(f.requests[0].ended, true);
  const message = f.requests[0].response(); message.push(Buffer.from('installer bytes')); message.push(null);
  const response = await pending; assert.equal(await response.text(), 'installer bytes');
  assert.equal(f.requests[0].aborts, 0, 'an early request Writable close is not a truncated response');
});

test('manual redirects return their status and Location before synchronously aborting the original request', async () => {
  const f = fixture(), signal = new AbortController(), pending = f.fetch(url, { redirect: 'manual', signal: signal.signal });
  f.requests[0].emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/asset?signature=public-fixture', { location: ['https://release-assets.githubusercontent.com/asset?signature=public-fixture'], 'set-cookie': ['private-session=value'] });
  const response = await pending;
  assert.equal(response.status, 302); assert.equal(response.body, null);
  assert.equal(response.headers.get('location'), 'https://release-assets.githubusercontent.com/asset?signature=public-fixture');
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(f.requests[0].aborts, 1);
  assert.equal(f.requests.length, 1, 'the transport must not follow the CDN URL itself');
  assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  assert.deepEqual(f.requests[0].eventNames(), ['error'], 'only the stateless late-error guard survives');
  assert.doesNotThrow(() => f.requests[0].emit('error', new Error('late Chromium cancellation')));
});

test('redirect:error rejects and never follows, even though the underlying request uses manual redirect handling', async () => {
  const f = fixture(), pending = f.fetch(url, { redirect: 'error' });
  f.requests[0].emit('redirect', 307, 'GET', 'https://github.com/other', {});
  await assert.rejects(pending, /redirects are not allowed/); assert.equal(f.requests[0].aborts, 1);
});

test('unsupported methods, bodies, automatic redirects, URL credentials and credential headers are rejected before any request', async () => {
  const f = fixture();
  for (const init of [{ method: 'POST' }, { body: 'forbidden' }, { redirect: 'follow' as const },
    ...['Authorization', 'Proxy-Authorization', 'Cookie', 'cookie2', 'X-Api-Key', 'X-Github-Token'].map(name => ({ headers: { [name]: 'must-not-leak' } }))]) {
    await assert.rejects(f.fetch(url, init));
  }
  await assert.rejects(f.fetch('https://user:password@github.com/fixture', {}));
  assert.equal(f.requests.length, 0);
});

test('an already aborted signal never opens a request; abort while waiting for headers rejects and cleans up', async () => {
  const f = fixture(), before = new AbortController(); before.abort();
  await assert.rejects(f.fetch(url, { signal: before.signal }), { name: 'AbortError' }); assert.equal(f.requests.length, 0);
  const waiting = new AbortController(), pending = f.fetch(url, { signal: waiting.signal }); waiting.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(f.requests[0].aborts, 1);
  assert.equal(getEventListeners(waiting.signal, 'abort').length, 0);
});

test('AbortSignal still reaches an in-progress response body after headers have resolved', async () => {
  const f = fixture(), abort = new AbortController(), pending = f.fetch(url, { signal: abort.signal });
  const message = f.requests[0].response(), response = await pending, reader = response.body!.getReader();
  message.push(Buffer.from('first')); assert.equal(Buffer.from((await reader.read()).value!).toString(), 'first');
  const waiting = reader.read(); abort.abort();
  await assert.rejects(waiting, { name: 'AbortError' }); assert.equal(f.requests[0].aborts, 1);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.equal(message.listenerCount('data'), 0); assert.equal(message.listenerCount('end'), 0);
});

test('cancelling the Web body stops the actual request rather than just dropping the response reader', async () => {
  const f = fixture(), abort = new AbortController(), pending = f.fetch(url, { signal: abort.signal });
  const message = f.requests[0].response(), response = await pending;
  await response.body!.cancel('caller stopped');
  assert.equal(f.requests[0].aborts, 1); assert.equal(message.destroyed, true);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('request errors before headers reject; response errors and premature closes reject body reads', async () => {
  const f = fixture(), before = f.fetch(url, {});
  f.requests[0].emit('error', new Error('DNS failed')); await assert.rejects(before, /DNS failed/);
  const pending = f.fetch(url, {}), message = f.requests[1].response(), response = await pending;
  const reading = response.arrayBuffer(); message.destroy(new Error('socket failed'));
  await assert.rejects(reading, /socket failed/);
  const truncated = f.fetch(url, {}), incomplete = f.requests[2].response(), partial = await truncated;
  const body = partial.arrayBuffer(); incomplete.destroy();
  await assert.rejects(body, /closed before its body ended/);
  assert.equal(f.requests.every(request => request.aborts === 1), true);
});

test('a slow reader applies byte-based backpressure and resumes until the complete body is consumed', async () => {
  const f = fixture(), pending = f.fetch(url, {}), total = 32, chunk = Buffer.alloc(16 * 1024, 7);
  let produced = 0;
  class ProducingResponse extends FakeResponse {
    _read() { if (produced < total) { produced++; this.push(Buffer.from(chunk)); } else this.push(null); }
  }
  const message = new ProducingResponse(); f.requests[0].response(message);
  const response = await pending; await nextTurn();
  assert.ok(produced <= 8, `producer streamed ahead without backpressure: ${produced}`);
  assert.equal(message.isPaused(), true);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.byteLength, total * chunk.byteLength); assert.ok(bytes.every(byte => byte === 7));
  assert.equal(produced, total); assert.equal(f.requests[0].aborts, 0);
});

test('a producer that ignores backpressure cannot accumulate an unbounded Web stream queue', async () => {
  const f = fixture(), pending = f.fetch(url, {}), message = f.requests[0].response(), response = await pending;
  for (let i = 0; i < 20; i++) message.emit('data', Buffer.alloc(64 * 1024));
  await assert.rejects(response.arrayBuffer(), /bounded stream buffer/);
  assert.equal(f.requests[0].aborts, 1);
});

for (const statusCode of [204, 205, 304]) test(`HTTP ${statusCode} returns a legal null-body Response and stops the network stream`, async () => {
  const f = fixture(), pending = f.fetch(url, {}), message = new FakeResponse(); message.statusCode = statusCode;
  f.requests[0].response(message);
  const response = await pending; assert.equal(response.status, statusCode); assert.equal(response.body, null);
  assert.equal(f.requests[0].aborts, 1);
});
