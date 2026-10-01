import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestSnapshot, canonicalJson, validateResponse } from '../../src/ai/index.ts';
import { AiValidationError } from '../../src/ai/policy.ts';
import type { AiKind } from '../../src/shared/ai.ts';
import { answer, config, context, input } from './helpers.ts';

function fixture(kind: AiKind = 'chat') {
  const request = { ...input(), kind, ...(kind === 'official-review' ? { officialSubmissionId: 'official-response-format' } : {}) }, source = context();
  if (kind === 'official-review') {
    source.officialSubmissionId = 'official-response-format';
    source.official = { id: 'official-response-format', attemptId: source.attemptId, problemVersion: source.problemVersion,
      codeHash: source.run!.codeHash, status: 'wrong_answer', statusMessage: 'Wrong Answer' };
  }
  const snapshot = buildRequestSnapshot(request, source, config());
  snapshot.promptVersion = 'tilian-chat-coach-v2.4';
  return { request, source, snapshot, response: answer(request, source) };
}
function reason(expected: string) {
  return (error: unknown) => error instanceof AiValidationError && error.detail.validationReason === expected;
}

test('Missing optional arrays/proposals and title normalize without guessing structured identity', () => {
  for (const kind of ['chat', 'hint', 'diagnosis', 'official-review'] as const) {
    const { snapshot } = fixture(kind);
    const result = validateResponse(JSON.stringify({ schemaVersion: 2, kind, explanation: '先想清楚已处理元素与当前累积值之间的关系。' }), snapshot);
    assert.equal(result.kind, kind); assert.ok(result.title.trim());
    assert.deepEqual(result.nextSteps, []); assert.deepEqual(result.evidence, []); assert.deepEqual(result.inferences, []);
    assert.equal(result.patch, null); assert.equal(result.completeSolution, null); assert.equal(result.noteDraft, null);
    assert.deepEqual(validateResponse(canonicalJson(result), snapshot), result, 'the stored normalized answer must remain stable');
  }
});

test('A note action may omit presentation fields but still needs an explicit complete note proposal', () => {
  const { snapshot, response } = fixture('note-draft');
  const normalized = validateResponse(JSON.stringify({ schemaVersion: 2, kind: 'note-draft', explanation: response.explanation, noteDraft: response.noteDraft }), snapshot);
  assert.deepEqual(normalized.noteDraft, response.noteDraft); assert.equal(normalized.patch, null);
  assert.throws(() => validateResponse(JSON.stringify({ schemaVersion: 2, kind: 'note-draft', explanation: response.explanation }), snapshot), reason('noteKind'));
});

test('A single complete JSON object accepts bare/json fences and short prose wrappers', () => {
  const { snapshot, response } = fixture(); const raw = JSON.stringify(response);
  for (const wrapped of [raw, `\n\uFEFF${raw}\n`, `\`\`\`json\n${raw}\n\`\`\``, `\`\`\`JSON\r\n${raw}\r\n\`\`\``, `\`\`\`\n${raw}\n\`\`\``, `下面是分析：\n${raw}\n请结合当前代码核对。`, `下面是分析：\n\`\`\`json\n${raw}\n\`\`\`\n希望对你有帮助。`]) {
    assert.deepEqual(validateResponse(wrapped, snapshot), response);
  }
});

test('JSON extraction respects quoted braces, brackets, escapes, and code fences inside explanation', () => {
  const { snapshot, response } = fixture();
  response.explanation = '字典的空值是 {}，数组是 []，引号是 "，路径可以含反斜杠 \\。\n```java\nif (ready) { step(); }\n```';
  assert.deepEqual(validateResponse(`回答如下：\n\`\`\`json\n${JSON.stringify(response)}\n\`\`\``, snapshot), response);
});

test('JSON wrappers are bounded and cannot hide multiple objects, arrays or partial objects', () => {
  const { snapshot, response } = fixture(); const raw = JSON.stringify(response);
  for (const wrapped of [`${'说明'.repeat(257)}${raw}`, `${raw}${'说明'.repeat(257)}`, `${raw}\n${raw}`, `回答：${raw}\n{"partial":`, `[${raw}]`, `\`\`\`json\n${raw}`, `${raw}\n\`\`\``, `\`\`\`python\n${raw}\n\`\`\``, `\`\`\`json\n${raw}\n\`\`\`\n\`\`\`text\nextra\n\`\`\``]) {
    assert.throws(() => validateResponse(wrapped, snapshot), reason('shape'));
  }
});

test('Schema and action cannot be inferred or changed when a structured answer omits or contradicts them', () => {
  const { snapshot, response } = fixture();
  for (const field of ['schemaVersion', 'kind', 'explanation'] as const) {
    const incomplete: Record<string, unknown> = { ...response }; delete incomplete[field];
    assert.throws(() => validateResponse(JSON.stringify(incomplete), snapshot), reason('shape'));
  }
  for (const change of [{ kind: 'hint' }, { schemaVersion: 1 }, { schemaVersion: '2' }, { kind: null }]) {
    assert.throws(() => validateResponse(JSON.stringify({ ...response, ...change }), snapshot), reason('schemaKind'));
  }
});

test('Only missing fields get defaults; explicit bad types, extra fields and incomplete code proposals fail', () => {
  const { snapshot, response } = fixture();
  for (const change of [{ nextSteps: null }, { evidence: '没有' }, { inferences: {} }, { title: null }, { title: '' }, { patch: {} }, { patch: { baseCodeHash: snapshot.codeHash } }, { completeSolution: { code: 'return 1' } }, { noteDraft: {} }, { tools: [{ name: 'execute' }] }, { extra: 'unexpected' }]) {
    assert.throws(() => validateResponse(JSON.stringify({ ...response, ...change }), snapshot));
  }
});

