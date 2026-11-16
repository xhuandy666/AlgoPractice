import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareDesign, designCaseKey, designSteps, validateDesignAdapter, validateDesignOutput } from '../../src/runner/design.ts';
import { runCode } from '../../src/runner/index.ts';
import { supportsAdapter } from '../../src/runner/values.ts';
import type { DesignAdapter, RunEvent, WireValue } from '../../src/runner/types.ts';
import { designAdapter, designSampleArguments, designStatementOutputs } from '../../src/source/problem-content.ts';
import { compareWithExample, statementExampleOutputs } from '../../src/source/statement-examples.ts';
import type { ProblemContent } from '../../src/shared/library.ts';
import { capability } from '../../src/shared/capability.ts';
import { LeetCodeCnSourceAdapter } from '../../src/source/index.ts';
import { PracticeStore } from '../../src/storage/practice-store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real LeetCode CN metadata, sample cases and templates (2026-11-12); statements trimmed to the example block.
type Fixture = { metaData: string; exampleTestcases: string; jsonExampleTestcases: string; exampleHtml: string; codeSnippets: Record<string, string> };
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/leetcode-design.json', import.meta.url), 'utf8')) as Record<string, Fixture>;
const adapterOf = (slug: string) => { const adapter = designAdapter(JSON.parse(fixtures[slug].metaData)); assert.ok(adapter, slug); return adapter; };

test('LeetCode design metadata maps to a class, its constructor and its methods', () => {
  assert.deepEqual(adapterOf('lru-cache'), { kind: 'design', className: 'LRUCache', constructorParams: ['int'],
    methods: [{ name: 'get', params: ['int'], returns: 'int' }, { name: 'put', params: ['int', 'int'], returns: 'void' }] });
  assert.deepEqual(adapterOf('min-stack').methods.map(method => `${method.name}:${method.returns}`), ['push:void', 'pop:void', 'top:int', 'getMin:int']);
  assert.deepEqual(adapterOf('implement-trie-prefix-tree').methods.map(method => [method.name, method.params, method.returns]),
    [['insert', ['string'], 'void'], ['search', ['string'], 'boolean'], ['startsWith', ['string'], 'boolean']]);
  assert.deepEqual(adapterOf('find-median-from-data-stream').methods[1], { name: 'findMedian', params: [], returns: 'float' });
  const lru = JSON.parse(fixtures['lru-cache'].metaData);
  assert.equal(designAdapter({ ...lru, constructor: undefined, methods: lru.methods }), null, 'no own constructor parameters, no adapter');
  const { constructor: _omitted, ...withoutConstructor } = lru;
  assert.equal(designAdapter(withoutConstructor), null, 'the inherited Object constructor never counts');
  assert.equal(designAdapter({ ...lru, methods: [...lru.methods, { name: 'get', params: [], return: { type: 'integer' } }] }), null, 'duplicate method');
  assert.equal(designAdapter({ ...lru, methods: [...lru.methods, { name: 'Get', params: [], return: { type: 'integer' } }] }), null, 'same Go method name');
  assert.equal(designAdapter({ ...lru, methods: [{ name: 'LRUCache', params: [], return: { type: 'void' } }] }), null, 'a method named like the class');
  assert.equal(designAdapter({ ...lru, classname: 'LRU Cache' }), null, 'names are spliced into generated source');
  assert.equal(designAdapter({ ...lru, methods: [{ name: 'peek', params: [], return: { type: 'Node' } }] }), null, 'unsupported type');
});

test('sample cases come from LeetCode in either sample format, typed like the adapter', () => {
  const lru = adapterOf('lru-cache');
  const expected = [['LRUCache', 'put', 'put', 'get', 'put', 'get', 'put', 'get', 'get', 'get'], [[2], [1, 1], [2, 2], [1], [3, 3], [2], [4, 4], [1], [3], [4]]];
  assert.deepEqual(designSampleArguments({ jsonExampleTestcases: fixtures['lru-cache'].jsonExampleTestcases }, lru), [expected]);
  assert.deepEqual(designSampleArguments({ exampleTestcases: fixtures['lru-cache'].exampleTestcases }, lru), [expected]);
  for (const slug of Object.keys(fixtures)) assert.equal(designSampleArguments(fixtures[slug] as never, adapterOf(slug)).length, 1, slug);
  assert.deepEqual(designSampleArguments({ exampleTestcases: '["LRUCache","get"]\n[[2],[1]]\n["LRUCache"]' }, lru), [], 'an odd line count is not a design sample');
  assert.deepEqual(designSampleArguments({ exampleTestcases: '["LRUCache","fly"]\n[[2],[1]]' }, lru), [], 'unknown method');
  const wide: DesignAdapter = { kind: 'design', className: 'Counter', constructorParams: ['int64'], methods: [{ name: 'add', params: ['int64'], returns: 'int64' }] };
  assert.deepEqual(designSampleArguments({ exampleTestcases: '["Counter","add"]\n[[9007199254740993],[1]]' }, wide), [[['Counter', 'add'], [['9007199254740993'], ['1']]]], 'int64 keeps its digits');
});

