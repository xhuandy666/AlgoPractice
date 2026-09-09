import type { Adapter, Language, TestCase } from '../runner/types';
export interface DemoProblem {
  id: string; title: string; topic: string; difficulty: string;
  description: string; constraints: string[];
  mode: 'function' | 'acm'; adapter?: Adapter; cases: TestCase[];
  starter: Record<Language, string>; exampleInput: string; exampleOutput: string;
}
// Independently authored, distributable fixture statements and tests; no remote problem cache.
export const demoProblems: DemoProblem[] = [
  {
    id: 'array-total', title: '数组求和', topic: '数组', difficulty: '基础',
    description: '给定一个整数数组 nums，返回所有元素的和。数组可能为空，也可能包含负数。先写出你的思路，再用右侧的本地用例检查边界。',
    constraints: ['0 ≤ nums.length ≤ 1,000', '−10,000 ≤ nums[i] ≤ 10,000', '空数组的和为 0'],
    mode: 'function', adapter: { method: 'arrayTotal', params: [{ array: 'int' }], returns: 'int' },
    cases: [{ args: [[2, 4, 6]], expected: 12 }, { args: [[]], expected: 0 }, { args: [[-3, 3, 5]], expected: 5 }],
    exampleInput: 'nums = [2, 4, 6]', exampleOutput: '12',
    starter: { python: 'class Solution:\n    def arrayTotal(self, nums: list[int]) -> int:\n        # 在这里写下你的解法\n        return 0\n', java: 'class Solution {\n    public int arrayTotal(int[] nums) {\n        // 在这里写下你的解法\n        return 0;\n    }\n}\n' },
  },
  {
    id: 'mirror-text', title: '反转字符串', topic: '字符串', difficulty: '基础',
    description: '给定字符串 text，返回字符顺序反转后的新字符串。本组样例包含空字符串和中文，输入不包含组合字符或代理对。',
    constraints: ['0 ≤ text.length ≤ 1,000', '本组适配按 Unicode BMP 字符测试'],
    mode: 'function', adapter: { method: 'mirrorText', params: ['string'], returns: 'string' },
    cases: [{ args: ['algorithm'], expected: 'mhtirogla' }, { args: [''], expected: '' }, { args: ['算法练习'], expected: '习练法算' }],
    exampleInput: 'text = "algorithm"', exampleOutput: '"mhtirogla"',
    starter: { python: 'class Solution:\n    def mirrorText(self, text: str) -> str:\n        return text\n', java: 'class Solution {\n    public String mirrorText(String text) {\n        return text;\n    }\n}\n' },
  },
  {
    id: 'sum-stdin', title: '输入输出练习', topic: 'ACM', difficulty: '基础',
    description: '从标准输入读取若干整数，整数之间以空白字符分隔。将它们的和输出到标准输出，最后换行。没有输入时输出 0。',
    constraints: ['输入可能包含多行', '所有数字及总和均在 32 位有符号整数范围内'],
    mode: 'acm', cases: [{ stdin: '2 4 6\n', expected: '12\n' }, { stdin: '-1\n1 5\n', expected: '5\n' }, { stdin: '', expected: '0\n' }],
    exampleInput: '2 4 6', exampleOutput: '12',
    starter: { python: 'import sys\n\n# 从 sys.stdin 读取输入\nprint(0)\n', java: 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner input = new Scanner(System.in);\n        System.out.println(0);\n    }\n}\n' },
  },
];