test('New chat can render bounded natural Markdown without creating evidence or code actions', () => {
  const { snapshot } = fixture();
  for (const raw of ['先想清楚累积变量在每一步代表什么，再用一个短数组手动验证。', '可以先检查循环不变式。\n\n- 已处理了哪些元素？\n- 累积值现在应该是多少？', '1. 明确累积值代表什么。\n2. 用小数组验证循环。', '- 检查空数组。\n- 检查负数。', '可以用小例子检查。\n```java\nif (ready) { step(); }\n```\n这只是说明结构的例子。', 'Consider what the accumulator represents before each iteration.']) {
    const result = validateResponse(raw, snapshot);
    assert.equal(result.explanation, raw); assert.equal(result.kind, 'chat'); assert.deepEqual(result.evidence, []);
    assert.equal(result.patch, null); assert.equal(result.completeSolution, null); assert.equal(result.noteDraft, null);
    assert.deepEqual(validateResponse(canonicalJson(result), snapshot), result);
  }
});

test('Plain chat does not rescue malformed or truncated JSON, primitives, oversized bodies or non-answer markers', () => {
  const { snapshot } = fixture();
  for (const raw of ['{"schemaVersion":2,"kind":"chat","explanation":"残缺', '{broken', '回答如下：\n{"unknown":', '下面是回答：\n```python\n{"unknown":true}\n```', '```json\n{"explanation":"残缺', '"仅字符串"', '["仅数组"]', 'null', 'true', '23', 'UNVALIDATED-MODEL-DATA', '中文'.repeat(4001), '中文\u0000回答']) {
    assert.throws(() => validateResponse(raw, snapshot), reason('shape'));
  }
  for (const kind of ['hint', 'diagnosis', 'official-review', 'note-draft'] as const) {
    assert.throws(() => validateResponse('普通自然语言不能代替本次结构化动作。', fixture(kind).snapshot), reason('shape'));
  }
});

test('Normalized prose and omitted fields retain factual and guarantee checks', () => {
  const { snapshot } = fixture();
  for (const [explanation, expected] of [['代码保证正确。', 'guarantee'], ['代码已获得官方 AC。', 'officialSuccess'], ['本地所有测试都已通过。', 'localSuccess']] as const) {
    assert.throws(() => validateResponse(explanation, snapshot), reason(expected));
    assert.throws(() => validateResponse(JSON.stringify({ schemaVersion: 2, kind: 'chat', explanation }), snapshot), reason(expected));
  }
});

test('Wrapped compact answers cannot use forged or historical evidence or stale patch hashes', () => {
  const { snapshot, source } = fixture('diagnosis');
  const compact = { schemaVersion: 2, kind: 'diagnosis', explanation: '请核对当前结果。', evidence: [{ runId: 'invented-run', kind: 'test', quote: 'wrong_answer', caseIndex: 0 }] };
  assert.throws(() => validateResponse(`\`\`\`json\n${JSON.stringify(compact)}\n\`\`\``, snapshot), reason('localRun'));
  compact.evidence[0].runId = source.run!.id; compact.evidence[0].quote = 'fabricated expected value';
  assert.throws(() => validateResponse(JSON.stringify(compact), snapshot), reason('quote'));
  snapshot.previousRun = { code: source.code, run: source.run! }; snapshot.run = null;
  compact.evidence[0].quote = 'wrong_answer';
  assert.throws(() => validateResponse(JSON.stringify(compact), snapshot), reason('localRun'));
  assert.throws(() => validateResponse(JSON.stringify({ schemaVersion: 2, kind: 'diagnosis', explanation: '代码可能需要调整。', inferences: [{ text: '检查返回值。', reason: '基于当前代码的推断。' }], patch: { baseCodeHash: '0'.repeat(64), edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] } }), snapshot), reason('patchHash'));
});

test('New explicit hint rejects non-null code proposals, including Markdown strings and partial proposals', () => {
  const { snapshot, response } = fixture('hint');
  for (const field of ['patch', 'completeSolution'] as const) {
    for (const proposal of ['```python\nreturn sum(nums)\n```', {}, { code: 'return sum(nums)' }, { baseCodeHash: snapshot.codeHash, edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] }]) {
      assert.throws(() => validateResponse(JSON.stringify({ ...response, [field]: proposal }), snapshot), reason('patchKind'));
    }
  }
});

test('Historical adaptive hint responses and v1 response/hash representation stay compatible', () => {
  const { snapshot, response } = fixture('hint'); snapshot.promptVersion = 'tilian-adaptive-coach-v2.3';
  response.inferences = [{ text: '检查返回值。', reason: '基于当时提供的代码。' }];
  response.patch = { baseCodeHash: snapshot.codeHash, edits: [{ startLine: 6, endLine: 6, replacement: '        return total' }] };
  assert.equal(canonicalJson(validateResponse(canonicalJson(response), snapshot)), canonicalJson(response));
  const oldSnapshot = { ...snapshot, policyVersion: 'algopractice-ai-policy-v1', promptVersion: 'algopractice-tutor-v1', level: 'L2' as const, unlockCompleteSolution: false };
  const oldResponse = { ...response, schemaVersion: 1 as const, level: 'L2' as const, patch: null };
  assert.equal(canonicalJson(validateResponse(canonicalJson(oldResponse), oldSnapshot)), canonicalJson(oldResponse));
  assert.throws(() => validateResponse(`\`\`\`json\n${canonicalJson(oldResponse)}\n\`\`\``, oldSnapshot));
});
