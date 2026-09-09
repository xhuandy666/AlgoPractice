import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestSnapshot, validateResponse } from '../../src/ai/index.ts';
import { config } from './helpers.ts';
import { policyScenarios } from './policy-scenarios.ts';

for (const row of policyScenarios) test(`${row.id}: ${row.name} [automated fixture; human review pending]`, () => {
  const evaluate = () => validateResponse(row.raw ?? JSON.stringify(row.response), buildRequestSnapshot(row.request, row.context, config()));
  if (row.expected === 'accept') assert.doesNotThrow(evaluate); else assert.throws(evaluate);
});
test('At least 30 policy fixtures exist, and none are mislabeled as human reviewed', () => { assert.ok(policyScenarios.length >= 30); assert.ok(policyScenarios.every(row => row.humanReview === 'pending')); });
