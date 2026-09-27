import assert from 'node:assert/strict';
import test from 'node:test';
import { RunPreparations } from '../../src/desktop/run-preparation';

test('prepared code is one-shot, identity-bound and only lives in this process', () => {
  const intents = new RunPreparations(); let releases = 0;
  const token = intents.create('problem/version/lang/format/spec/scope/revision/code/tests', () => releases++);
  assert.throws(() => intents.assertCurrent(token, 'changed-input'), /重新点击/);
  intents.assertCurrent(token, 'problem/version/lang/format/spec/scope/revision/code/tests');
  intents.consume(token, 'problem/version/lang/format/spec/scope/revision/code/tests');
  assert.equal(releases, 1);
  assert.throws(() => intents.consume(token, 'problem/version/lang/format/spec/scope/revision/code/tests'));
  assert.throws(() => new RunPreparations().assertCurrent(token, 'anything'));
});
test('replacement, explicit cancellation and expiry prevent delayed continuation', () => {
  let time = 0; let releases = 0; const intents = new RunPreparations(() => time);
  const first = intents.create('one', () => releases++);
  const second = intents.create('two', () => releases++);
  assert.equal(releases, 1);
  intents.cancel(first); intents.assertCurrent(second, 'two');
  time = 30 * 60_000 + 1;
  assert.throws(() => intents.assertCurrent(second, 'two'));
  intents.cancel(); intents.cancel(); assert.equal(releases, 2);
});
