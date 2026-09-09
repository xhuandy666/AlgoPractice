import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROVIDER_PRESETS, createAiProviderPreset } from '../../src/shared/ai.ts';
import { buildRequestSnapshot, canonicalJson, completionEndpoint, normalizeProviderConfig, requestHash } from '../../src/ai/index.ts';
import { config, context, input } from './helpers.ts';

test('Documented China presets expose only public editable config, with independent configuration identities', () => {
  const expected = [
    ['deepseek-cn', 'https://api.deepseek.com/chat/completions', 'deepseek-v4-flash'],
    ['glm-cn', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm-4.7-flash'],
    ['qwen-cn', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'qwen-flash'],
  ];
  assert.equal(AI_PROVIDER_PRESETS.length, expected.length);
  for (const [id, endpoint, model] of expected) {
    const first = createAiProviderPreset(id, 'config-a'), second = createAiProviderPreset(id, 'config-b');
    assert.deepEqual(normalizeProviderConfig(first), first);
    assert.equal(completionEndpoint(first), endpoint); assert.equal(first.model, model);
    assert.equal(first.jsonMode, true); assert.equal(first.timeoutMs, 120000);
    assert.equal(first.maxOutputTokens, 4096); assert.equal(second.id, 'config-b');
    first.model = 'user-chosen-model'; assert.equal(second.model, model);
    assert.ok(!Object.keys(first).some(key => /key|secret|token$/i.test(key)));
    assert.equal(AI_PROVIDER_PRESETS.find(preset => preset.id === id)?.verifiedAt, '2026-09-09');
  }
  assert.throws(() => createAiProviderPreset('unknown', 'config-a'));
  assert.throws(() => createAiProviderPreset('qwen-cn', ''));
  assert.throws(() => createAiProviderPreset('qwen-cn', 'bad\nidentifier'));
});
test('Old configs and snapshots retain their exact canonical identity when compatibility is absent', () => {
  const old = config(); assert.deepEqual(normalizeProviderConfig(old), old);
  assert.ok(!Object.hasOwn(normalizeProviderConfig(old), 'compatibility'));
  const snapshot = buildRequestSnapshot(input(), context(), old);
  const persisted = JSON.parse(canonicalJson(snapshot));
  assert.equal(requestHash(persisted), requestHash(snapshot));
  assert.deepEqual(normalizeProviderConfig(persisted.provider), old);
});
test('Explicit compatibility participates in cache identity without inferring it from the host or model', () => {
  const old = config(), request = input(), source = context();
  const hash = requestHash(buildRequestSnapshot(request, source, old));
  for (const compatibility of ['openai-compatible', 'deepseek', 'glm', 'qwen'] as const) {
    const changed = { ...old, compatibility };
    assert.notEqual(requestHash(buildRequestSnapshot(request, source, changed)), hash);
  }
  const sameHost = normalizeProviderConfig({ ...old, baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' });
  assert.ok(!Object.hasOwn(sameHost, 'compatibility'));
});
test('Provider-specific options remain an allowlist, including GLM documented temperature bounds', () => {
  for (const compatibility of ['', 'untrusted-provider', ['qwen'], { toString: () => 'glm' }, true, null]) {
    assert.throws(() => normalizeProviderConfig({ ...config(), compatibility }));
  }
  for (const extra of [{ apiKey: 'synthetic' }, { extra_body: { tools: [] } }, { thinking: { type: 'enabled' } }]) {
    assert.throws(() => normalizeProviderConfig({ ...config(), ...extra }));
  }
  for (const temperature of [1.01, 2, 0.222]) assert.throws(() => normalizeProviderConfig({ ...config(), compatibility: 'glm', temperature }));
  for (const temperature of [0, 0.2, 0.29, 1]) assert.doesNotThrow(() => normalizeProviderConfig({ ...config(), compatibility: 'glm', temperature }));
});
