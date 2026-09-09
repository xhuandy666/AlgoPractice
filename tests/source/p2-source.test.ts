import test from 'node:test';
import assert from 'node:assert/strict';
import { LeetCodeCnSourceAdapter, SourceError, parseImportInput, previewImport } from '../../src/source/index.ts';
import { parseCSV } from '../../src/source/imports.ts';
import { mapSourceType } from '../../src/source/problem-content.ts';
import { parseLosslessJSON } from '../../src/source/json.ts';

const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
const asHTML = (question: unknown) => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { dehydratedState: { queries: [{ state: { data: { question } } }] } } } })}</script>`, { headers: { 'content-type': 'text/html' } });
const q = (id: number) => ({ id, titleSlug: `original-${id}`, questionFrontendId: String(id), title: `Original ${id}`, translatedTitle: null, difficulty: 'EASY', paidOnly: false });
const listUrl = 'https://leetcode.cn/problem-list/fixture-list/';
const assertCode = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof SourceError && error.code === code);
function favorite(options: { private?: boolean; mutate?: boolean; repeat?: boolean; endEarly?: boolean; abort?: AbortController } = {}) {
  let headers = 0; const offsets: number[] = [];
  const fetchImpl = (async (url, init) => {
    assert.equal(url, 'https://leetcode.cn/graphql/'); assert.equal(init?.redirect, 'manual');
    const body = JSON.parse(String(init?.body));
    if (body.query.includes('favoriteDetailV2')) { headers++; return json({ favoriteDetailV2: { name: 'Original list', slug: 'fixture-list', questionNumber: 3, isPublicFavorite: !options.private, lastModified: options.mutate && headers === 2 ? 'v2' : 'v1' } }); }
    const skip = body.variables.skip; offsets.push(skip);
    if (options.abort) options.abort.abort();
    return json({ favoriteQuestionList: { questions: options.repeat ? [q(1), q(2)] : [q(1), q(2), q(3)].slice(skip, skip + body.variables.limit), totalLength: 3, hasMore: options.endEarly ? false : skip === 0 } });
  }) as typeof fetch;
  return { fetchImpl, offsets, get headers() { return headers; } };
}
function problem(fields: Record<string, unknown> = {}) {
  return { ...q(1), titleSlug: 'valid-parentheses', metaData: JSON.stringify({ name: 'isValid', params: [{ name: 's', type: 'string' }], return: { type: 'boolean' } }),
    content: '<p><strong>Example 1:</strong></p><div><strong>Input:</strong><code>s = "[]"</code></div><p><strong>Output:</strong>true</p><p><strong>Example 2:</strong></p><p><strong>Input:</strong>s = "([)]"</p><p><strong>Output:</strong>false</p><p><strong>Constraints:</strong></p><ul><li>Original fixture constraint</li></ul>',
    translatedContent: '<p>自建说明，不来自平台题面。</p>', jsonExampleTestcases: JSON.stringify(['"[]"', '"([)]"']),
    codeSnippets: [{ langSlug: 'python3', code: 'class Solution:\n    def isValid(self, s: str) -> bool:\n        return False' }, { langSlug: 'java', code: 'class Solution { public boolean isValid(String s) { return false; } }' }], ...fields };
}
const problemAdapter = (fields: Record<string, unknown> = {}) => new LeetCodeCnSourceAdapter({ fetchImpl: (async () => asHTML(problem(fields))) as typeof fetch });

test('favorite pages preserve order, numeric IDs, declared total and final source revision', async () => {
  const mock = favorite(); const result = await new LeetCodeCnSourceAdapter({ fetchImpl: mock.fetchImpl, pageSize: 2 }).fetchPlan(listUrl);
  assert.deepEqual(mock.offsets, [0, 2]); assert.equal(mock.headers, 2);
  assert.deepEqual(result.sections[0].questions.map(q => q.sourceId), ['1', '2', '3']);
  assert.equal(result.completeness, 'matches-declared-total-and-pagination'); assert.equal(result.observations?.length, 4);
});

test('session-injected fetch may access a permitted private list without reading secrets', async () => {
  const mock = favorite({ private: true });
  const fetchImpl = (async (url, init) => { assert.equal(init?.credentials, 'include'); assert.equal(new Headers(init?.headers).has('cookie'), false); return mock.fetchImpl(url, init); }) as typeof fetch;
  const result = await new LeetCodeCnSourceAdapter({ fetchImpl, sessionMode: 'user-session', pageSize: 2 }).fetchPlan(listUrl);
  assert.equal(result.visibility, 'private'); assert.equal(result.observation.authentication, 'session-transport');
});

test('repeated pages, premature completion and changing source revisions never produce success', async () => {
  await assertCode(new LeetCodeCnSourceAdapter({ fetchImpl: favorite({ repeat: true }).fetchImpl, pageSize: 2 }).fetchPlan(listUrl), 'INCOMPLETE_PLAN');
  await assertCode(new LeetCodeCnSourceAdapter({ fetchImpl: favorite({ endEarly: true }).fetchImpl, pageSize: 2 }).fetchPlan(listUrl), 'INCOMPLETE_PLAN');
  await assertCode(new LeetCodeCnSourceAdapter({ fetchImpl: favorite({ mutate: true }).fetchImpl, pageSize: 2 }).fetchPlan(listUrl), 'SOURCE_CHANGED');
});

test('maximum page count and changed total stop bounded pagination', async () => {
  await assertCode(new LeetCodeCnSourceAdapter({ fetchImpl: favorite().fetchImpl, pageSize: 2, maxPages: 1 }).fetchPlan(listUrl), 'INCOMPLETE_PLAN');
  const mock = favorite();
  const fetchImpl = (async (url, init) => { const response = await mock.fetchImpl(url, init); const body = await response.json(); if (body.data.favoriteQuestionList) body.data.favoriteQuestionList.totalLength = 4; return json(body.data); }) as typeof fetch;
  await assertCode(new LeetCodeCnSourceAdapter({ fetchImpl, pageSize: 2 }).fetchPlan(listUrl), 'SOURCE_CHANGED');
});

test('cancellation before a request and between pages is distinct from timeout', async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  const source = new LeetCodeCnSourceAdapter({ fetchImpl: (async () => { calls++; return json({}); }) as typeof fetch });
  await assertCode(source.fetchPlan(listUrl, { signal: before.signal }), 'CANCELLED'); assert.equal(calls, 0);
  const during = new AbortController(); const mock = favorite({ abort: during });
  await assertCode(new LeetCodeCnSourceAdapter({ fetchImpl: mock.fetchImpl }).fetchPlan(listUrl, { signal: during.signal }), 'CANCELLED'); assert.equal(mock.offsets.length, 1);
});

test('rate limit preserves Retry-After and GraphQL auth failures discard partial data', async () => {
  const limited = new LeetCodeCnSourceAdapter({ fetchImpl: (async () => new Response('', { status: 429, headers: { 'retry-after': '12' } })) as typeof fetch });
  await assert.rejects(limited.fetchPlan(listUrl), error => { assert.ok(error instanceof SourceError); assert.equal(error.code, 'RATE_LIMITED'); assert.equal(error.details.retryAfterMs, 12000); return true; });
  const auth = new LeetCodeCnSourceAdapter({ fetchImpl: (async () => new Response(JSON.stringify({ data: { favoriteDetailV2: {} }, errors: [{ message: 'private text not echoed', extensions: { code: 'UNAUTHENTICATED' } }] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
  await assertCode(auth.fetchPlan(listUrl), 'AUTH_REQUIRED');
});

test('same-origin login redirect is auth-required and external redirects never get followed', async () => {
  for (const [location, code] of [['https://leetcode.cn/accounts/login/?next=private', 'AUTH_REQUIRED'], ['https://other.example/login', 'REDIRECT_BLOCKED']]) {
    let calls = 0; const source = new LeetCodeCnSourceAdapter({ fetchImpl: (async () => { calls++; return new Response('', { status: 302, headers: { location } }); }) as typeof fetch });
    await assertCode(source.fetchPlan(listUrl), code); assert.equal(calls, 1);
  }
});

test('actual content API retains description/snippets and pairs HTML outputs with exact sample inputs', async () => {
  const result = await problemAdapter().fetchProblemContent('https://leetcode.cn/problems/valid-parentheses/');
  assert.equal(result.capability, 'sample-verified'); assert.deepEqual(result.content.cases.map(c => c.expected), [true, false]);
  assert.equal(result.content.starter.python?.includes('def isValid'), true); assert.match(result.content.description, /自建说明/);
  assert.equal(result.content.id, 'leetcode-cn:problem:valid-parentheses');
});

test('unreviewed multi-answer semantics execute without expected answers, never fake AC', async () => {
  const result = await problemAdapter({ titleSlug: 'unreviewed-problem' }).fetchProblemContent('https://leetcode.cn/problems/unreviewed-problem/');
  assert.equal(result.capability, 'execution-only'); assert.equal(result.content.cases.some(c => Object.hasOwn(c, 'expected')), false);
});

test('wrong source signature, mismatched sample inputs or missing output degrade conservatively', async () => {
  const mismatch = await problemAdapter({ jsonExampleTestcases: JSON.stringify(['"not-in-statement"']) }).fetchProblemContent('https://leetcode.cn/problems/valid-parentheses/');
  assert.equal(mismatch.capability, 'execution-only'); assert.equal(mismatch.content.cases[0].expected, undefined);
  const unsupported = await problemAdapter({ metaData: JSON.stringify({ name: 'isValid', params: [{ name: 's', type: 'character[]' }], return: { type: 'boolean' } }) }).fetchProblemContent('https://leetcode.cn/problems/valid-parentheses/');
  assert.equal(unsupported.capability, 'statement-only'); assert.equal(unsupported.content.adapter, undefined);
  const noStatement = await problemAdapter({ content: null, translatedContent: null, paidOnly: true }).fetchProblemContent('https://leetcode.cn/problems/valid-parentheses/');
  assert.equal(noStatement.capability, 'link-only');
});

test('two-sum profile handles unordered valid indices using the existing multiset comparator', async () => {
  const source = problemAdapter({ titleSlug: 'two-sum', metaData: JSON.stringify({ name: 'twoSum', params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }], return: { type: 'integer[]' } }),
    jsonExampleTestcases: JSON.stringify(['[4,9]\n13']), content: '<pre><strong>Input:</strong> nums = [4,9], target = 13\n<strong>Output:</strong> [0,1]\n</pre>' });
  const result = await source.fetchProblemContent('https://leetcode.cn/problems/two-sum/');
  assert.equal(result.capability, 'sample-verified'); assert.equal(result.content.adapter?.compare?.kind, 'multiset');
});

test('source longs retain precision and unsupported metadata types are not coerced', async () => {
  assert.equal(mapSourceType('long'), 'int64'); assert.equal(mapSourceType('character[]'), null); assert.equal(mapSourceType('void'), null);
  assert.deepEqual(parseLosslessJSON('[9223372036854775807,"12345678901234567890"]'), ['9223372036854775807', '12345678901234567890']);
  const source = problemAdapter({ titleSlug: 'long-example', metaData: JSON.stringify({ name: 'solve', params: [{ name: 'x', type: 'long' }], return: { type: 'long' } }), jsonExampleTestcases: JSON.stringify(['9223372036854775807']) });
  const result = await source.fetchProblemContent('https://leetcode.cn/problems/long-example/'); assert.deepEqual(result.content.cases[0].args, ['9223372036854775807']);
});

test('CSV handles escaped quotes, commas, BOM, CRLF and quoted multiline content', () => {
  assert.deepEqual(parseCSV('\ufeffurl,title\r\nhttps://leetcode.cn/problems/two-sum/,"A, ""quoted""\nname"\r\n'), [['url', 'title'], ['https://leetcode.cn/problems/two-sum/', 'A, "quoted"\nname']]);
  assert.throws(() => parseCSV('url,title\n"unterminated'), SourceError);
  assert.throws(() => parseCSV('url,title\n"a"junk,b'), SourceError);
});

test('CSV preview preserves metadata and duplicates without fetching individual problem bodies', async () => {
  let calls = 0; const source = new LeetCodeCnSourceAdapter({ fetchImpl: (async () => { calls++; return json({}); }) as typeof fetch });
  const result = await previewImport({ kind: 'csv', text: 'url,title,tags,chapter\nhttps://leetcode.cn/problems/two-sum/,自定标题,"数组,哈希",第一章\nhttps://leetcode.cn/problems/two-sum/?a=1,重复,数组,第二章' }, { adapter: source });
  assert.equal(result.complete, true); assert.equal(result.items.length, 1); assert.equal(result.duplicates.length, 1); assert.equal(calls, 0); assert.equal(result.source, 'file');
});

test('invalid CSV row width/header/source is reported and never silently importable', async () => {
  assert.throws(() => parseImportInput({ kind: 'csv', text: 'url,url\na,b' }), SourceError);
  const result = await previewImport({ kind: 'csv', text: 'url,title\nhttps://evil.example/a,Bad\nhttps://leetcode.cn/problems/two-sum/,Good,extra' });
  assert.equal(result.complete, false); assert.equal(result.errors.length, 2);
});

test('JSON standalone content validates adapter, preserves int64 strings and explicit ACM compare', async () => {
  const text = '{"title":"Local pack","problems":[{"id":"long-local","title":"Original long task","description":"Own content","mode":"function","adapter":{"method":"solve","params":["int64"],"returns":"int64"},"cases":[{"args":[9223372036854775807],"expected":9223372036854775807}],"starter":{"java":"class Solution {}"}},{"id":"acm","title":"Original ACM task","description":"Own stdin task","mode":"acm","acmCompare":"exact","cases":[{"stdin":"a\\n","expected":"a\\n"}],"starter":{"python":"print(input())"}}]}';
  const result = await previewImport({ kind: 'json', text }); assert.equal(result.complete, true); assert.equal(result.listTitle, 'Local pack');
  assert.equal(result.items[0].content?.cases[0].expected, '9223372036854775807'); assert.equal(result.items[0].problemId, 'file:long-local'); assert.equal(result.items[1].content?.acmCompare, 'exact');
});

test('file IDs cannot overwrite local/remote namespace without explicit source URL, conflicting content fails', async () => {
  const file = (description: string) => ({ id: 'leetcode-cn:problem:two-sum', title: 'Own task', description });
  const result = await previewImport({ kind: 'json', text: JSON.stringify([file('first'), file('different')]) });
  assert.equal(result.items[0].problemId, 'file:leetcode-cn:problem:two-sum'); assert.equal(result.complete, false); assert.equal(result.errors[0].code, 'CONFLICTING_DUPLICATE');
});

test('bad typed cases and unsafe numeric representations prevent a complete file preview', async () => {
  const result = await previewImport({ kind: 'json', text: JSON.stringify([{ id: 'bad', title: 'Own task', description: 'Own', adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: ['not-int'], expected: 1 }] }]) });
  assert.equal(result.complete, false); assert.equal(result.items.length, 0);
});

test('file in-place adapters reject scalar targets, reversed slices and non-integer return bounds', async () => {
  const invalidAdapters = [
    { method: 'solve', params: ['int'], returns: 'int', inPlaceArg: 0 },
    { method: 'solve', params: [{ array: 'int' }], returns: 'int', inPlaceArg: 0, inPlaceRange: { start: 2, end: 1 } },
    { method: 'solve', params: [{ array: 'int' }], returns: 'boolean', inPlaceArg: 0, inPlaceRange: { end: 'return' } },
  ];
  for (const adapter of invalidAdapters) {
    const result = await previewImport({ kind: 'json', text: JSON.stringify([{ title: 'Own task', description: 'Own', adapter }]) });
    assert.equal(result.complete, false); assert.equal(result.items.length, 0); assert.equal(result.errors[0].code, 'INVALID_IMPORT');
  }
  const result = await previewImport({ kind: 'json', text: JSON.stringify([{ title: 'Own task', description: 'Own', adapter: { method: 'solve', params: [{ array: 'int' }], returns: 'int', inPlaceArg: 0, inPlaceRange: { end: 'return' } }, cases: [{ args: [[1, 2, 2]], expected: [1, 2] }] }]) });
  assert.equal(result.complete, true); assert.deepEqual(result.items[0].content?.cases[0].expected, [1, 2]);
});

test('repeated collection links fetch once and membership completeness is independent of problem content', async () => {
  const mock = favorite(); const result = await previewImport({ kind: 'links', text: `${listUrl}\n${listUrl}?page=1` }, { adapter: new LeetCodeCnSourceAdapter({ fetchImpl: mock.fetchImpl, pageSize: 2 }) });
  assert.equal(result.complete, true); assert.equal(result.items.length, 3); assert.equal(result.duplicates.length, 1); assert.equal(mock.headers, 2);
  assert.equal(result.items.every(item => item.content === undefined), true);
});
