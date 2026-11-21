import type { ReviewSession } from '../shared/review-plan.ts';

/** Queue position also advances past paused, postponed or already-rated problems. Neither new assessments nor
 * outstanding work can be inferred from it; storage supplies the actual assessments committed during the round. */
export function reviewSessionSummary(session: Pick<ReviewSession, 'problemIds' | 'position' | 'skippedProblemIds' | 'ratedProblemIds'>, finished: boolean): string {
  const problems = new Set(session.problemIds), rated = new Set((session.ratedProblemIds ?? []).filter(id => problems.has(id)));
  const skipped = new Set(session.skippedProblemIds.filter(id => problems.has(id) && !rated.has(id))).size;
  const other = problems.size - rated.size - skipped;
  const counts = `新增自评 ${rated.size} 题${skipped ? `，跳过 ${skipped} 题` : ''}`;
  if (other > 0) return `本轮复习已结束：${counts}，另有 ${other} 题未在本轮新增自评。题目当前安排与状态请查看复习计划。`;
  return `${finished ? '本轮复习完成' : '本轮复习已结束'}：${counts}。题目当前安排与状态请查看复习计划。`;
}
