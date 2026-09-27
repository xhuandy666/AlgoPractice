import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPracticeFormat } from '../../src/desktop/practice-format';

test('an omitted format falls back from a stale function preference without an active attempt', () => {
  assert.equal(selectPracticeFormat('acm', 'function', undefined, () => false), 'acm');
});

test('an active function attempt remains bound to its immutable original format', () => {
  assert.equal(selectPracticeFormat('acm', 'function', undefined, () => true), 'function');
});

test('explicit selections are not silently replaced by a preference fallback', () => {
  const unused = () => { throw new Error('active lookup must not override an explicit selection'); };
  assert.equal(selectPracticeFormat('acm', 'function', 'function', unused), 'function');
  assert.equal(selectPracticeFormat('acm', 'function', 'acm', unused), 'acm');
  assert.throws(() => selectPracticeFormat('acm', 'function', 'unknown', unused), /答题格式无效/);
});

test('native defaults and supported preferences do not need an active-attempt lookup', () => {
  const unused = () => { throw new Error('unnecessary active lookup'); };
  assert.equal(selectPracticeFormat('acm', undefined, undefined, unused), 'acm');
  assert.equal(selectPracticeFormat('function', undefined, undefined, unused), 'function');
  assert.equal(selectPracticeFormat('function', 'acm', undefined, unused), 'acm');
});
