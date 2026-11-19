import type { ReviewSession } from '../shared/review-plan';

/** The strip above the workbench during a review session. Rating and moving on are one step: the main button opens
 * today's self-rating and advances once it is saved, or advances at once when the problem was already rated today
 * (for example right after an official Accepted). */
export function ReviewSessionBar({ session, onCurrent, rated, disabled, leaveDisabled, ratingBlocked, onNext, onRate, onSkip, onReturn, onLeave, onEnd }: {
  session: ReviewSession;
  /** The workbench shows the queue's current problem, not a neighbour opened for browsing. */
  onCurrent: boolean;
  /** Whether today already has a rating for the shown problem; null while that is being read. */
  rated: boolean | null;
  disabled: boolean; leaveDisabled: boolean;
  /** Another rating prompt is open; a second one must not start. */
  ratingBlocked: boolean;
  onNext: () => void; onRate: () => void; onSkip: () => void; onReturn: () => void; onLeave: () => void; onEnd: () => void;
}) {
  const last = session.position + 1 >= session.problemIds.length;
  const next = rated ? (last ? '完成本轮' : '下一题') : last ? '自评并完成本轮' : '自评并下一题';
  return <section className="version-notice review-session-bar" aria-label="复习会话">
    <span>{onCurrent ? '复习' : '浏览邻题 · 队列进度保留'} · 第 {session.position + 1} / {session.problemIds.length} 题{onCurrent && rated ? ' · 今天已自评' : ''}</span>
    <div className="button-row">
      {onCurrent ? <>
        <button className="button primary review-next" disabled={disabled || rated === null || (!rated && ratingBlocked)} onClick={onNext}>{next}</button>
        <button className="text-button" disabled={disabled} onClick={onSkip}>跳过本题</button>
      </> : <>
        {!rated && <button className="button" disabled={disabled || ratingBlocked} onClick={onRate}>记录本题自评</button>}
        <button className="button" disabled={disabled} onClick={onReturn}>回到队列当前题</button>
      </>}
      <button className="text-button" disabled={leaveDisabled} onClick={onLeave}>退出并保留进度</button>
      <button className="text-button" disabled={leaveDisabled} onClick={onEnd}>结束本轮</button>
    </div>
  </section>;
}