test('statement examples pair with sample cases, with or without the colon after 输入/输出', () => {
  for (const slug of Object.keys(fixtures)) {
    const adapter = adapterOf(slug), args = designSampleArguments(fixtures[slug] as never, adapter)[0];
    const outputs = designStatementOutputs(fixtures[slug].exampleHtml, adapter);
    assert.equal(outputs.size, 1, slug); assert.ok(outputs.has(designCaseKey(args, adapter)), slug);
  }
  const outputOf = (slug: string) => [...designStatementOutputs(fixtures[slug].exampleHtml, adapterOf(slug)).values()][0];
  assert.deepEqual(outputOf('lru-cache'), [null, null, null, 1, null, -1, null, -1, 3, 4]);
  assert.deepEqual(outputOf('min-stack'), [null, null, null, null, -3, null, 0, -2]);
  assert.deepEqual(outputOf('implement-trie-prefix-tree'), [null, null, true, false, true, null, true]);
  assert.deepEqual(outputOf('find-median-from-data-stream'), [null, null, null, 1.5, null, 2]);
  const explained = fixtures['min-stack'].exampleHtml.replace('</pre>', '<strong>解释：</strong>\nMinStack minStack = new MinStack();\n</pre>');
  assert.deepEqual([...designStatementOutputs(explained, adapterOf('min-stack')).values()], [[null, null, null, null, -3, null, 0, -2]], 'the explanation ends the output');
  const wrongLength = fixtures['min-stack'].exampleHtml.replace('[null,null,null,null,-3,null,0,-2]', '[null,-3]');
  assert.equal(designStatementOutputs(wrongLength, adapterOf('min-stack')).size, 0, 'one value per operation or nothing');
  const voidWithValue = fixtures['min-stack'].exampleHtml.replace('[null,null,null,null,-3,null,0,-2]', '[null,1,null,null,-3,null,0,-2]');
  assert.equal(designStatementOutputs(voidWithValue, adapterOf('min-stack')).size, 0, 'push returns nothing');
});

test('steps validate every call, and operation names never reach inherited keys', () => {
  const lru = adapterOf('lru-cache');
  assert.deepEqual(designSteps(lru, [['LRUCache', 'put', 'get'], [[2], [1, 1], [1]]]).map(step => `${step.name}/${step.returns}`), ['LRUCache/void', 'put/void', 'get/int']);
  assert.throws(() => designSteps(lru, [['put'], [[1, 1]]]), /first operation must construct/);
  assert.throws(() => designSteps(lru, [['LRUCache', 'constructor'], [[2], []]]), /Unknown design method: constructor/);
  assert.throws(() => designSteps(lru, [['LRUCache', '__proto__'], [[2], []]]), /Unknown design method/);
  assert.throws(() => designSteps(lru, [['LRUCache', 'get'], [[2], [1, 2]]]), /Argument count mismatch for get/);
  assert.throws(() => designSteps(lru, [['LRUCache', 'get'], [[2], ['1']]]), /Expected int32/);
  assert.throws(() => designSteps(lru, [['LRUCache', 'get'], [[2]]]), /same length/);
  assert.throws(() => designSteps(lru, [['LRUCache', ...Array(1000).fill('get')], [[2], ...Array(1000).fill([1])]]), /1-1000 operations/);
  assert.throws(() => validateDesignAdapter({ ...lru, compare: { kind: 'multiset' } as never }), /float tolerance/);
  assert.equal(supportsAdapter('cpp', { ...lru, methods: [{ name: 'big', params: [], returns: 'bigint' as const }] }), false, 'C++ has no portable bigint');
  assert.equal(supportsAdapter('cpp', lru), true);
});

