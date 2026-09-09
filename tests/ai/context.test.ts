import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestSnapshot, canonicalJson, completionEndpoint, normalizeProviderConfig, requestHash, sha256, validateRequestInput } from '../../src/ai/index.ts';
import { config, context, input } from './helpers.ts';

test('Canonical JSON is field-order independent, while arrays remain ordered', () => { assert.equal(canonicalJson({ z: 1, a: { c: 2, b: 3 } }), canonicalJson({ a: { b: 3, c: 2 }, z: 1 })); assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1])); assert.throws(() => canonicalJson({ value: Infinity })); });
test('Provider endpoint normalization binds exact HTTPS destination and explicit local HTTP', () => { assert.equal(completionEndpoint({ ...config(), baseUrl: 'https://HOST.invalid/v1/' }), 'https://host.invalid/v1/chat/completions'); assert.equal(completionEndpoint({ ...config(), baseUrl: 'https://host.invalid/v1/chat/completions' }), 'https://host.invalid/v1/chat/completions'); assert.doesNotThrow(() => normalizeProviderConfig({ ...config(), baseUrl: 'http://127.0.0.1:8000/v1' })); for (const baseUrl of ['http://remote.invalid/v1', 'file:///tmp/key', 'https://name:key@host.invalid/v1', 'https://host.invalid/v1?key=secret', 'https://host.invalid/v1#token']) assert.throws(() => normalizeProviderConfig({ ...config(), baseUrl })); });
test('Credentials and arbitrary options are not accepted as provider settings', () => { assert.throws(() => normalizeProviderConfig({ ...config(), apiKey: 'synthetic-secret' })); assert.throws(() => normalizeProviderConfig({ ...config(), maxOutputTokens: 1000000 })); assert.throws(() => validateRequestInput({ ...input(), mode: 'practice', code: 'spoofed' })); });
test('Snapshot does not upload unselected notes/conversations and cannot be mutated through resolver objects', () => { const source = context(), request = input(); const snapshot = buildRequestSnapshot(request, source, config()); assert.ok(!snapshot.messages[1].content.includes('note-version-a')); assert.ok(!snapshot.messages[1].content.includes('message-a')); source.code = 'changed'; source.problem.description = 'changed'; source.run!.caseResults[0].actual = 99; assert.notEqual(snapshot.code, source.code); assert.equal(snapshot.run!.caseResults[0].actual, 0); });
test('All complete normalized request dimensions participate in cache identity', () => { const source = context(), request = input(), provider = config(); const original = requestHash(buildRequestSnapshot(request, source, provider));
  const variants = [
    buildRequestSnapshot({ ...request, question: '另一个问题' }, source, provider),
    buildRequestSnapshot({ ...request, level: 'L1' }, source, provider),
    buildRequestSnapshot({ ...request, noteIds: ['note-a'] }, source, provider),
    buildRequestSnapshot({ ...request, conversationIds: ['message-a'] }, source, provider),
    buildRequestSnapshot(request, { ...source, problem: { ...source.problem, description: 'different statement' } }, provider),
    buildRequestSnapshot(request, { ...source, code: source.code + '# edited', run: null }, provider),
    buildRequestSnapshot(request, { ...source, run: { ...source.run!, stderr: 'different evidence' } }, provider),
    buildRequestSnapshot(request, { ...source, mode: 'coached' }, provider),
    buildRequestSnapshot(request, source, { ...provider, id: 'another-provider-id' }),
    buildRequestSnapshot(request, source, { ...provider, baseUrl: 'https://another.invalid/v1' }),
    buildRequestSnapshot(request, source, { ...provider, model: 'another-model' }),
    buildRequestSnapshot(request, source, { ...provider, temperature: 0.5 }),
    buildRequestSnapshot(request, source, { ...provider, jsonMode: true }),
  ];
  for (const snapshot of variants) assert.notEqual(requestHash(snapshot), original);
  assert.equal(requestHash(buildRequestSnapshot({ ...request, requestId: 'another-operation' }, source, provider)), original);
  const snapshot = buildRequestSnapshot(request, source, provider); snapshot.policyVersion += '-changed'; assert.notEqual(requestHash(snapshot), original); snapshot.promptVersion += '-changed'; assert.notEqual(requestHash(snapshot), original);
});
test('Selected note and conversation content, not only their IDs, affect cache hash', () => { const source = context(), request = { ...input(), noteIds: ['note-a'], conversationIds: ['message-a'] }; const original = requestHash(buildRequestSnapshot(request, source, config())); source.notes[0].markdown = 'edited note'; assert.notEqual(requestHash(buildRequestSnapshot(request, source, config())), original); const noteChanged = requestHash(buildRequestSnapshot(request, source, config())); source.conversation[0].content = 'edited conversation'; assert.notEqual(requestHash(buildRequestSnapshot(request, source, config())), noteChanged); });
test('Context clipping is explicit and keeps a full code hash plus actual sent messages', () => { const source = context(); source.code = '# 长代码\n'.repeat(8000); source.run = null; source.problem.description = '题面'.repeat(8000); const snapshot = buildRequestSnapshot(input(), source, config()); assert.equal(snapshot.codeHash, sha256(source.code)); assert.equal(snapshot.code, source.code); assert.ok(snapshot.clippedFields.includes('code')); assert.ok(snapshot.clippedFields.includes('problem.description')); assert.ok(snapshot.messages[1].content.includes('[内容已裁剪]')); assert.ok(snapshot.messages[1].content.length < source.code.length + source.problem.description.length); });
test('Wrong Attempt, Run hash/version, missing selected notes and L4 spoofing are rejected', () => { const source = context(); assert.throws(() => buildRequestSnapshot(input(), { ...source, attemptId: 'foreign' }, config())); assert.throws(() => buildRequestSnapshot(input(), { ...source, run: { ...source.run!, codeHash: '0'.repeat(64) } }, config())); assert.throws(() => buildRequestSnapshot({ ...input(), noteIds: ['missing'] }, source, config())); assert.throws(() => buildRequestSnapshot({ ...input(), level: 'L4', unlockCompleteSolution: false }, source, config())); });
