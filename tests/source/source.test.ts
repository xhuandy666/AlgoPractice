import test from 'node:test';
import assert from 'node:assert/strict';
import { LeetCodeCnSourceAdapter, SourceError, identifySources, parseSource } from '../../src/source/index.ts';

const question = (slug = 'fixture-problem') => ({ id: '90001', titleSlug: slug, questionFrontendId: '90001', title: 'Original fixture', translatedTitle: '自建样本', paidOnly: false, difficulty: 'EASY' });
const plan = (questions = [question()]) => ({ slug: 'fixture-plan', name: '自建计划', premiumOnly: false, planSubGroups: [{ slug: 'group-1', name: '自建章节', questionNum: questions.length, questions }] });
const html = (data: unknown) => `<html><script type="application/json" id="__NEXT_DATA__">${JSON.stringify({ buildId: 'fixture', props: { pageProps: { dehydratedState: { queries: [{ state: { data } }] } } } })}</script></html>`;
const response = (data: unknown) => new Response(html(data), { headers: { 'content-type': 'text/html; charset=utf-8' } });
const adapter = (data: unknown, options = {}) => new LeetCodeCnSourceAdapter({ fetchImpl: (async () => response(data)) as typeof fetch, ...options });
const assertCode = async (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof SourceError && error.code === code);
const planUrl = 'https://leetcode.cn/studyplan/fixture-plan/';

test('canonicalizes source links without tracking, fragments, or problem view suffixes', () => {
  const ref = parseSource(' https://leetcode.cn/problems/two-sum/description/?envId=hot100#x ');
  assert.equal(ref.canonicalUrl, 'https://leetcode.cn/problems/two-sum/');
  assert.equal(ref.sourceKey, 'leetcode-cn:problem:two-sum');
  assert.equal(parseSource('https://leetcode.cn/problem-list/EuubXhZG/').slug, 'EuubXhZG');
});

test('rejects non-CN hosts, credentials, unsupported paths and protocols', () => {
  for (const input of ['http://leetcode.cn/problems/two-sum/', 'https://leetcode.com/problems/two-sum/', 'https://leetcode.cn.evil.test/problems/two-sum/', 'https://user:secret@leetcode.cn/problems/two-sum/', 'https://leetcode.cn:8443/problems/two-sum/', 'https://leetcode.cn/discuss/post/123/', 'file:///tmp/test']) {
    assert.throws(() => parseSource(input), SourceError);
  }
});

test('identifies duplicate links, retains case-sensitive list slugs, reports invalid input by index', () => {
  const result = identifySources([planUrl, `${planUrl}?page=1`, 'https://leetcode.cn/problem-list/aBc/', 'https://leetcode.cn/problem-list/abc/', 'garbage']);
  assert.equal(result.sources.length, 3);
  assert.deepEqual(result.duplicates, [{ inputIndex: 1, firstInputIndex: 0, sourceKey: 'leetcode-cn:study-plan:fixture-plan' }]);
  assert.equal(result.errors[0].inputIndex, 4);
});

test('uses one bounded public GET with no auth, redirects, or imported query parameters', async () => {
  let calls = 0;
  const source = new LeetCodeCnSourceAdapter({ fetchImpl: (async (url, init) => {
    calls++;
    assert.equal(url, planUrl);
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.method, 'GET');
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.has('authorization'), false);
    return response({ studyPlanV2Detail: plan() });
  }) as typeof fetch });
  const result = await source.fetchPlan(`${planUrl}?token=not-transmitted`);
  assert.equal(calls, 1);
  assert.equal(result.itemCount, 1);
  assert.equal(result.observation.authentication, 'none');
});

test('preserves section order and diagnoses duplicate membership rather than silently dropping it', async () => {
  const fixture = plan([question(), question()]);
  const result = await adapter({ studyPlanV2Detail: fixture }).fetchPlan(planUrl);
  assert.equal(result.itemCount, 2);
  assert.equal(result.uniqueItemCount, 1);
  assert.deepEqual(result.duplicateSourceKeys, ['leetcode-cn:problem:fixture-problem']);
  assert.equal(result.sections[0].name, '自建章节');
});

test('rejects truncated/paged section members instead of reporting a complete plan', async () => {
  const fixture = plan();
  fixture.planSubGroups[0].questionNum = 20;
  await assertCode(adapter({ studyPlanV2Detail: fixture }).fetchPlan(planUrl), 'INCOMPLETE_PLAN');
});

test('enforces item cap, and validates the cap itself', async () => {
  await assertCode(adapter({ studyPlanV2Detail: plan([question('one'), question('two')]) }, { maxPlanItems: 1 }).fetchPlan(planUrl), 'PLAN_TOO_LARGE');
  assert.throws(() => new LeetCodeCnSourceAdapter({ maxPlanItems: 1001 }), RangeError);
});

test('distinguishes missing schema from null source and rejects wrong returned plan', async () => {
  await assertCode(adapter({}).fetchPlan(planUrl), 'SCHEMA_CHANGED');
  await assertCode(adapter({ studyPlanV2Detail: null }).fetchPlan(planUrl), 'NOT_FOUND_OR_RESTRICTED');
  await assertCode(adapter({ studyPlanV2Detail: { ...plan(), slug: 'different' } }).fetchPlan(planUrl), 'SCHEMA_CHANGED');
});

