import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesignAdapter } from '../../src/runner/types.ts';
import { designStepRows } from '../../src/renderer/design-steps.ts';

const lru: DesignAdapter = { kind: 'design', className: 'LRUCache', constructorParams: ['int'], methods: [{ name: 'get', params: ['int'], returns: 'int' }, { name: 'put', params: ['int', 'int'], returns: 'void' }] };
const args = [['LRUCache', 'put', 'get', 'get'], [[2], [1, 1], [1], [2]]];

test('design steps pair each call with its value and flag only differing returns', () => {
  const rows = designStepRows(lru, args, [null, null, 1, 5], [null, null, 1, -1])!;
  assert.deepEqual(rows.map(row => row.call), ['LRUCache(2)', 'put(1, 1)', 'get(1)', 'get(2)']);
  assert.deepEqual(rows.map(row => row.differs), [false, false, false, true]);
  assert.deepEqual([rows[3].actual, rows[3].reference], [5, -1]);
  assert.equal(rows[1].returns, false, 'void calls show no value');
});

test('steps still list the calls when a run produced no output or nothing to compare with', () => {
  const crashed = designStepRows(lru, args, undefined, [null, null, 1, -1])!;
  assert.deepEqual(crashed.map(row => [row.actual, row.differs]), [[undefined, false], [undefined, false], [undefined, false], [undefined, false]]);
  assert.equal(designStepRows(lru, args, [null, null, 1, -1], undefined)!.some(row => row.differs), false);
  assert.equal(designStepRows(lru, [['MinStack'], [[]]], [null], undefined), null, 'a case that does not fit the adapter shows no steps');
  const strings = designStepRows({ kind: 'design', className: 'Trie', constructorParams: [], methods: [{ name: 'search', params: ['string'], returns: 'boolean' }] }, [['Trie', 'search'], [[], ['a"b']]], [null, true], [null, false])!;
  assert.equal(strings[1].call, 'search("a\\"b")'); assert.equal(strings[1].differs, true);
});
