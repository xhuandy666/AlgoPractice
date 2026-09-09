import test from 'node:test';
import assert from 'node:assert/strict';
import { aiCompletionEndpoint, normalizeAiBaseUrl } from '../../src/shared/ai-endpoint.ts';
import { completionEndpoint } from '../../src/ai/canonical.ts';
import { AI_PROVIDER_PRESETS, createAiProviderPreset } from '../../src/shared/ai.ts';
test('URL aliases preserve the exact credential endpoint across settings and request code', () => {
  for (const preset of AI_PROVIDER_PRESETS) {
    const config = createAiProviderPreset(preset.id, 'existing-provider'); const endpoint = completionEndpoint(config);
    for (const address of [config.baseUrl, config.baseUrl + '/', endpoint, '  ' + config.baseUrl + '  ']) assert.equal(aiCompletionEndpoint(address), endpoint);
  }
  assert.notEqual(aiCompletionEndpoint('https://api.deepseek.com'), aiCompletionEndpoint('https://other.invalid'));
});
test('shared endpoint identity rejects embedded secrets and remote insecure transports', () => {
  for (const value of ['https://key@api.deepseek.com', 'https://api.deepseek.com?key=secret', 'https://api.deepseek.com#private', 'http://api.deepseek.com', 'file:///tmp/key', 'invalid']) assert.throws(() => normalizeAiBaseUrl(value));
  assert.equal(aiCompletionEndpoint('http://127.0.0.1:12345/v1/'), 'http://127.0.0.1:12345/v1/chat/completions');
});
