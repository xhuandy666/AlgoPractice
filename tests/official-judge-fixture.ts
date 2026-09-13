import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PracticeStore } from '../src/storage/practice-store.ts';
import type { ProblemContent } from '../src/shared/library.ts';

// Authored fixture only. Source metadata exercises the protocol gate; no problem content is downloaded.
const [directory, metadataPath] = process.argv.slice(2);
if (!directory || !metadataPath) throw new Error('Pass an isolated data directory and fixture metadata path');
mkdirSync(directory, { recursive: true });
const code = 'class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        return [0, 1]\n';
const problem: ProblemContent = {
  id: 'leetcode-cn:problem:two-sum', source: 'leetcode-cn', sourceId: '1',
  sourceUrl: 'https://leetcode.cn/problems/two-sum/', title: '官方提交合成验收题', difficulty: '简单', tags: ['合成验收'],
  description: '合成测试：给定数组及目标和，返回满足条件的两个不同位置。这里的数据只用于界面与提交协议验收。',
  descriptionFormat: 'plain', constraints: ['恰好有一个解'], mode: 'function',
  adapter: { method: 'twoSum', params: [{ array: 'int' }, 'int'], returns: { array: 'int' } },
  cases: [{ args: [[2, 7, 11, 15], 9], expected: [0, 1] }, { args: [[3, 2, 4], 6], expected: [1, 2] }],
  starter: { python: code, java: 'class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        return new int[] {0, 1};\n    }\n}\n' },
};
const store = new PracticeStore(join(directory, 'practice.sqlite'));
try {
  store.upsertProblem(problem);
  writeFileSync(metadataPath, JSON.stringify({ synthetic: true, problem, code }, null, 2));
  store.integrityCheck();
} finally { store.close(); }