test('public collection header alone does not become an empty or successful import', async () => {
  const source = new LeetCodeCnSourceAdapter({ fetchImpl: (async () => new Response(JSON.stringify({ data: { favoriteDetailV2: { slug: 'public-fixture', name: 'Public fixture', isPublicFavorite: true, questionNumber: 99 } } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
  await assertCode(source.fetchPlan('https://leetcode.cn/problem-list/public-fixture/'), 'SCHEMA_CHANGED');
});

test('private collection and unavailable collection remain distinct from public success', async () => {
  const jsonSource = (favoriteDetailV2: unknown) => new LeetCodeCnSourceAdapter({ fetchImpl: (async () => new Response(JSON.stringify({ data: { favoriteDetailV2 } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
  await assertCode(jsonSource({ slug: 'private-fixture', isPublicFavorite: false }).fetchPlan('https://leetcode.cn/problem-list/private-fixture/'), 'AUTH_REQUIRED');
  await assertCode(jsonSource(null).fetchPlan('https://leetcode.cn/problem-list/missing-fixture/'), 'NOT_FOUND_OR_RESTRICTED');
});

for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'ACCESS_DENIED'], [404, 'NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'HTTP_ERROR'], [302, 'REDIRECT_BLOCKED']] as const) {
  test(`HTTP ${status} maps to ${code} and never to a network error`, async () => {
    const source = new LeetCodeCnSourceAdapter({ fetchImpl: (async () => new Response('', { status })) as typeof fetch });
    await assertCode(source.fetchPlan(planUrl), code);
  });
}

test('DNS failures remain transport errors and omit sensitive raw exception text', async () => {
  const source = new LeetCodeCnSourceAdapter({ fetchImpl: (async () => { throw new TypeError('secret raw message', { cause: { code: 'ENOTFOUND' } }); }) as typeof fetch });
  await assert.rejects(source.fetchPlan(planUrl), error => {
    assert.ok(error instanceof SourceError);
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.details.transportCode, 'ENOTFOUND');
    assert.equal(JSON.stringify(error.toJSON()).includes('secret'), false);
    return true;
  });
});

test('timeout is separate from site rejection', async () => {
  const source = new LeetCodeCnSourceAdapter({ fetchImpl: (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as typeof fetch });
  await assertCode(source.fetchPlan(planUrl), 'TIMEOUT');
});

test('rejects oversized response before retaining a full body', async () => {
  const source = new LeetCodeCnSourceAdapter({ maxResponseBytes: 10, fetchImpl: (async () => new Response('1234567890123', { headers: { 'content-type': 'text/html' } })) as typeof fetch });
  await assertCode(source.fetchPlan(planUrl), 'RESPONSE_TOO_LARGE');
});

test('rejects non-HTML, access challenge, and broken embedded JSON separately', async () => {
  for (const [body, contentType, code] of [['{}', 'application/json', 'INVALID_CONTENT'], ['<title>Just a moment</title>', 'text/html', 'ACCESS_CHALLENGE'], ['<script id="__NEXT_DATA__">not json</script>', 'text/html', 'SCHEMA_CHANGED']]) {
    const source = new LeetCodeCnSourceAdapter({ fetchImpl: (async () => new Response(body, { headers: { 'content-type': contentType } })) as typeof fetch });
    await assertCode(source.fetchPlan(planUrl), code);
  }
});

test('problem probe retains field evidence/signature/template digests, never copyrighted bodies', async () => {
  const fixture = { ...question(), content: 'DO_NOT_RETAIN_BODY', translatedContent: 'DO_NOT_RETAIN_TRANSLATION', exampleTestcases: 'DO_NOT_RETAIN_SAMPLES',
    metaData: JSON.stringify({ name: 'solve', params: [{ name: 'values', type: 'integer[]' }], return: { type: 'integer' } }),
    codeSnippets: [{ langSlug: 'python3', code: 'DO_NOT_RETAIN_PYTHON' }, { langSlug: 'java', code: 'DO_NOT_RETAIN_JAVA' }] };
  const result = await adapter({ question: fixture }).fetchProblem('https://leetcode.cn/problems/fixture-problem/');
  assert.deepEqual(result.fields, { statement: true, translatedStatement: true, functionMetadata: true, sampleCases: true });
  assert.deepEqual(result.functionSignature, { name: 'solve', parameterTypes: ['integer[]'], returnType: 'integer' });
  assert.deepEqual(result.templates.map(x => x.language), ['python3', 'java']);
  assert.equal(JSON.stringify(result).includes('DO_NOT_RETAIN'), false);
});

test('revalidates supplied reference URL and rejects wrong method kinds before fetching', async () => {
  const source = adapter({});
  await assertCode(source.fetchPlan('https://leetcode.cn/problems/two-sum/'), 'WRONG_SOURCE_KIND');
  await assertCode(source.fetchProblem(planUrl), 'WRONG_SOURCE_KIND');
  await assertCode(source.fetchPlan({ ...parseSource(planUrl), canonicalUrl: 'https://evil.test/studyplan/fixture-plan/' }), 'UNSUPPORTED_SOURCE');
});
