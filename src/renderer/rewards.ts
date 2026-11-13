import type { ActivityDay, ArchiveStatistics } from '../shared/learning.ts';
import { addDays, isStudyDay } from './learning-calendar.ts';

/** Experience is derived from durable statistics, so backups, restores and other windows agree.
 * Every source has a daily cap, so repeated runs of an unchanged solution or a stream of self-ratings cannot
 * inflate progress. Most imported LeetCode problems can only finish locally as "completed" (no trusted expected
 * output), so an official Accepted is the strongest signal; practice runs earn a little whether or not they
 * could be judged locally. */
export const XP_RULES = {
  officialAccepted: 30, officialAcceptedDailyCap: 10,
  passedRun: 10, passedRunDailyCap: 20,
  practiceRun: 2, practiceRunDailyCap: 30,
  completedProblem: 15, completedProblemDailyCap: 10,
  review: 25, reviewDailyCap: 10,
  activeMinute: 1, activeMinuteDailyCap: 240,
} as const;

export type RankId = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'master' | 'king';
export interface RankTier { id: RankId; name: string; minLevel: number }
export const RANKS: readonly RankTier[] = [
  { id: 'bronze', name: '青铜', minLevel: 1 }, { id: 'silver', name: '白银', minLevel: 3 },
  { id: 'gold', name: '黄金', minLevel: 6 }, { id: 'platinum', name: '铂金', minLevel: 10 },
  { id: 'diamond', name: '钻石', minLevel: 15 }, { id: 'master', name: '大师', minLevel: 20 },
  { id: 'king', name: '王者', minLevel: 30 },
];

export type AchievementIcon = 'check' | 'bolt' | 'trophy' | 'calendar' | 'flame' | 'target' | 'star' | 'sparkle';
type Metric = 'solvedProblems' | 'officialSolvedProblems' | 'reviewedItems' | 'bestStreak' | 'bestDayMinutes' | 'activeHours' | 'activeDays';
/** Solving counts distinct problems (the problem's own cases all passed locally, or an official Accepted), so re-running one
 * problem cannot farm it and cases the user typed in cannot fake it. */
const ACHIEVEMENTS: readonly { id: string; title: string; description: string; icon: AchievementIcon; metric: Metric; target: number }[] = [
  { id: 'first-pass', title: '初露锋芒', description: '第一次解出一道题（题目自带的用例全部通过，或力扣官方 AC）', icon: 'check', metric: 'solvedProblems', target: 1 },
  { id: 'official-first', title: '官方认证', description: '第一次获得力扣官方 AC', icon: 'star', metric: 'officialSolvedProblems', target: 1 },
  { id: 'pass-10', title: '渐入佳境', description: '累计解出 10 道不同的题目', icon: 'bolt', metric: 'solvedProblems', target: 10 },
  { id: 'pass-100', title: '百炼成钢', description: '累计解出 100 道不同的题目', icon: 'trophy', metric: 'solvedProblems', target: 100 },
  { id: 'review-10', title: '温故知新', description: '复习 10 道不同的题目', icon: 'calendar', metric: 'reviewedItems', target: 10 },
  { id: 'streak-3', title: '三日不辍', description: '连续学习 3 天', icon: 'flame', metric: 'bestStreak', target: 3 },
  { id: 'streak-7', title: '七日之约', description: '连续学习 7 天', icon: 'flame', metric: 'bestStreak', target: 7 },
  { id: 'focus-60', title: '心流时刻', description: '单日专注学习 60 分钟', icon: 'target', metric: 'bestDayMinutes', target: 60 },
  { id: 'days-30', title: '积跬致远', description: '累计 30 个学习日', icon: 'sparkle', metric: 'activeDays', target: 30 },
  { id: 'hours-10', title: '持之以恒', description: '累计学习 10 小时', icon: 'star', metric: 'activeHours', target: 10 },
];
export const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 365] as const;

export interface Achievement { id: string; title: string; description: string; icon: AchievementIcon; unlocked: boolean; progress: number; target: number }
export interface RewardProfile {
  xp: number; todayXp: number;
  level: number; levelStartXp: number; nextLevelXp: number; levelProgress: number;
  rank: RankTier; nextRank: RankTier | null;
  streak: number; bestStreak: number; activeToday: boolean;
  achievements: Achievement[];
  totals: { solvedProblems: number; officialSolvedProblems: number; passedRuns: number; runs: number; reviewedItems: number; activeMinutes: number; activeDays: number };
}

const minutes = (ms: number) => Math.floor(Math.max(0, ms) / 60000);
export function dayXp(day: ActivityDay): number {
  return Math.min(day.officialAccepted, XP_RULES.officialAcceptedDailyCap) * XP_RULES.officialAccepted
    + Math.min(day.passedRuns, XP_RULES.passedRunDailyCap) * XP_RULES.passedRun
    + Math.min(day.practiceRuns, XP_RULES.practiceRunDailyCap) * XP_RULES.practiceRun
    + Math.min(day.completedProblems, XP_RULES.completedProblemDailyCap) * XP_RULES.completedProblem
    + Math.min(day.reviewCount, XP_RULES.reviewDailyCap) * XP_RULES.review
    + Math.min(minutes(day.activeMs), XP_RULES.activeMinuteDailyCap) * XP_RULES.activeMinute;
}

