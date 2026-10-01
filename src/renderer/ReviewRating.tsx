import { useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import type { ReviewFeedbackInput, ReviewFeedbackResult, ReviewItem, ReviewRating as Rating } from '../shared/learning';
import type { Language } from '../runner/types';
import { errorText, dateTime } from './ui';
import { useEditsFrozen } from './pending-saves';

export const ratings = [
  { value: 1 as const, title: '忘了', hint: '无法独立回忆或需要关键提示' },
  { value: 2 as const, title: '困难', hint: '独立完成，但明显费劲' },
  { value: 3 as const, title: '良好', hint: '基本独立完成' },
  { value: 4 as const, title: '轻松', hint: '能清楚解释' },
];
export const reviewLabel = (_item: Pick<ReviewItem, 'target' | 'language'>) => '题目复习';

export function ReviewRating({ api, problemId, language, attemptId, existingItem, onSaved, onDismiss, onError }: {
  api: DesktopBridge | undefined; problemId: string; language: Language; attemptId: string;
  existingItem?: ReviewItem | null; onSaved: (result: ReviewFeedbackResult) => void; onDismiss?: () => void; onError: (message: string) => void;
}) {
  const [rating, setRating] = useState<Rating | null>(null); const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<ReviewFeedbackResult | null>(null); const [retry, setRetry] = useState(false);
  const submission = useRef<ReviewFeedbackInput | null>(null); const working = useRef(false); const frozen = useEditsFrozen();
  async function submit() {
    if (!api || !rating || working.current || frozen || saved) return;
    working.current = true; setBusy(true);
    try {
      if (!submission.current) {
        const item = existingItem ?? await api.addReviewItem({ problemId, target: 'understanding', language: 'none' });
        submission.current = { requestId: crypto.randomUUID(), itemId: item.id, rating, attemptId };
      }
      const result = await api.reviewFeedback(submission.current); setSaved(result); setRetry(false); onSaved(result);
    } catch (error) { setRetry(true); onError(errorText(error)); } finally { working.current = false; setBusy(false); }
  }
  return <section className="review-rating" aria-label="练习自评与复习计划">
    {saved ? <><h3>自评已记录</h3><p>{saved.item.dueAt ? `下次到期 ${dateTime(saved.item.dueAt)}` : '待首次评估'}</p>{onDismiss && <button className="text-button" onClick={onDismiss}>收起自评</button>}</> : <>
      <div className="section-heading"><h3>这次能独立完成多少？</h3>{onDismiss && <button className="text-button" disabled={busy} onClick={onDismiss}>稍后再评</button>}</div>
      <div className="rating-options">{ratings.map(option => <button key={option.value} className="button" aria-pressed={rating === option.value} disabled={busy || frozen || Boolean(submission.current)} onClick={() => setRating(option.value)}><strong>{option.title}</strong><span>{option.hint}</span></button>)}</div>
      <div className="button-row"><button className="button primary" disabled={!api || !rating || busy || frozen} onClick={() => { void submit(); }}>{busy ? '正在记录…' : retry ? '重试记录本次自评' : '确认自评并安排复习'}</button></div>
    </>}
  </section>;
}
