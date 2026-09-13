import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeetCodeOfficialJudge, OfficialJudgeError, officialProblemSlug, officialUrl, parseOfficialCheck, validCsrfCookie } from '../../src/source/official-judge.ts';

const csrf = 'a'.repeat(32);
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const snapshot = { slug: 'two-sum', sourceId: '987', language: 'python' as const, code: 'class Solution:\n    pass' };
const client = (fetchImpl: typeof fetch, csrfToken: () => Promise<string | undefined> = async () => csrf) => new LeetCodeOfficialJudge({ fetchImpl, csrfToken });

test('official transport verifies server authentication and submits internal question ID with Python3 mapping', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const judge = client(async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? jsonResponse({ data: { userStatus: { isSignedIn: true } } })
      : calls.length === 2 ? jsonResponse({ submission_id: '9223372036854775807' }) : jsonResponse({ state: 'SUCCESS', status_code: 10, status_msg: 'Accepted' });
  });
  assert.equal(await judge.authenticated(), true);
  const id = await judge.submit(snapshot);
  assert.equal(id, '9223372036854775807');
  assert.deepEqual(JSON.parse(calls[1].init!.body as string), { lang: 'python3', question_id: '987', typed_code: snapshot.code });
  assert.equal(calls[1].url, 'https://leetcode.cn/problems/two-sum/submit/');
  assert.equal(new Headers(calls[1].init!.headers).get('X-CSRFToken'), csrf);
  assert.equal(new Headers(calls[1].init!.headers).get('Referer'), 'https://leetcode.cn/problems/two-sum/');
  assert.equal(calls[1].init!.redirect, 'manual'); assert.equal(calls[1].init!.credentials, 'include');
  assert.equal((await judge.check(id)).result?.status, 'accepted');
  assert.equal(calls[2].url, `https://leetcode.cn/submissions/detail/${id}/check/`);
});

test('missing CSRF prevents the non-idempotent POST; cookies are restricted to exact root domain', async () => {
  let calls = 0;
  await assert.rejects(client(async () => { calls++; return jsonResponse({}); }, async () => undefined).submit(snapshot), /登录状态需要刷新/);
  assert.equal(calls, 0);
  const cookie = { name: 'csrftoken', value: csrf, domain: '.leetcode.cn', path: '/' };
  assert.equal(validCsrfCookie(cookie), true);
  for (const domain of ['evil.com', '.leetcode.cn.evil.com', 'contest.leetcode.cn', '']) assert.equal(validCsrfCookie({ ...cookie, domain }), false);
  assert.equal(validCsrfCookie({ ...cookie, expirationDate: 1 }), false);
  assert.equal(validCsrfCookie({ ...cookie, path: '/accounts/' }), false);
  for (const url of ['https://leetcode.cn.evil.com/problems/two-sum/', 'https://name@leetcode.cn/', 'http://leetcode.cn/', 'https://leetcode.cn:444/', '//evil.com/']) assert.throws(() => officialUrl(url));
  assert.equal(officialProblemSlug('https://leetcode.cn/problems/two-sum/'), 'two-sum');
  assert.equal(officialProblemSlug('https://leetcode.cn/problems/two-sum/description/'), 'two-sum');
  assert.throws(() => officialProblemSlug('https://leetcode.cn/problems/two-sum/../../accounts/'));
});

test('unauthenticated, rate limiting, verification pages and interrupted submits are distinct safe errors', async () => {
  assert.equal(await client(async () => jsonResponse({ data: { userStatus: { isSignedIn: false } } })).authenticated(), false);
  for (const [status, code] of [[401, 'authentication'], [403, 'verification'], [429, 'rate_limit']] as const) {
    await assert.rejects(client(async () => jsonResponse({}, status)).submit(snapshot), (error: OfficialJudgeError) => error.detail.code === code && !error.uncertain);
  }
  await assert.rejects(client(async () => new Response('<html>verify with secret-account</html>', { headers: { 'Content-Type': 'text/html' } })).submit(snapshot),
    (error: OfficialJudgeError) => error.detail.code === 'verification' && error.uncertain && !error.message.includes('secret-account'));
  await assert.rejects(client(async () => { throw new Error('cookie=private-token'); }).submit(snapshot),
    (error: OfficialJudgeError) => error.uncertain && !error.message.includes('private-token'));
  await assert.rejects(client(async () => jsonResponse({ submission_id: Number.MAX_SAFE_INTEGER + 1 })).submit(snapshot), (error: OfficialJudgeError) => error.uncertain);
});

test('official result completion is independent of verdict and preserves only reported counts and diagnostics', () => {
  assert.deepEqual(parseOfficialCheck({ state: 'STARTED' }), { pending: true });
  const failure = parseOfficialCheck({ state: 'SUCCESS', status_code: 11, status_msg: 'Wrong Answer', total_correct: '7', total_testcases: '42',
    last_testcase: '[1,2]', code_output: '3', expected_output: '2', status_runtime: 'N/A', status_memory: 'N/A' }).result!;
  assert.equal(failure.status, 'wrong_answer'); assert.equal(failure.passedCases, 7); assert.equal(failure.totalCases, 42);
  assert.equal(failure.input, '[1,2]'); assert.equal(failure.actualOutput, '3'); assert.equal(failure.expectedOutput, '2');
  const compile = parseOfficialCheck({ state: 'SUCCESS', status_code: 20, status_msg: 'Compile Error', full_compile_error: 'Line 2: invalid syntax' }).result!;
  assert.equal(compile.status, 'compile_error'); assert.equal(compile.compileError, 'Line 2: invalid syntax');
  assert.equal('totalCases' in compile, false); assert.equal('passedCases' in compile, false);
  assert.equal(parseOfficialCheck({ state: 'SUCCESS', status_code: 999, status_msg: 'New verdict' }).result?.status, 'unknown');
  assert.equal(parseOfficialCheck({ state: 'SUCCESS', status_code: 10, total_correct: '0', total_testcases: '0' }).result?.passedCases, 0);
  for (const value of ['-1', '1.5', '1e3', '', ' 1 ', '9007199254740992', -1, 2.4]) {
    assert.equal(parseOfficialCheck({ state: 'SUCCESS', status_code: 10, total_correct: value, total_testcases: value }).result?.totalCases, undefined);
  }
  assert.throws(() => parseOfficialCheck({ state: 'SUCCESS' }));
});
