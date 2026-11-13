import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityDay, ArchiveStatistics } from '../../src/shared/learning.ts';
import { activityStreak, dayXp, firstTimeChanges, levelForXp, levelStartXp, longestStreak, markProfile, profileChanges, rankForLevel, rewardProfile, XP_RULES } from '../../src/renderer/rewards.ts';

const day = (date: string, values: Partial<ActivityDay> = {}): ActivityDay => ({ date, activeMs: 0, attempts: 0, completedProblems: 0, runs: 0, passedRuns: 0, practiceRuns: 0, officialAccepted: 0, reviewCount: 0, ...values });
const sum = (days: ActivityDay[], key: 'activeMs' | 'attempts' | 'runs' | 'passedRuns' | 'reviewCount') => days.reduce((total, row) => total + row[key], 0);
const stats = (days: ActivityDay[], solved: Partial<Pick<ArchiveStatistics, 'solvedProblems' | 'officialSolvedProblems'>> = {}): ArchiveStatistics => ({
  days, activeMs: sum(days, 'activeMs'), attempts: sum(days, 'attempts'), runs: sum(days, 'runs'), passedRuns: sum(days, 'passedRuns'),
  reviewedItems: sum(days, 'reviewCount'), solvedProblems: 0, officialSolvedProblems: 0, ...solved,
});

test('daily experience rewards official Accepted, passes, practice runs, completed practices, reviews and focus time, with caps', () => {
  assert.equal(dayXp(day('2026-11-01', { officialAccepted: 1, passedRuns: 2, practiceRuns: 3, runs: 5, attempts: 3, completedProblems: 1, reviewCount: 1, activeMs: 30 * 60000 })),
    30 + 2 * 10 + 3 * 2 + 15 + 25 + 30);
  assert.equal(dayXp(day('2026-11-01', { attempts: 50 })), 0, 'opening problems without finishing them earns nothing');
  assert.equal(dayXp(day('2026-11-01', { runs: 9 })), 0, 'cancelled, interrupted or environment-failed runs never ran the code and earn nothing');
  assert.equal(dayXp(day('2026-11-01', { passedRuns: 500, runs: 500 })), XP_RULES.passedRunDailyCap * XP_RULES.passedRun, 'passes beyond the daily cap earn nothing more');
  assert.equal(dayXp(day('2026-11-01', { reviewCount: 40 })), XP_RULES.reviewDailyCap * XP_RULES.review, 'self-ratings beyond the daily cap earn nothing more');
  for (const [source, points] of Object.entries(XP_RULES).filter(([key]) => !key.endsWith('DailyCap'))) assert.ok(`${source}DailyCap` in XP_RULES, `${source} (${points} XP each) has a daily cap`);
  assert.equal(dayXp(day('2026-11-01', { practiceRuns: 500, runs: 500 })), XP_RULES.practiceRunDailyCap * XP_RULES.practiceRun);
  assert.equal(dayXp(day('2026-11-01', { officialAccepted: 50 })), XP_RULES.officialAcceptedDailyCap * XP_RULES.officialAccepted);
  assert.equal(dayXp(day('2026-11-01', { activeMs: 10 * 3600000 })), XP_RULES.activeMinuteDailyCap);
});

test('level thresholds grow by 100 per level and ranks follow levels', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(levelStartXp), [0, 200, 500, 900, 1400]);
  assert.equal(levelForXp(0), 1); assert.equal(levelForXp(199), 1); assert.equal(levelForXp(200), 2); assert.equal(levelForXp(1399), 4);
  assert.deepEqual([1, 3, 6, 10, 15, 20, 30, 99].map(level => rankForLevel(level).name), ['青铜', '白银', '黄金', '铂金', '钻石', '大师', '王者', '王者']);
});

test('streak continues from yesterday until today is active, and the longest run is remembered', () => {
  const days = [day('2026-10-20', { activeMs: 1 }), day('2026-10-21', { completedProblems: 1 }), day('2026-10-22', { reviewCount: 1 }), day('2026-11-02', { activeMs: 1 }), day('2026-11-03', { completedProblems: 1 })];
  assert.equal(activityStreak(days, '2026-11-03'), 2);
  assert.equal(activityStreak(days, '2026-11-04'), 2, 'an untouched today keeps yesterday\'s streak');
  assert.equal(activityStreak(days, '2026-11-05'), 0);
  assert.equal(longestStreak(days), 3);
  assert.equal(activityStreak([day('2026-11-03')], '2026-11-03'), 0, 'an all-zero row is not activity');
  assert.equal(activityStreak([day('2026-11-03', { attempts: 1 })], '2026-11-03'), 0, 'opening a problem is not a check-in, matching the learning center');
});

