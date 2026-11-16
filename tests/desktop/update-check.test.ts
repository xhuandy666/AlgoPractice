import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkForUpdate, compareVersions, RELEASES_API } from '../../src/desktop/update-check.ts';

const release = (fields: Record<string, unknown> = {}) => ({ tag_name: 'v0.92.0', name: '题炼 v0.92.0', html_url: 'https://github.com/xhuandy666/AlgoPractice/releases/tag/v0.92.0',
  published_at: '2026-11-20T08:00:00Z', draft: false, prerelease: false, ...fields });
const respond = (body: unknown, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
  assert.equal(String(url), RELEASES_API); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit', 'no session cookies');
  assert.deepEqual(Object.keys(init?.headers as object).sort(), ['accept', 'user-agent'], 'an anonymous request: no tokens, cookies or user data');
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}) as typeof fetch;

test('versions compare numerically and refuse anything else', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1); assert.equal(compareVersions('v1.2.3', '1.2.3'), 0); assert.equal(compareVersions('1.2.3', '1.3.0'), -1);
  for (const bad of ['1.2', '1.2.3-beta', 'latest', '']) assert.equal(compareVersions(bad, '1.0.0'), null, bad);
});

test('a newer release is reported with its page; the same version is not newer', async () => {
  assert.deepEqual(await checkForUpdate('0.91.0', respond(release())), { current: '0.91.0', latest: '0.92.0', newer: true,
    url: 'https://github.com/xhuandy666/AlgoPractice/releases/tag/v0.92.0', name: '题炼 v0.92.0', publishedAt: '2026-11-20T08:00:00Z' });
  assert.equal((await checkForUpdate('0.92.0', respond(release()))).newer, false);
  assert.equal((await checkForUpdate('0.93.0', respond(release()))).newer, false, 'a local build ahead of the release is not offered a downgrade');
});

test('only well-formed final releases on the project page are accepted', async () => {
  for (const fields of [{ html_url: 'https://evil.example/releases/tag/v9.9.9' }, { html_url: 'https://github.com/someone/AlgoPractice/releases/tag/v9.9.9' },
    { tag_name: 'nightly' }, { prerelease: true }, { draft: true }]) {
    await assert.rejects(checkForUpdate('0.91.0', respond(release(fields))), /格式无法识别/, JSON.stringify(fields));
  }
  await assert.rejects(checkForUpdate('0.91.0', respond('<html>')), /格式无法识别/);
  await assert.rejects(checkForUpdate('0.91.0', respond({}, 403)), /频率/);
  await assert.rejects(checkForUpdate('0.91.0', respond({}, 404)), /尚未找到/);
  await assert.rejects(checkForUpdate('0.91.0', respond({}, 500)), /HTTP 500/);
  await assert.rejects(checkForUpdate('0.91.0', (async () => { throw new TypeError('fetch failed'); }) as typeof fetch), /无法连接 GitHub/);
});
