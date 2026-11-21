import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityDay, ArchiveStatistics } from '../../src/shared/learning.ts';
import { achievementNextStep, growthDistance, rankLadder } from '../../src/renderer/growth-guidance.ts';
import { dayXp, levelStartXp, rewardProfile, xpSources, XP_RULES } from '../../src/renderer/rewards.ts';
import { reviewSessionSummary } from '../../src/renderer/review-session.ts';

const day = (date: string, values: Partial<ActivityDay> = {}): ActivityDay => ({ date, activeMs: 0, attempts: 0, completedProblems: 0, runs: 0, passedRuns: 0, practiceRuns: 0, officialAccepted: 0, reviewCount: 0, ...values });
const stats = (days: ActivityDay[], totals: Partial<ArchiveStatistics> = {}): ArchiveStatistics => ({ activeMs: days.reduce((sum, row) => sum + row.activeMs, 0), attempts: 0, runs: 0, passedRuns: 0, reviewedItems: 0, solvedProblems: 0, officialSolvedProblems: 0, days, ...totals });
const badge = (profile: ReturnType<typeof rewardProfile>, id: string) => profile.achievements.find(item => item.id === id)!;

test('the experience breakdown is the definition of the daily total, with every source capped separately', () => {
  const busy = day('2026-11-19', { officialAccepted: 12, passedRuns: 3, practiceRuns: 40, completedProblems: 2, reviewCount: 11, activeMs: 90 * 60000 });
  const sources = xpSources(busy);
  assert.deepEqual(sources.map(source => [source.id, source.count, source.counted, source.xp]), [
    ['officialAccepted', 12, 10, 300], ['passedRun', 3, 3, 30], ['practiceRun', 40, 30, 60], ['completedProblem', 2, 2, 30], ['review', 11, 10, 250], ['activeMinute', 90, 90, 90]]);
  assert.equal(dayXp(busy), sources.reduce((sum, source) => sum + source.xp, 0));
  assert.equal(sources.find(source => source.id === 'review')!.unit, XP_RULES.review);
  assert.deepEqual(xpSources().map(source => source.xp), [0, 0, 0, 0, 0, 0]);
  const profile = rewardProfile(stats([busy]), '2026-11-19');
  assert.equal(profile.todaySources.reduce((sum, source) => sum + source.xp, 0), profile.todayXp);
  assert.equal(rewardProfile(stats([busy]), '2026-11-20').todaySources.every(source => source.xp === 0), true, 'a day without a record has an all-zero breakdown');
});

test('the ladder shows every tier with its starting experience and separates the next level from the next tier', () => {
  const xp = levelStartXp(15) + 400, profile = rewardProfile(stats([], {}), '2026-11-19');
  assert.deepEqual(rankLadder(profile).map(step => [step.tier.name, step.tier.minLevel, step.state]), [
    ['青铜', 1, 'current'], ['白银', 3, 'next'], ['黄金', 6, 'ahead'], ['铂金', 10, 'ahead'], ['钻石', 15, 'ahead'], ['大师', 20, 'ahead'], ['王者', 30, 'ahead']]);
  const diamond = { xp, nextLevelXp: levelStartXp(16), rank: { id: 'diamond' as const, name: '钻石', minLevel: 15 }, nextRank: { id: 'master' as const, name: '大师', minLevel: 20 } };
  assert.deepEqual(rankLadder(diamond).map(step => step.state), ['reached', 'reached', 'reached', 'reached', 'current', 'next', 'ahead']);
  assert.deepEqual(rankLadder(diamond).map(step => step.xp), [1, 3, 6, 10, 15, 20, 30].map(levelStartXp));
  assert.deepEqual(growthDistance(diamond), { nextLevel: levelStartXp(16) - xp, nextRank: levelStartXp(20) - xp });
  const king = { xp: levelStartXp(31), nextLevelXp: levelStartXp(32), rank: { id: 'king' as const, name: '王者', minLevel: 30 }, nextRank: null };
  assert.equal(growthDistance(king).nextRank, null); assert.equal(rankLadder(king).at(-1)!.state, 'current');
});