test('profile reports level progress, today experience and achievements from durable statistics', () => {
  const profile = rewardProfile(stats([day('2026-11-03', { passedRuns: 1, runs: 1, attempts: 1, completedProblems: 1, activeMs: 65 * 60000 })], { solvedProblems: 1 }), '2026-11-03');
  assert.equal(profile.xp, 10 + 15 + 65); assert.equal(profile.todayXp, profile.xp);
  assert.equal(profile.level, 1); assert.equal(profile.nextLevelXp, 200); assert.equal(profile.levelProgress, 90 / 200);
  assert.equal(profile.rank.name, '青铜'); assert.equal(profile.nextRank?.name, '白银');
  assert.equal(profile.streak, 1); assert.equal(profile.activeToday, true);
  const unlocked = profile.achievements.filter(item => item.unlocked).map(item => item.id);
  assert.deepEqual(unlocked, ['first-pass', 'focus-60']);
  assert.equal(profile.achievements.find(item => item.id === 'pass-10')?.progress, 1);
  assert.equal(profile.totals.solvedProblems, 1);
  assert.equal(rewardProfile(stats([]), '2026-11-03').todayXp, 0);
});

test('solving achievements count distinct problems, so re-running or re-submitting one problem cannot farm them', () => {
  const farmed = rewardProfile(stats([day('2026-11-03', { passedRuns: 500, runs: 500 })], { solvedProblems: 1 }), '2026-11-03');
  const unlocked = farmed.achievements.filter(item => item.unlocked).map(item => item.id);
  assert.ok(unlocked.includes('first-pass'));
  assert.ok(!unlocked.includes('pass-10') && !unlocked.includes('pass-100'), '500 passes of one problem are still one solved problem');
  assert.equal(farmed.achievements.find(item => item.id === 'pass-100')?.progress, 1);
  const official = rewardProfile(stats([day('2026-11-03', { officialAccepted: 1, completedProblems: 1 })], { solvedProblems: 1, officialSolvedProblems: 1 }), '2026-11-03');
  assert.deepEqual(official.achievements.filter(item => item.unlocked).map(item => item.id), ['first-pass', 'official-first'],
    'an official Accepted solves a problem even when it has no locally verifiable expected output');
  assert.equal(official.todayXp, XP_RULES.officialAccepted + XP_RULES.completedProblem);
});

test('only forward progress produces celebrations', () => {
  const before = rewardProfile(stats([day('2026-11-01', { runs: 1, practiceRuns: 1, activeMs: 1 }), day('2026-11-02', { runs: 1, practiceRuns: 1, activeMs: 1 })]), '2026-11-03');
  const after = rewardProfile(stats([day('2026-11-01', { runs: 1, practiceRuns: 1, activeMs: 1 }), day('2026-11-02', { runs: 1, practiceRuns: 1, activeMs: 1 }), day('2026-11-03', { passedRuns: 20, runs: 20, completedProblems: 1 })], { solvedProblems: 10 }), '2026-11-03');
  const kinds = profileChanges(before, after).map(change => change.kind);
  assert.deepEqual(kinds, ['xp', 'level-up', 'achievement', 'achievement', 'achievement', 'streak']);
  assert.deepEqual(profileChanges(after, before), [], 'a restore that lowers totals stays silent');
  assert.deepEqual(profileChanges(after, after), []);
});

test('levels and achievements are celebrated only the first time they are reached', () => {
  const low = rewardProfile(stats([day('2026-11-01', { runs: 1, practiceRuns: 1, activeMs: 1 }), day('2026-11-02', { runs: 1, practiceRuns: 1, activeMs: 1 })]), '2026-11-03');
  const high = rewardProfile(stats([day('2026-11-01', { runs: 1, practiceRuns: 1, activeMs: 1 }), day('2026-11-02', { runs: 1, practiceRuns: 1, activeMs: 1 }), day('2026-11-03', { passedRuns: 20, runs: 20, completedProblems: 1 })], { solvedProblems: 10 }), '2026-11-03');
  const fresh = { level: 0, achievements: [] };
  assert.deepEqual(firstTimeChanges(profileChanges(low, high), fresh).map(change => change.kind), ['xp', 'level-up', 'achievement', 'achievement', 'achievement', 'streak']);
  const seen = markProfile(markProfile(fresh, low), high);
  assert.equal(seen.level, high.level);
  assert.deepEqual(firstTimeChanges(profileChanges(low, high), seen).map(change => change.kind), ['xp', 'streak'], 'dropping and climbing back only repeats experience and streak');
  assert.deepEqual(markProfile(seen, low), seen, 'marks never move backwards');
});
