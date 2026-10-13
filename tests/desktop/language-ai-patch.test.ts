import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { AiService } from '../../src/ai/service.ts';
import { AiServiceError } from '../../src/ai/errors.ts';
import { buildRequestSnapshot, requestHash } from '../../src/ai/context.ts';
import { validateResponse } from '../../src/ai/policy.ts';
import { applyPracticeAiPatch, buildPracticeAiContext } from '../../src/desktop/learning-context.ts';
import { LANGUAGES } from '../../src/shared/languages.ts';
import type { AcmTestConfig, AnswerFormat } from '../../src/shared/answer-format.ts';
import type { AiPatchApplication, AiProviderConfig, AiRequestInput, AiResponse, AiTrustedContext } from '../../src/shared/ai.ts';
import { PracticeStore, hashCode, type Attempt } from '../../src/storage/practice-store.ts';

// Deliberately identical bytes and revisions across all workspaces make identity
// checks decisive. No source is compiled, no provider is called, and no Key exists.
const originalCode = 'SHARED_DRAFT\n';
const scopeIds = ['practice', 'alternate'];
const formats: AnswerFormat[] = ['function', 'acm'];
const tests: AcmTestConfig = { version: 1, compare: 'exact', cases: [{ stdin: 'fixture\n', expected: '' }] };
const provider: AiProviderConfig = { id: 'disabled-patch-provider', baseUrl: 'https://not-called.example.invalid/v1',
  model: 'unused-fixture', temperature: 0, maxOutputTokens: 1024, timeoutMs: 10000, jsonMode: false, includeUsage: false };

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tilian-four-language-ai-patch-')), path = join(directory, 'practice.sqlite');
  let store = new PracticeStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const problem = store.upsertProblem({ id: 'local:language-ai-identity', title: '独立补丁身份夹具', source: 'local', difficulty: '简单',
    description: '仅核验补丁工作区身份；不执行或证明程序正确。', descriptionFormat: 'plain', tags: [], constraints: [], mode: 'function',
    adapter: { method: 'solve', params: ['int'], returns: 'int' }, cases: [{ args: [1], expected: 1 }],
    starter: Object.fromEntries(LANGUAGES.map(language => [language, originalCode])) });
  const attempts = new Map<string, Attempt>();
  for (const language of LANGUAGES) for (const answerFormat of formats) for (const scopeId of scopeIds) {
    const attempt = store.startAttempt({ problemId: problem.id, problemVersion: problem.version, language, answerFormat, draftScopeId: scopeId });
    store.saveDraft({ problemId: problem.id, language, answerFormat, scopeId, code: originalCode, expectedRevision: 0,
      ...(answerFormat === 'acm' ? { testConfig: tests } : {}) });
    attempts.set(`${language}:${answerFormat}:${scopeId}`, attempt);
  }
  const drafts = () => Object.fromEntries(LANGUAGES.flatMap(language => formats.flatMap(format => scopeIds
    .map(scope => [`${language}:${format}:${scope}`, store.getDraft(problem.id, language, scope, format)!] as const))));
  return { get store() { return store; }, problem, attempts, drafts, reopen: () => { store.close(); store = new PracticeStore(path); } };
}

