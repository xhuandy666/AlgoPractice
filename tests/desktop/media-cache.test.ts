import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, type TestContext } from 'node:test';
import { cacheProblemMedia } from '../../src/desktop/media-cache.ts';
import type { ProblemContent } from '../../src/shared/library.ts';

// All transport responses in this suite are injected fixtures. These tests do
// not make network requests or establish live LeetCode/CDN availability.
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const hash = createHash('sha256').update(gif).digest('hex');
const local = `algopractice://app/media/${hash}`;
const origin = 'https://assets.leetcode.com/uploads/fixture.gif';
const directories: string[] = [];
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'algopractice-media-test-')); directories.push(value); return value; };
const content = (description: string): ProblemContent => ({ id: 'file:media-fixture', title: 'Fixture', difficulty: '基础', tags: [],
  description, descriptionFormat: 'html', constraints: [], mode: 'function', cases: [], starter: {}, source: 'file' });
const response = () => new Response(gif, { headers: { 'Content-Type': 'image/gif' } });
function transport(t: TestContext, callback: typeof fetch = async () => response()) {
  return t.mock.method(globalThis, 'fetch', callback);
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('replaces only the actual src value when alt/title contain the same URL', async t => {
  const fetch = transport(t); const path = directory();
  const input = `<p>Before</p><img alt="${origin}" title="same ${origin}" src="${origin}"><p>After</p>`;
  const result = await cacheProblemMedia(content(input), path);
  assert.equal(result.description, `<p>Before</p><img alt="${origin}" title="same ${origin}" src="${local}"><p>After</p>`);
  assert.deepEqual(result.media, { complete: true, missingUrls: [] });
  assert.match(local, /^algopractice:\/\/app\/media\/[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(join(path, hash)), gif); assert.equal(fetch.mock.callCount(), 1);
  const [requested, init] = fetch.mock.calls[0].arguments;
  assert.equal(String(requested), origin); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
});

test('does not treat data-src or src text inside quoted attributes as src attributes', async t => {
  const fetch = transport(t);
  const input = `<img data-src="${origin}" alt='src="${origin}"> fake'><img src='${origin}' data-src="https://assets.leetcode.com/ignored.gif">`;
  const result = await cacheProblemMedia(content(input), directory());
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.description, `<img data-src="${origin}" alt='src="${origin}"> fake'><img src='${local}' data-src="https://assets.leetcode.com/ignored.gif">`);
});

test('ignores img-looking strings in comments, raw-text elements and another tag attribute', async t => {
  const fetch = transport(t);
  const input = `<!-- <img src="${origin}"> --><script>"<img src='${origin}'>"</script><textarea><img src="${origin}"></textarea><div title='<img src="${origin}">'>Text</div><img SRC = ${origin} >`;
  const result = await cacheProblemMedia(content(input), directory());
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.description, input.replace(`SRC = ${origin}`, `SRC = ${local}`));
});

test('uses first duplicate src and preserves later duplicate attributes as original data', async t => {
  const fetch = transport(t);
  const result = await cacheProblemMedia(content(`<img src="${origin}" src="https://assets.leetcode.com/ignored.gif">`), directory());
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(result.description, `<img src="${local}" src="https://assets.leetcode.com/ignored.gif">`);
});

test('decodes common attribute references and downloads repeated URLs only once', async t => {
  const fetch = transport(t); const url = `${origin}?a=1&b=2`;
  const result = await cacheProblemMedia(content(`<img src="${origin}?a=1&amp;b=2"><img src='${origin}?a=1&#38;b=2'>`), directory());
  assert.equal(fetch.mock.callCount(), 1); assert.equal(String(fetch.mock.calls[0].arguments[0]), url);
  assert.equal(result.description, `<img src="${local}"><img src='${local}'>`);
});

