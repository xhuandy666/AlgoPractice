import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { PracticeStore } from '../src/storage/practice-store.ts';
import { archiveDateBoundary } from '../src/shared/archive-date.ts';
import { localDate } from '../src/learning/fsrs.ts';
import type { ProblemContent } from '../src/shared/library.ts';

// Authored synthetic data in an explicitly supplied temporary directory, never a user database.
const [directory, metadataPath] = process.argv.slice(2);
if (!directory || !metadataPath) throw new Error('Pass an isolated data directory and metadata path');
mkdirSync(directory, { recursive: true });
const actualNow = Date.now(), timeZone = 'Asia/Shanghai', today = localDate(new Date(actualNow).toISOString(), timeZone);
const add = (date: string, offset: number) => new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const start = (date: string) => Date.parse(archiveDateBoundary(date, timeZone));
mock.timers.enable({ apis: ['Date'], now: new Date(start(add(today, -12)) + 3600000) });
const clock = (at: number) => mock.timers.setTime(at);
const code = 'class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        return [0, 1]\n';
function content(id: string, title: string, official = false): ProblemContent {
  return { id, title, source: official ? 'leetcode-cn' : 'local', ...(official ? { sourceId: '1', sourceUrl: 'https://leetcode.cn/problems/two-sum/' } : {}),
    difficulty: '简单', tags: [official ? '官方合成验收' : Number(id.split('-').at(-1)) % 2 ? '双指针' : '哈希表'],
    description: '合成验收数据：此题用于验证复习计划与草稿隔离，不是真实学习或官网提交证据。', descriptionFormat: 'plain',
    constraints: ['仅用于合成验收'], mode: 'function', adapter: { method: 'twoSum', params: [{ array: 'int' }, 'int'], returns: { array: 'int' } },
    cases: [{ args: [[2, 7], 9], expected: [0, 1] }], starter: { python: code,
      java: 'class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        return new int[] {0, 1};\n    }\n}\n' } };
}
const store = new PracticeStore(join(directory, 'practice.sqlite'));
try {
  store.updateLearningSettings({ timeZone, dailyReviewBudget: 3, dailyPracticeGoal: 3, aiAutoAnalyzeOfficial: false });
  const ids = Array.from({ length: 37 }, (_, index) => `review-fixture-${index}`);
  for (const [index, id] of ids.entries()) {
    clock(start(add(today, -12)) + 3600000);
    store.upsertProblem(content(id, `复习合成题 ${String(index + 1).padStart(2, '0')}`)); store.addProblemReview(id);
    if (index < 30) {
      clock(start(add(today, -10)) + 3600000);
      store.recordProblemReview({ requestId: `fixture-initial-${index}`, problemId: id, rating: 1 });
      clock(start(add(today, -3)) + 3600000);
      store.recordProblemReview({ requestId: `fixture-review-${index}`, problemId: id, rating: 1 });
      if (index >= 12) store.updateProblemReviews({ problemIds: [id], scheduledAt: new Date(start(add(today, 1 + index % 7))).toISOString() });
    }
  }
  store.updateProblemReviews({ problemIds: [ids[29]], suspended: true });
  const ordinaryCode = `${code}\n# 普通草稿应完整保留\n`;
  store.saveDraft({ problemId: ids[0], language: 'python', scopeId: 'practice', code: ordinaryCode });
  const official = content('leetcode-cn:problem:two-sum', '首次 AC 合成验收题', true); store.upsertProblem(official);
  clock(actualNow);
  store.recordProblemReview({ requestId: 'fixture-reviewed-today', problemId: ids[2], rating: 3 });
  store.recordProblemReview({ requestId: 'fixture-first-assessed-today', problemId: ids[30], rating: 3 });
  const snapshot = store.getReviewPlanSnapshot({ view: 'all', limit: 100 }); store.integrityCheck();
  writeFileSync(metadataPath, JSON.stringify({ synthetic: true, ids, official, code, ordinaryCode, today, timeZone, snapshot }, null, 2));
} finally { store.close(); mock.timers.reset(); }