for (const language of LANGUAGES) for (const answerFormat of formats) test(`${language}/${answerFormat} AI patch binds its persisted attempt and scope while identical other-language drafts remain untouched`, async t => {
  const f = fixture(t), attempt = f.attempts.get(`${language}:${answerFormat}:practice`)!, otherLanguage = LANGUAGES.find(value => value !== language)!;
  const input: AiRequestInput = { requestId: `patch-${language}-${answerFormat}`, attemptId: attempt.id, kind: 'diagnosis', question: '仅测试补丁身份。' };
  const context = buildPracticeAiContext(f.store, input), snapshot = buildRequestSnapshot(input, context, provider);
  assert.equal(context.language, language); assert.equal(snapshot.language, language); assert.equal(context.answerFormat, answerFormat);
  assert.equal(JSON.parse(snapshot.messages[1].content).learningContext.language, language);
  assert.equal(snapshot.codeHash, hashCode(originalCode)); assert.equal(snapshot.draftRevision, 1);
  const rawResponse: AiResponse = { schemaVersion: 2, kind: 'diagnosis', title: '合成补丁',
    explanation: '仅测试身份绑定，没有执行代码或取得判题结果。', nextSteps: [], evidence: [],
    inferences: [{ text: '替换合成占位行。', reason: '这是传输夹具，不表示程序正确。' }],
    patch: { baseCodeHash: snapshot.codeHash, edits: [{ startLine: 1, endLine: 1, replacement: `PATCHED_${language}_${answerFormat}` }] },
    completeSolution: null, noteDraft: null };
  const response = validateResponse(JSON.stringify(rawResponse), snapshot);
  f.store.beginAIRequest({ id: input.requestId, attemptId: attempt.id, requestHash: requestHash(snapshot), snapshot });
  const record = f.store.finishAIRequest(input.requestId, { status: 'completed', response, error: null, usage: null, cachedFromRequestId: null });
  assert.equal(record.snapshot.language, language); assert.deepEqual(f.store.getAIRequest(record.id), record);
  const wrongSnapshot = { ...snapshot, language: otherLanguage };
  assert.throws(() => f.store.beginAIRequest({ id: `${input.requestId}-wrong-language`, attemptId: attempt.id,
    requestHash: requestHash(wrongSnapshot), snapshot: wrongSnapshot }), /AI snapshot does not match/);
  assert.equal(f.store.listAIRequests(attempt.id).length, 1);

  let forbiddenCalls = 0, override: Partial<AiTrustedContext> | null = null;
  const forbidden = (): never => { forbiddenCalls++; throw new Error('Provider, network and credential paths are forbidden in this fixture'); };
  const service = new AiService({ repository: f.store,
    vault: { secureStorageAvailable: forbidden, hasKey: forbidden, setKey: forbidden, clearKey: forbidden, withKey: forbidden },
    resolveProvider: forbidden, fetchImpl: forbidden,
    resolveContext: request => ({ ...buildPracticeAiContext(f.store, request), ...(override ?? {}) }) });
  const before = f.drafts();
  for (const draft of Object.values(before)) { assert.equal(draft.codeHash, snapshot.codeHash); assert.equal(draft.revision, snapshot.draftRevision); }
  const changedContext: Array<[string, Partial<AiTrustedContext>]> = [
    ['language', { language: otherLanguage }],
    ['attempt', { attemptId: f.attempts.get(`${language}:${answerFormat}:alternate`)!.id }],
    ['scope', { draftScopeId: 'alternate' }],
  ];
  for (const [field, mutation] of changedContext) {
    override = mutation;
    await assert.rejects(service.preparePatch(record.id), error => error instanceof AiServiceError && error.detail.code === 'STALE_PATCH', `${field} alone invalidates the stored patch despite unchanged bytes/revision`);
    assert.deepEqual(f.drafts(), before);
  }
  override = null;
  const patch = await service.preparePatch(record.id);
  assert.equal(patch.language, language); assert.equal(patch.attemptId, attempt.id); assert.equal(patch.draftScopeId, 'practice');
  assert.equal(patch.answerFormat, answerFormat); assert.equal(patch.baseCodeHash, snapshot.codeHash); assert.equal(patch.expectedDraftRevision, 1);
  assert.equal(patch.code, `PATCHED_${language}_${answerFormat}\n`);
  assert.deepEqual(f.drafts(), before, 'Preparing a patch is read-only');
  const wrongPatch: Array<[string, AiPatchApplication]> = [
    ['language', { ...patch, language: otherLanguage }],
    ['attempt', { ...patch, attemptId: f.attempts.get(`${otherLanguage}:${answerFormat}:practice`)!.id }],
    ['scope', { ...patch, draftScopeId: 'alternate' }],
    ['format', { ...patch, answerFormat: answerFormat === 'function' ? 'acm' : 'function' }],
  ];
  for (const [field, candidate] of wrongPatch) {
    assert.throws(() => applyPracticeAiPatch(f.store, candidate), /已经变化/, `${field} cannot redirect patch application to an identical neighboring draft`);
    assert.deepEqual(f.drafts(), before);
  }
  const saved = applyPracticeAiPatch(f.store, patch);
  assert.equal(saved.language, language); assert.equal(saved.answerFormat, answerFormat); assert.equal(saved.scopeId, 'practice');
  assert.equal(saved.code, patch.code); assert.equal(saved.revision, 2); assert.equal(saved.codeHash, hashCode(patch.code));
  if (answerFormat === 'acm') assert.deepEqual(saved.testConfig, tests);
  const after = f.drafts(), targetKey = `${language}:${answerFormat}:practice`;
  for (const [key, draft] of Object.entries(before)) if (key !== targetKey) assert.deepEqual(after[key], draft, `${key} is not the patch target`);
  assert.equal(after[targetKey].code, patch.code);
  await assert.rejects(service.preparePatch(record.id), error => error instanceof AiServiceError && error.detail.code === 'STALE_PATCH');
  assert.deepEqual(f.store.getAIRequest(record.id), record, 'Applying the proposal never rewrites its original immutable AI snapshot/response');
  assert.equal(forbiddenCalls, 0); f.store.integrityCheck();
  f.reopen();
  assert.deepEqual(f.drafts(), after); assert.deepEqual(f.store.getAIRequest(record.id), record);
  assert.equal(forbiddenCalls, 0); f.store.integrityCheck();
});
