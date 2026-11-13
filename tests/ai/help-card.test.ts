import test from 'node:test';
import assert from 'node:assert/strict';
import { helpCardDecision } from '../../src/ai/index.ts';
import type { AiHelpRun } from '../../src/shared/ai.ts';

const run = (id: string, status = 'wrong_answer'): AiHelpRun => ({ id, attemptId: 'a', status, executed: true, attributableToUser: true, trustworthyExpected: true });
const decide = (runs: AiHelpRun[], extra = {}) => helpCardDecision({ attemptId: 'a', mode: 'practice', isActive: true, runs, state: { automaticShownAt: null, dismissedAt: null }, ...extra });
test('Third attributable failed test shows one help card without any model dependency', () => { assert.equal(decide([run('1'), run('2')]).show, false); assert.deepEqual(decide([run('1'), run('2'), run('3')]), { show: true, reason: 'three-failures', consecutiveFailures: 3 }); });
test('A compile or syntax error is one failure in the streak, not a card of its own; runner errors are excluded', () => {
  const compile = { ...run('1', 'compile_error'), executed: false };
  assert.deepEqual(decide([compile]), { show: false, reason: null, consecutiveFailures: 1 }, 'one routine compile error does not use up the one suggestion');
  assert.deepEqual(decide([compile, run('2', 'runtime_error'), run('3')]), { show: true, reason: 'three-failures', consecutiveFailures: 3 },
    'a compile error, a Python syntax error (a runtime error) and a wrong answer are three failures in a row');
  assert.equal(decide([{ ...compile, attributableToUser: false }, run('2'), run('3')]).show, false, 'an adapter compile failure is not the user\'s');
});
test('Cancellation, environment/adapter failures and output-only completions neither count nor clear the streak', () => { const excluded = ['cancelled', 'environment_error', 'invalid_request', 'internal_error', 'interrupted', 'completed'].map((status, index) => ({ ...run(`excluded-${index}`, status), trustworthyExpected: false })); const result = decide([run('1'), run('2'), ...excluded, run('3')]); assert.equal(result.show, true); assert.equal(result.consecutiveFailures, 3); });
test('Trustworthy passing tests clear the streak; editing has no reset input', () => { assert.equal(decide([run('1'), run('2'), run('3', 'passed'), run('4')]).consecutiveFailures, 1); assert.equal(decide([run('1'), { ...run('2', 'passed'), trustworthyExpected: false }, run('3'), run('4')]).consecutiveFailures, 3); });
test('Runtime exceptions and timeouts count as real user-program failures without inventing expected values', () => { const result = decide(['runtime_error', 'timeout', 'output_limit'].map((status, index) => ({ ...run(String(index), status), trustworthyExpected: false }))); assert.equal(result.show, true); assert.equal(result.consecutiveFailures, 3); });
test('Strict mode, ended attempts, already shown or dismissed cards are suppressed', () => { const runs = [run('1'), run('2'), run('3')]; assert.equal(decide(runs, { mode: 'strict' }).show, false); assert.equal(decide(runs, { isActive: false }).show, false); assert.equal(decide(runs, { state: { automaticShownAt: 'shown', dismissedAt: null } }).show, false); assert.equal(decide(runs, { state: { automaticShownAt: null, dismissedAt: 'dismissed' } }).show, false); });
test('Duplicate and foreign Attempt runs cannot inflate the failure count', () => { const result = decide([run('1'), run('1'), { ...run('2'), attemptId: 'foreign' }, run('3')]); assert.equal(result.consecutiveFailures, 2); assert.equal(result.show, false); });
