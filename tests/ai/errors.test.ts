import test from 'node:test';
import assert from 'node:assert/strict';
import { AiServiceError, publicAiError } from '../../src/ai/errors.ts';
import { AI_VALIDATION_REASONS } from '../../src/shared/ai.ts';

test('Validation failures expose only a fixed category and safe user message', () => {
  for (const validationReason of AI_VALIDATION_REASONS) {
    const error = new AiServiceError('POLICY_VIOLATION', { validationReason });
    Object.assign(error, { message: 'PRIVATE-RAW-ANSWER', cause: new Error('PRIVATE-KEY') });
    Object.assign(error.detail, { message: 'PRIVATE-PROVIDER-BODY', repairHint: 'PRIVATE-REPAIR', response: 'PRIVATE-RESPONSE' });
    const result = publicAiError(error);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'retryable', 'validationReason']);
    assert.equal(result.validationReason, validationReason);
    assert.ok(result.message.length > 0);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('Unknown or misplaced validation categories never reach the renderer', () => {
  const unknown = new AiServiceError('FORMAT_INVALID', { validationReason: 'PRIVATE-RAW-ANSWER' as never });
  assert.equal(publicAiError(unknown).validationReason, undefined);
  Object.assign(unknown.detail, { validationReason: 'PRIVATE-MUTATED-ANSWER' });
  assert.ok(!JSON.stringify(publicAiError(unknown)).includes('PRIVATE'));
  const unrelated = new AiServiceError('AUTH', { validationReason: 'quote' });
  assert.equal(publicAiError(unrelated).validationReason, undefined);
  assert.equal(publicAiError(new Error('PRIVATE-UNKNOWN-ERROR')).validationReason, undefined);
});