test('outputs list one value per operation and compare value by value', () => {
  const median = adapterOf('find-median-from-data-stream'), steps = designSteps(median, [['MedianFinder', 'addNum', 'findMedian'], [[], [1], []]]);
  assert.doesNotThrow(() => validateDesignOutput([null, null, 1], steps));
  assert.throws(() => validateDesignOutput([null, 0, 1], steps), /addNum returns nothing/);
  assert.throws(() => validateDesignOutput([null, null], steps), /one value per operation/);
  assert.equal(compareDesign([null, null, 1.0000001], [null, null, 1], steps), false, 'exact without a tolerance');
  assert.equal(compareDesign([null, null, 1.0000001], [null, null, 1], steps, { kind: 'float', absoluteTolerance: 1e-5 }), true);
  const trie = adapterOf('implement-trie-prefix-tree'), trieSteps = designSteps(trie, [['Trie', 'insert', 'search'], [[], ['a'], ['a']]]);
  assert.equal(compareDesign([null, null, true], [null, null, true], trieSteps, { kind: 'float' }), true);
  assert.equal(compareDesign([null, null, false], [null, null, true], trieSteps, { kind: 'float' }), false, 'the tolerance never loosens non-float values');
});

test('the soft example check reads design statements and compares against the case operations', () => {
  const adapter = adapterOf('lru-cache'), args = designSampleArguments(fixtures['lru-cache'] as never, adapter);
  const content = { id: 'leetcode:lru-cache', title: 'LRU 缓存', difficulty: '中等', tags: [], description: fixtures['lru-cache'].exampleHtml, descriptionFormat: 'html',
    constraints: [], mode: 'function', adapter, cases: args.map(values => ({ args: values })), starter: { python: fixtures['lru-cache'].codeSnippets.python3 } } as unknown as ProblemContent;
  const examples = statementExampleOutputs(content);
  assert.deepEqual(examples, [[null, null, null, 1, null, -1, null, -1, 3, 4]]);
  assert.equal(compareWithExample([null, null, null, 1, null, -1, null, -1, 3, 4], examples![0]!, adapter, args[0]), 'match');
  assert.equal(compareWithExample([null, null, null, 1, null, 2, null, -1, 3, 4], examples![0]!, adapter, args[0]), 'different', 'never "unordered" for design');
  assert.equal(compareWithExample([null, null, null, 4, null, -1, null, -1, 3, 1], examples![0]!, adapter, args[0]), 'different');
  assert.equal(compareWithExample([null, null, null, 1, null, -1, null, -1, 3, 4] as WireValue, examples![0]!, adapter, undefined), 'different', 'without operations nothing can be judged');
});

test('invalid design requests are rejected before inspecting a runtime', async () => {
  const events: RunEvent[] = [];
  const bigint: DesignAdapter = { kind: 'design', className: 'Big', constructorParams: [], methods: [{ name: 'value', params: [], returns: 'bigint' }] };
  const unsupported = await runCode({ language: 'cpp', code: '', mode: 'function', adapter: bigint, cases: [{ args: [['Big'], [[]]] }] }, { onEvent: event => events.push(event) });
  assert.equal(unsupported.status, 'invalid_request'); assert.match(unsupported.diagnostics[0].message, /bigint/);
  assert.deepEqual(events.map(event => event.phase), ['queued', 'finished']);
  const malformed = await runCode({ language: 'python', code: '', mode: 'function', adapter: adapterOf('min-stack'), cases: [{ args: [['MinStack', 'peek'], [[], []]] }] });
  assert.equal(malformed.status, 'invalid_request'); assert.match(malformed.diagnostics[0].message, /Unknown design method: peek/);
  const injected = await runCode({ language: 'java', code: '', mode: 'function', adapter: { ...adapterOf('min-stack'), className: 'MinStack(); System.exit(0); //' }, cases: [{ args: [['MinStack'], [[]]] }] });
  assert.equal(injected.status, 'invalid_request', 'names are checked in the runner too, not only at import');
});