/** Total XP needed to reach a level; each next level costs 100 more than the previous one. */
export function levelStartXp(level: number): number { return 50 * (level - 1) * (level + 2); }
export function levelForXp(xp: number): number {
  let level = 1;
  while (levelStartXp(level + 1) <= xp) level++;
  return level;
}
export function rankForLevel(level: number): RankTier {
  let rank = RANKS[0];
  for (const tier of RANKS) if (level >= tier.minLevel) rank = tier;
  return rank;
}

const isActive = isStudyDay;
/** A streak survives until the end of today: an untouched today continues yesterday's run. */
export function activityStreak(days: readonly ActivityDay[], today: string): number {
  const active = new Set(days.filter(isActive).map(day => day.date));
  let date = active.has(today) ? today : addDays(today, -1), streak = 0;
  while (active.has(date)) { streak++; date = addDays(date, -1); }
  return streak;
}
export function longestStreak(days: readonly ActivityDay[]): number {
  const dates = [...new Set(days.filter(isActive).map(day => day.date))].sort();
  let best = 0, run = 0, previous = '';
  for (const date of dates) { run = previous && addDays(previous, 1) === date ? run + 1 : 1; best = Math.max(best, run); previous = date; }
  return best;
}

export function rewardProfile(stats: ArchiveStatistics, today: string): RewardProfile {
  const xp = stats.days.reduce((sum, day) => sum + dayXp(day), 0);
  const todayRow = stats.days.find(day => day.date === today);
  const level = levelForXp(xp), start = levelStartXp(level), next = levelStartXp(level + 1);
  const rank = rankForLevel(level), nextRank = RANKS.find(tier => tier.minLevel > level) ?? null;
  const streak = activityStreak(stats.days, today), bestStreak = Math.max(streak, longestStreak(stats.days));
  const activeDays = stats.days.filter(isActive).length;
  const metrics: Record<Metric, number> = {
    solvedProblems: stats.solvedProblems, officialSolvedProblems: stats.officialSolvedProblems, reviewedItems: stats.reviewedItems, bestStreak,
    bestDayMinutes: Math.max(0, ...stats.days.map(day => minutes(day.activeMs))),
    activeHours: Math.floor(minutes(stats.activeMs) / 60), activeDays,
  };
  return {
    xp, todayXp: todayRow ? dayXp(todayRow) : 0,
    level, levelStartXp: start, nextLevelXp: next, levelProgress: (xp - start) / (next - start),
    rank, nextRank, streak, bestStreak, activeToday: Boolean(todayRow && isActive(todayRow)),
    achievements: ACHIEVEMENTS.map(({ metric, ...item }) => ({ ...item, progress: Math.min(metrics[metric], item.target), unlocked: metrics[metric] >= item.target })),
    totals: { solvedProblems: stats.solvedProblems, officialSolvedProblems: stats.officialSolvedProblems, passedRuns: stats.passedRuns, runs: stats.runs,
      reviewedItems: stats.reviewedItems, activeMinutes: minutes(stats.activeMs), activeDays },
  };
}

export type ProfileChange =
  | { kind: 'xp'; amount: number }
  | { kind: 'level-up'; level: number; rank: RankTier; rankChanged: boolean }
  | { kind: 'achievement'; achievement: Achievement }
  | { kind: 'streak'; days: number };
/** Only forward progress is celebrated; a restore or correction that lowers totals stays silent. */
export function profileChanges(previous: RewardProfile, next: RewardProfile): ProfileChange[] {
  const changes: ProfileChange[] = [];
  if (next.xp > previous.xp) changes.push({ kind: 'xp', amount: next.xp - previous.xp });
  if (next.level > previous.level) changes.push({ kind: 'level-up', level: next.level, rank: next.rank, rankChanged: next.rank.id !== previous.rank.id });
  const before = new Set(previous.achievements.filter(item => item.unlocked).map(item => item.id));
  for (const achievement of next.achievements) if (achievement.unlocked && !before.has(achievement.id)) changes.push({ kind: 'achievement', achievement });
  if (next.streak > previous.streak && (STREAK_MILESTONES as readonly number[]).includes(next.streak)) changes.push({ kind: 'streak', days: next.streak });
  return changes;
}

/** Highest level and achievements already announced. Totals can fall (deleted archives, a time-zone change)
 * and climb back; reaching the same level or achievement again must not be celebrated as new. */
export interface RewardMarks { level: number; achievements: string[] }
export function markProfile(marks: RewardMarks, profile: RewardProfile): RewardMarks {
  const unlocked = profile.achievements.filter(item => item.unlocked).map(item => item.id);
  return { level: Math.max(marks.level, profile.level), achievements: [...new Set([...marks.achievements, ...unlocked])] };
}
export function firstTimeChanges(changes: readonly ProfileChange[], marks: RewardMarks): ProfileChange[] {
  return changes.filter(change => change.kind === 'level-up' ? change.level > marks.level
    : change.kind === 'achievement' ? !marks.achievements.includes(change.achievement.id) : true);
}
