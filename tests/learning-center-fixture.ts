import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mock } from 'node:test';
import { PracticeStore } from '../src/storage/practice-store.ts';
import { archiveDateBoundary } from '../src/shared/archive-date.ts';
import { localDate } from '../src/learning/fsrs.ts';
import type { ProblemContent } from '../src/shared/library.ts';

// This fixture is authored test data in an explicitly supplied temporary directory. No user records.
const [directory, metadataPath] = process.argv.slice(2);
if (!directory || !metadataPath) throw new Error('Pass a temporary data directory and fixture metadata path');
mkdirSync(directory, { recursive: true });
const timeZone = 'Asia/Shanghai', actualNow = Date.now(), today = localDate(new Date(actualNow).toISOString(), timeZone);
const add = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const instant = (date: string, minutes = 9 * 60) => Date.parse(archiveDateBoundary(date, timeZone)) + minutes * 60000;
mock.timers.enable({ apis: ['Date'], now: new Date(instant(add(today, -365))) });
const clock = (at: number) => mock.timers.setTime(at);
const store = new PracticeStore(join(directory, 'practice.sqlite'));
const code = 'class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        seen = {}\n        for index, value in enumerate(nums):\n            remaining = target - value\n            if remaining in seen:\n                return [seen[remaining], index]\n            seen[value] = index\n        return []\n';
const titles = ['两数之和', '二分查找', '有效的括号', '买卖股票的最佳时机', '反转链表', '合并有序数组', '最长连续序列', '岛屿数量'];
const ids = titles.map((_, i) => `learning-smoke-${i}`);
const problems = titles.map((title, i): ProblemContent => ({
  id: ids[i], title, difficulty: i < 5 ? '简单' : '中等', tags: [i % 2 ? '双指针' : '哈希表'], source: 'local',
  ...(i === 0 ? { sourceUrl: 'https://leetcode.cn/problems/two-sum/' } : {}),
  description: i === 0 ? '给定整数数组 nums 和目标值 target，返回两个不同位置的下标，使对应数值的和等于 target。\n\n每组输入都有一个解。可以按任意顺序返回两个下标。\n\n示例\n输入：nums = [2, 7, 11, 15]，target = 9\n输出：[0, 1]\n解释：nums[0] + nums[1] = 9。' : '这是一道用于桌面体验验收的本地合成题目。记录已结束的练习，并检验复习与归档是否保持一致。',
  descriptionFormat: 'plain', constraints: ['2 ≤ nums.length ≤ 10⁴', '同一个元素不能重复使用'], mode: 'function',
  adapter: { method: 'twoSum', params: [{ array: 'int' }, 'int'], returns: { array: 'int' } },
  cases: [{ args: [[2, 7, 11, 15], 9], expected: [0, 1] }, { args: [[3, 2, 4], 6], expected: [1, 2] }],
  starter: { python: code, java: 'class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        return new int[] {0, 1};\n    }\n}\n' },
}));
try {
  const versions = problems.map(problem => store.upsertProblem(problem).version);
  store.updateLearningSettings({ timeZone, dailyPracticeGoal: 5, dailyReviewBudget: null });
  let sequence = 0;
  function practice(day: string, problemIndex: number, offset = 0) {
    const start = Math.min(instant(day, 9 * 60 + offset), actualNow - 20 * 60000);
    clock(start);
    const attempt = store.startAttempt({ problemId: ids[problemIndex], problemVersion: versions[problemIndex], language: 'python' });
    for (let pulse = 1; pulse <= 24; pulse++) {
      const at = start + pulse * 30000; clock(at);
      store.recordActivity({ requestId: `fixture-pulse-${++sequence}`, attemptId: attempt.id, durationMs: 30000, occurredAt: new Date().toISOString() });
    }
    clock(start + 13 * 60000); store.finishAttempt(attempt.id, { code }); return attempt;
  }
  // Rich but explicitly synthetic daily history, with gaps and varying daily completion counts.
  for (let daysAgo = 180; daysAgo >= 1; daysAgo--) {
    if (daysAgo % 7 === 0 || daysAgo % 11 === 0) continue;
    const count = (daysAgo * 13 % 5) + 1;
    for (let i = 0; i < count; i++) practice(add(today, -daysAgo), (daysAgo + i) % ids.length, i * 15);
  }
  practice(today, 1); practice(today, 4, 20);
  const yesterday = add(today, -1), crossStart = instant(today, 0) - 12000;
  clock(crossStart);
  const crossing = store.startAttempt({ problemId: ids[7], problemVersion: versions[7], language: 'python' });
  clock(crossStart + 20000);
  store.recordActivity({ requestId: 'cross-midnight', attemptId: crossing.id, durationMs: 20000, occurredAt: new Date().toISOString() });
  clock(crossStart + 30000); store.finishAttempt(crossing.id, { code });
  clock(actualNow);
  const pending = store.addReviewItem({ problemId: ids[0], target: 'rewrite', language: 'python', now: new Date(instant(add(today, -2))).toISOString() });
  const paused = store.addReviewItem({ problemId: ids[2], target: 'understanding', language: 'none', now: new Date(instant(add(today, -4))).toISOString() });
  store.setReviewPlan(paused.id, { suspended: true });
  const completed = store.addReviewItem({ problemId: ids[4], target: 'rewrite', language: 'python', now: new Date(instant(add(today, -7))).toISOString() });
  store.recordReview({ requestId: 'completed-today', itemId: completed.id, rating: 4, reviewedAt: new Date(Math.max(instant(today, 0), actualNow - 3600000)).toISOString() });
  const previousMonth = add(today.slice(0, 8) + '01', -1);
  const previous = store.addReviewItem({ problemId: ids[5], target: 'understanding', language: 'none', now: new Date(instant(add(previousMonth, -7))).toISOString() });
  store.recordReview({ requestId: 'completed-last-month', itemId: previous.id, rating: 4, reviewedAt: new Date(instant(previousMonth)).toISOString() });
  store.setReviewPlan(previous.id, { scheduledAt: new Date(instant(add(today, 8))).toISOString() });
  for (const [problemIndex, offset] of [[1, 2], [3, 4], [6, 6], [7, 11]]) {
    const item = store.addReviewItem({ problemId: ids[problemIndex], target: 'rewrite', language: problemIndex === 3 ? 'java' : 'python', now: new Date(instant(add(today, -1))).toISOString() });
    store.setReviewPlan(item.id, { scheduledAt: new Date(instant(add(today, offset))).toISOString() });
  }
  const settings = store.getLearningSettings(), dashboard = store.getLearningDashboard();
  mkdirSync(dirname(metadataPath), { recursive: true });
  writeFileSync(metadataPath, JSON.stringify({ synthetic: true, today, yesterday, month: today.slice(0, 7), previousMonth: previousMonth.slice(0, 7), timeZone,
    pending, paused, completed, crossing: { id: crossing.id, title: titles[7], startedAt: crossing.startedAt },
    official: { problemId: ids[0], title: titles[0], url: problems[0].sourceUrl, code }, settings, dashboard,
  }, null, 2));
  store.integrityCheck();
} finally { store.close(); mock.timers.reset(); }