const page = (question: unknown) => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { dehydratedState: { queries: [{ state: { data: { question } } }] } } } })}</script>`, { headers: { 'content-type': 'text/html' } });
const designQuestion = (slug: string, fields: Record<string, unknown> = {}) => {
  const fixture = fixtures[slug];
  return { id: 146, titleSlug: slug, questionFrontendId: '146', title: slug, translatedTitle: null, difficulty: 'MEDIUM', paidOnly: false,
    metaData: fixture.metaData, exampleTestcases: fixture.exampleTestcases, jsonExampleTestcases: fixture.jsonExampleTestcases, translatedContent: `<p>自建说明。</p>${fixture.exampleHtml}`,
    codeSnippets: Object.entries(fixture.codeSnippets).map(([langSlug, code]) => ({ langSlug, code })), ...fields };
};
const importDesign = (slug: string, fields: Record<string, unknown> = {}) =>
  new LeetCodeCnSourceAdapter({ fetchImpl: (async () => page(designQuestion(slug, fields))) as typeof fetch }).fetchProblemContent(`https://leetcode.cn/problems/${String(fields.titleSlug ?? slug)}/`);

test('importing a reviewed design problem yields sample-verified cases from its statement', async () => {
  const imported = await importDesign('lru-cache');
  assert.equal(imported.capability, 'sample-verified');
  assert.deepEqual(imported.content.adapter, adapterOf('lru-cache'));
  assert.deepEqual(imported.content.cases[0].expected, [null, null, null, 1, null, -1, null, -1, 3, 4]);
  for (const language of ['python', 'java', 'go', 'cpp'] as const) assert.equal(capability(imported.content, language).canRun, true, language);
  const median = await importDesign('find-median-from-data-stream');
  assert.deepEqual((median.content.adapter as DesignAdapter).compare, { kind: 'float', absoluteTolerance: 1e-5, relativeTolerance: 1e-5 }, 'the statement accepts 1e-5');
});

test('unreviewed or malformed design problems never get expected values', async () => {
  const renamed = await importDesign('lru-cache', { titleSlug: 'my-lru-cache' });
  assert.equal(renamed.capability, 'execution-only'); assert.equal(renamed.content.cases.some(test => Object.hasOwn(test, 'expected')), false);
  assert.match(renamed.content.supportReason!, /设计题/);
  const manual = await importDesign('lru-cache', { metaData: JSON.stringify({ ...JSON.parse(fixtures['lru-cache'].metaData), manual: true }) });
  assert.equal(manual.capability, 'statement-only');
  const noSamples = await importDesign('lru-cache', { exampleTestcases: '', jsonExampleTestcases: '' });
  assert.equal(noSamples.capability, 'statement-only');
  const missingConstructor = JSON.parse(fixtures['lru-cache'].metaData); delete missingConstructor.constructor;
  assert.equal((await importDesign('lru-cache', { metaData: JSON.stringify(missingConstructor) })).capability, 'statement-only');
});

test('the library marks C++ unavailable when any design method uses bigint', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-design-library-'));
  const store = new PracticeStore(join(directory, 'practice.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const save = (id: string, adapter: DesignAdapter) => store.upsertProblem({ id, title: id, difficulty: '中等', tags: [], description: '题面', descriptionFormat: 'plain', constraints: [],
    mode: 'function', adapter, cases: [{ args: [[adapter.className], [[]]] }], starter: { python: 'class X: pass', cpp: 'class X {};' }, source: 'file' } as never);
  save('design:plain', { kind: 'design', className: 'Counter', constructorParams: [], methods: [{ name: 'bigint', params: [], returns: 'int' }] });
  save('design:big', { kind: 'design', className: 'Counter', constructorParams: [], methods: [{ name: 'total', params: [{ list: 'bigint' }], returns: 'void' }] });
  save('design:big-constructor', { kind: 'design', className: 'Counter', constructorParams: ['bigint'], methods: [{ name: 'total', params: [], returns: 'int' }] });
  const items = new Map(store.listProblemPage({ limit: 10 }).items.map(item => [item.id, item.capabilities]));
  assert.equal(items.get('design:plain')?.cpp, true, 'a method merely named "bigint" is not a bigint type');
  assert.equal(items.get('design:big')?.cpp, false); assert.equal(items.get('design:big-constructor')?.cpp, false);
  assert.equal(items.get('design:big')?.python, true); assert.equal(items.get('design:plain')?.adapter, true);
});
