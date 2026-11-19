import type { ReviewSession } from '../shared/review-plan.ts';

/** One line on what a review round came to, read from the session itself. A problem leaves the queue only after a
 * self-rating that day or an explicit skip, so the problems before `position` minus the skipped ones were rated. */
export function reviewSessionSummary(session: Pick<ReviewSession, 'problemIds' | 'position' | 'skippedProblemIds'>, finished: boolean): string {
  const total = session.problemIds.length, handled = finished ? total : Math.max(0, Math.min(session.position, total));
  const skipped = Math.min(session.skippedProblemIds.length, handled), rated = handled - skipped, remaining = total - handled;
  const counts = `自评 ${rated} 题${skipped ? `，跳过 ${skipped} 题` : ''}`;
  if (remaining > 0) return `本轮复习已结束：${counts}，还有 ${remaining} 题没有复习。没复习和跳过的题目仍按原计划安排。`;
  return `本轮复习完成：${counts}。${skipped ? '跳过的题目仍按原计划安排；' : ''}下一次安排见复习计划。`;
}
