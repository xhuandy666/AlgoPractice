import { levelStartXp, RANKS, type Achievement, type RankTier, type RewardProfile } from './rewards.ts';

/** What the learner can do now to move a locked badge. `review` starts or continues today's review; `review-plan` opens the plan. */
export type GrowthAction = 'browse' | 'review' | 'review-plan';
export interface NextStep { hint: string; action: GrowthAction | null; label: string }
/** Review facts of the day; the badge that counts reviews points at them. */
export interface ReviewOpportunity { planned: number; ongoing: boolean }

export interface RankStep { tier: RankTier; xp: number; state: 'reached' | 'current' | 'next' | 'ahead' }
/** The whole ladder with the experience each tier starts at, so the next tier is visible from any level. */
export function rankLadder(profile: Pick<RewardProfile, 'rank' | 'nextRank'>): RankStep[] {
  return RANKS.map(tier => ({ tier, xp: levelStartXp(tier.minLevel),
    state: tier.id === profile.rank.id ? 'current' : tier.id === profile.nextRank?.id ? 'next' : tier.minLevel < profile.rank.minLevel ? 'reached' : 'ahead' }));
}
/** Experience still missing for the next level and, separately, for the next tier (null at the top tier). */
export function growthDistance(profile: Pick<RewardProfile, 'xp' | 'nextLevelXp' | 'nextRank'>) {
  return { nextLevel: Math.max(0, profile.nextLevelXp - profile.xp), nextRank: profile.nextRank ? Math.max(0, levelStartXp(profile.nextRank.minLevel) - profile.xp) : null };
}

const none = (hint: string): NextStep => ({ hint, action: null, label: '' });
/** Says what a locked badge still needs and which action moves it. Wording matches how the statistics count:
 * distinct problems, initial assessments excluded from reviews, self-typed expectations not solving a problem. */
export function achievementNextStep(item: Achievement, profile: Pick<RewardProfile, 'streak' | 'activeToday' | 'todaySources'>, review: ReviewOpportunity): NextStep {
  if (item.unlocked) return none('已解锁。');
  const remaining = Math.max(1, item.target - item.progress);
  switch (item.metric) {
    case 'solvedProblems':
      return { hint: `还差 ${remaining} 道不同的题目。题目自带的用例全部通过，或拿到力扣官方 AC 才算解出；用自己填写的期望输出跑通不算。`, action: 'browse', label: '去题库练习' };
    case 'officialSolvedProblems':
      return { hint: '在普通练习里点“提交到力扣”，拿到一次官方 AC。需要先登录力扣国服；ACM 格式不能提交。', action: 'browse', label: '去题库练习' };
    case 'reviewedItems': {
      const hint = `还差 ${remaining} 道不同的题目。同一道题重复复习只计一次，第一次自评不计入。`;
      if (review.ongoing) return { hint, action: 'review', label: '继续本轮复习' };
      if (review.planned > 0) return { hint, action: 'review', label: `开始今日复习（${review.planned} 题）` };
      return { hint: `${hint}今天没有到期的复习。`, action: 'review-plan', label: '查看复习计划' };
    }
    case 'bestStreak': {
      const state = profile.activeToday ? `已连续学习 ${profile.streak} 天，今天已经计入，明天继续即可。`
        : profile.streak > 0 ? `已连续学习 ${profile.streak} 天，今天完成学习即可延续。` : '今天开始学习，连续天数从 1 天算起。';
      return profile.activeToday ? none(`需要连续学习 ${item.target} 天。${state}`) : { hint: `需要连续学习 ${item.target} 天。${state}`, action: 'browse', label: '开始练习' };
    }
    case 'bestDayMinutes': {
      const today = profile.todaySources.find(source => source.id === 'activeMinute')?.count ?? 0;
      return { hint: `需要单日专注学习满 ${item.target} 分钟，今天已有 ${today} 分钟。只有练习工作台在前台且近期有操作时才计时。`, action: 'browse', label: '开始练习' };
    }
    case 'activeDays':
      return profile.activeToday ? none(`还差 ${remaining} 个学习日。有学习活动、完成题目或完成复习的日子都算，今天已经计入。`)
        : { hint: `还差 ${remaining} 个学习日。有学习活动、完成题目或完成复习的日子都算。`, action: 'browse', label: '开始练习' };
    case 'activeHours':
      return { hint: `还差 ${remaining} 小时的累计学习时长。`, action: 'browse', label: '开始练习' };
  }
}