test('a locked badge says what is missing and offers the action that moves it', () => {
  const idle = { planned: 0, ongoing: false };
  const profile = rewardProfile(stats([day('2026-11-18', { runs: 1, practiceRuns: 1, activeMs: 10 * 60000 })], { reviewedItems: 8, solvedProblems: 3 }), '2026-11-19');
  const review = badge(profile, 'review-10'); assert.equal(review.progress, 8); assert.equal(review.metric, 'reviewedItems');
  assert.deepEqual(achievementNextStep(review, profile, { planned: 2, ongoing: false }), { hint: '还差 2 道不同的题目。同一道题重复复习只计一次，第一次自评不计入。', action: 'review', label: '开始今日复习（2 题）' });
  assert.equal(achievementNextStep(review, profile, { planned: 2, ongoing: true }).label, '继续本轮复习');
  const noDue = achievementNextStep(review, profile, idle); assert.equal(noDue.action, 'review-plan'); assert.match(noDue.hint, /今天没有到期的复习/);
  const solve = achievementNextStep(badge(profile, 'pass-10'), profile, idle); assert.equal(solve.action, 'browse'); assert.match(solve.hint, /还差 7 道不同的题目.*自己填写的期望输出跑通不算/);
  assert.match(achievementNextStep(badge(profile, 'official-first'), profile, idle).hint, /提交到力扣/);
  const streak = achievementNextStep(badge(profile, 'streak-3'), profile, idle); assert.equal(streak.action, 'browse'); assert.match(streak.hint, /已连续学习 1 天，今天完成学习即可延续/);
  assert.deepEqual(achievementNextStep(badge(profile, 'first-pass'), profile, idle), { hint: '已解锁。', action: null, label: '' });

  const today = rewardProfile(stats([day('2026-11-19', { runs: 1, practiceRuns: 1, activeMs: 25 * 60000 })]), '2026-11-19');
  assert.equal(achievementNextStep(badge(today, 'streak-3'), today, idle).action, null, 'nothing more to do today once the day already counts');
  assert.match(achievementNextStep(badge(today, 'focus-60'), today, idle).hint, /今天已有 25 分钟/);
  assert.equal(achievementNextStep(badge(today, 'days-30'), today, idle).action, null);
  assert.match(achievementNextStep(badge(today, 'hours-10'), today, idle).hint, /还差 10 小时/);
  for (const item of today.achievements) { const step = achievementNextStep(item, today, idle); assert.ok(step.hint.length > 0); assert.equal(Boolean(step.action), Boolean(step.label)); }
});

test('the end of a review round reports rated, skipped and remaining problems from the session', () => {
  const session = (position: number, skipped: string[], rated: string[]) => ({ problemIds: ['a', 'b', 'c', 'd'], position, skippedProblemIds: skipped, ratedProblemIds: rated });
  assert.equal(reviewSessionSummary(session(4, [], ['a', 'b', 'c', 'd']), true), '本轮复习完成：新增自评 4 题。题目当前安排与状态请查看复习计划。');
  assert.equal(reviewSessionSummary(session(4, ['b'], ['a', 'c', 'd']), true), '本轮复习完成：新增自评 3 题，跳过 1 题。题目当前安排与状态请查看复习计划。');
  assert.equal(reviewSessionSummary(session(2, ['a'], ['b']), false), '本轮复习已结束：新增自评 1 题，跳过 1 题，另有 2 题未在本轮新增自评。题目当前安排与状态请查看复习计划。');
  assert.equal(reviewSessionSummary(session(0, [], []), false), '本轮复习已结束：新增自评 0 题，另有 4 题未在本轮新增自评。题目当前安排与状态请查看复习计划。');
  assert.match(reviewSessionSummary(session(4, ['a'], []), true), /新增自评 0 题，跳过 1 题，另有 3 题未在本轮新增自评/, 'automatically bypassed items are neither ratings nor a claim that they are still due');
  assert.match(reviewSessionSummary(session(0, [], ['a']), false), /新增自评 1 题/, 'a rating committed before ending counts even if the queue was not manually advanced');
});
