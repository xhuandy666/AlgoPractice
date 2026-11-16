import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Adapter } from '../../src/runner/types.ts';
import type { ProblemContent } from '../../src/shared/library.ts';
import { compareWithExample, statementExampleOutputs, templateParameterNames } from '../../src/source/statement-examples.ts';

test('parameter names come from the first starter template that parses unambiguously', () => {
  assert.deepEqual(templateParameterNames({ python: 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        ' }, 'twoSum', 2), ['nums', 'target']);
  assert.deepEqual(templateParameterNames({ python: 'class Solution:\n    def f(self, grid: List[List[str]], k: int) -> int:' }, 'f', 2), ['grid', 'k']);
  assert.deepEqual(templateParameterNames({ java: 'class Solution {\n    public List<List<Integer>> f(Map<String, Integer> counts, int k[]) {\n    }\n}' }, 'f', 2), ['counts', 'k'], 'generic commas and C-style arrays');
  assert.deepEqual(templateParameterNames({ go: 'func f(a, b int, words []string) int {\n}' }, 'f', 3), ['a', 'b', 'words'], 'Go groups parameters that share a type');
  assert.deepEqual(templateParameterNames({ cpp: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n    }\n};' }, 'twoSum', 2), ['nums', 'target']);
  assert.deepEqual(templateParameterNames({ python: 'def other(self, x): pass', java: 'class Solution { public int f(int value) { } }' }, 'f', 1), ['value'], 'a template without the method is skipped');
  assert.equal(templateParameterNames({ python: 'class Solution:\n    def f(self, a: int) -> int:' }, 'f', 2), null, 'count must match the adapter');
  assert.equal(templateParameterNames({}, 'f', 1), null);
  assert.equal(templateParameterNames({ python: 'def f(self, a): pass' }, 'f(.*', 1), null, 'method names are identifiers, never patterns');
});

const adapter: Adapter = { method: 'twoSum', params: [{ array: 'int' }, 'int'], returns: { array: 'int' } };
function content(overrides: Partial<ProblemContent> = {}): ProblemContent {
  return { id: 'leetcode-cn:problem:two-sum', title: '两数之和', difficulty: '简单', tags: [], source: 'leetcode-cn', sourceUrl: 'https://leetcode.cn/problems/two-sum/', sourceId: '1',
    description: '<p>给定一个整数数组。</p><p><strong class="example">示例 1：</strong></p><pre><strong>输入：</strong>nums = [2,7,11,15], target = 9\n<strong>输出：</strong>[0,1]\n<strong>解释：</strong>因为 nums[0] + nums[1] == 9 。</pre>'
      + '<p><strong class="example">示例 2：</strong></p><pre><strong>输入：</strong>nums = [3,2,4], target = 6\n<strong>输出：</strong>[1,2]</pre><p><strong>提示：</strong></p><ul><li>2 &lt;= nums.length</li></ul>',
    descriptionFormat: 'html', constraints: [], mode: 'function', adapter,
    cases: [{ args: [[2, 7, 11, 15], 9] }, { args: [[3, 2, 4], 6] }, { args: [[1, 1], 2] }],
    starter: { python: 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        ' }, ...overrides };
}

test('statement examples are recovered from stored content for exactly the matching cases', () => {
  assert.deepEqual(statementExampleOutputs(content()), [[0, 1], [1, 2], undefined], 'a case without a statement example stays unknown');
  assert.deepEqual(statementExampleOutputs(content({ starter: { go: 'func twoSum(nums []int, target int) []int {\n}' } })), [[0, 1], [1, 2], undefined]);
  assert.equal(statementExampleOutputs(content({ descriptionFormat: 'plain' })), null);
  assert.equal(statementExampleOutputs(content({ mode: 'acm' })), null);
  assert.equal(statementExampleOutputs(content({ adapter: undefined })), null);
  assert.equal(statementExampleOutputs(content({ starter: {} })), null, 'without parameter names the inputs cannot be matched');
  assert.equal(statementExampleOutputs(content({ description: '<p>没有示例。</p>' })), null);
});

test('comparison with an example is a hint: exact, unordered, float tolerance and normalized values', () => {
  assert.equal(compareWithExample([0, 1], [0, 1], adapter), 'match');
  assert.equal(compareWithExample([1, 0], [0, 1], adapter), 'unordered');
  assert.equal(compareWithExample([0, 2], [0, 1], adapter), 'different');
  assert.equal(compareWithExample(undefined, [0, 1], adapter), 'different');
  const float: Adapter = { method: 'f', params: ['int'], returns: 'float' };
  assert.equal(compareWithExample(2.000001, 2, float), 'match');
  assert.equal(compareWithExample(2.1, 2, float), 'different');
  const wide: Adapter = { method: 'f', params: ['int'], returns: 'int64' };
  assert.equal(compareWithExample('9007199254740993', '9007199254740993', wide), 'match');
  assert.equal(compareWithExample('not a number', '1', wide), 'different', 'malformed output is different, never an exception');
  const tree: Adapter = { method: 'f', params: ['treenode'], returns: 'treenode' };
  assert.equal(compareWithExample([1, 2, null], [1, 2], tree), 'match', 'trailing nulls do not change a tree');
  const inPlace: Adapter = { method: 'sortColors', params: [{ array: 'int' }], returns: 'void', inPlaceArg: 0 };
  assert.equal(compareWithExample([2, 0, 1], [0, 1, 2], inPlace), 'different', 'an untouched in-place array is wrong, not merely unordered');
  assert.equal(compareWithExample([0, 1, 2], [0, 1, 2], inPlace), 'match');
});