test('counts distinct attempts, reuses earlier successes at the limit and skips excess URLs', async t => {
  const fetch = transport(t);
  const inputs = Array.from({ length: 21 }, (_, index) => `https://assets.leetcode.com/${index}.gif`);
  const result = await cacheProblemMedia(content(inputs.map(url => `<img src="${url}">`).join('') + `<img src="${inputs[0]}">`), directory());
  assert.equal(fetch.mock.callCount(), 20); assert.equal(result.media?.complete, false);
  assert.deepEqual(result.media?.missingUrls, [inputs[20]]);
  assert.equal((result.description.match(/algopractice:\/\/app\/media\//g) || []).length, 21);
});

test('rejects bad signatures, clears src for placeholders, and does not retry the same failed URL', async t => {
  const fetch = transport(t, async () => new Response('<svg onload="bad()"/>', { headers: { 'Content-Type': 'image/png' } }));
  const path = directory(); const result = await cacheProblemMedia(content(`<img src="${origin}" alt="image"><img src=${origin} alt=second>`), path);
  assert.equal(fetch.mock.callCount(), 1); assert.deepEqual(readdirSync(path), []);
  assert.equal(result.description, '<img src="" alt="image"><img src="" alt=second>');
  assert.deepEqual(result.media, { complete: false, missingUrls: [origin] });
});

test('rejects disallowed schemes, origins, credentials and ports without requesting them', async t => {
  const fetch = transport(t);
  const urls = ['https://example.com/a.png', 'http://assets.leetcode.com/a.png', 'https://assets.leetcode.com.evil.test/a.png', 'https://user:pass@assets.leetcode.com/a.png', 'https://assets.leetcode.com:444/a.png', 'file:///tmp/a.png', 'data:image/png;base64,AAAA'];
  const result = await cacheProblemMedia(content(urls.map(url => `<img src="${url}">`).join('')), directory());
  assert.equal(fetch.mock.callCount(), 0); assert.equal(result.media?.complete, false); assert.equal(result.media?.missingUrls.length, urls.length);
});

test('caches only the exact additional CDN origins observed in CN public statements', async t => {
  const request = transport(t);
  const hosts = ['assets.leetcode.cn', 'pic.leetcode.cn', 'aliyun-lc-upload.oss-cn-hangzhou.aliyuncs.com'];
  const good = await cacheProblemMedia(content(hosts.map(host => `<img src="https://${host}/fixture.gif">`).join('')), directory());
  assert.equal(good.media?.complete, true); assert.equal(request.mock.callCount(), 3);
  const rejected = await cacheProblemMedia(content(hosts.map(host => `<img src="https://${host}.evil.test/fixture.gif">`).join('')), directory());
  assert.equal(rejected.media?.missingUrls.length, 3); assert.equal(request.mock.callCount(), 3);
});

test('bounds Content-Length and streamed bodies, cancelling each rejected body', async t => {
  let cancelled = 0; let count = 0;
  transport(t, async () => {
    count++;
    const body = new ReadableStream<Uint8Array>({ start(controller) { if (count === 2) controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel() { cancelled++; } });
    return new Response(body, { headers: { 'Content-Type': 'image/png', ...(count === 1 ? { 'Content-Length': String(8 * 1024 * 1024 + 1) } : {}) } });
  });
  const path = directory(); const result = await cacheProblemMedia(content(`<img src="${origin}"><img src="${origin}?second=1">`), path);
  assert.equal(cancelled, 2); assert.equal(result.media?.missingUrls.length, 2); assert.deepEqual(readdirSync(path), []);
});

test('rejects redirects and non-image responses and cancels rejected response bodies', async t => {
  let cancelled = 0; let call = 0;
  transport(t, async () => {
    const redirect = call++ === 0;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: redirect ? 302 : 200,
      headers: redirect ? { 'Content-Type': 'image/png', Location: 'https://example.com/a.png' } : { 'Content-Type': 'text/html' } });
  });
  const result = await cacheProblemMedia(content(`<img src="${origin}"><img src="${origin}?html=1">`), directory());
  assert.equal(cancelled, 2); assert.equal(result.media?.complete, false);
});

test('cancellation before fetch and during a stalled body leaves no partial cache files', async t => {
  const before = new AbortController(); before.abort(); const path = directory(); let cancelled = 0;
  const fetch = transport(t, async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'Content-Type': 'image/png' } }));
  await assert.rejects(cacheProblemMedia(content(`<img src="${origin}">`), path, before.signal), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(fetch.mock.callCount(), 0);
  const during = new AbortController(); const work = cacheProblemMedia(content(`<img src="${origin}">`), path, during.signal);
  await new Promise(resolve => setImmediate(resolve)); during.abort();
  await assert.rejects(work, error => error instanceof Error && error.name === 'AbortError');
  assert.equal(cancelled, 1); assert.deepEqual(readdirSync(path), []);
});

test('existing local media is validated without network and missing/corrupt files are marked incomplete', async t => {
  const fetch = transport(t); const path = directory(); writeFileSync(join(path, hash), gif);
  const good = await cacheProblemMedia(content(`<img src="${local}">`), path);
  assert.deepEqual(good.media, { complete: true, missingUrls: [] });
  writeFileSync(join(path, hash), 'corrupt');
  const bad = await cacheProblemMedia(content(`<img src="${local}"><img src="algopractice://app/media/${'0'.repeat(64)}">`), path);
  assert.equal(fetch.mock.callCount(), 0); assert.equal(bad.media?.missingUrls.length, 2);
  assert.equal(bad.description, '<img src=""><img src="">');
});
