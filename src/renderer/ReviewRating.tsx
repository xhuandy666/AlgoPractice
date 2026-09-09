import { useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import type { ReviewFeedbackInput, ReviewFeedbackResult, ReviewItem, ReviewRating as Rating } from '../shared/learning';
import type { Language } from '../runner/types';
import { errorText, dateTime } from './ui';
import { useEditsFrozen } from './pending-saves';

export const ratings = [
  { value: 1 as const, title: '重来', hint: '暂时想不起来' },
  { value: 2 as const, title: '困难', hint: '需要明显提示' },
  { value: 3 as const, title: '良好', hint: '基本独立完成' },
  { value: 4 as const, title: '轻松', hint: '能清楚解释' },
];
export const reviewLabel = (item: Pick<ReviewItem, 'target' | 'language'>) => item.target === 'understanding' ? '思路复习' : `${item.language === 'python' ? 'Python' : 'Java'} 重写`;

export function ReviewRating({ api, problemId, language, attemptId, existingItem, onSaved, onDismiss, onError }: {
  api: DesktopBridge | undefined; problemId: string; language: Language; attemptId: string;
  existingItem?: ReviewItem | null; onSaved: (result: ReviewFeedbackResult) => void; onDismiss?: () => void; onError: (message: string) => void;
}) {
  const [target, setTarget] = useState<'understanding' | 'rewrite'>(existingItem?.target ?? 'rewrite');
  const [rating, setRating] = useState<Rating | null>(null); const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<ReviewFeedbackResult | null>(null); const [retry, setRetry] = useState(false);
  const submission = useRef<ReviewFeedbackInput | null>(null); const working = useRef(false); const frozen = useEditsFrozen();
  async function submit() {
    if (!api || !rating || working.current || frozen || saved) return;
    working.current = true; setBusy(true);
    try {
      if (!submission.current) {
        const reviewLanguage = target === 'understanding' ? 'none' : language;
        const item = existingItem?.target === target && existingItem.language === reviewLanguage ? existingItem : await api.addReviewItem({ problemId, target, language: reviewLanguage });
        submission.current = { requestId: crypto.randomUUID(), itemId: item.id, rating, attemptId };
      }
      const result = await api.reviewFeedback(submission.current); setSaved(result); setRetry(false); onSaved(result);
    } catch (error) { setRetry(true); onError(errorText(error)); } finally { working.current = false; setBusy(false); }
  }
  return <section className="review-rating" aria-label="练习自评与复习计划">
    {saved ? <><h3>自评已记录</h3><p>{reviewLabel(saved.item)} · 下次到期 {dateTime(saved.item.dueAt)}。可在今日复习中查看或更正这次评分。</p>{onDismiss && <button className="text-button" onClick={onDismiss}>收起自评</button>}</> : <>
      <div className="section-heading"><div><h3>这次能独立完成多少？</h3><p>按实际回忆情况自评。它决定复习时间，不改变题目难度或测试结果。</p></div>{onDismiss && <button className="text-button" disabled={busy} onClick={onDismiss}>稍后再评</button>}</div>
      <label className="p3-field">本次复习目标<select value={target} disabled={busy || frozen || Boolean(submission.current)} onChange={event => setTarget(event.target.value as 'understanding' | 'rewrite')}><option value="rewrite">{language === 'python' ? 'Python' : 'Java'} 重写</option><option value="understanding">思路复习（不区分语言）</option></select></label>
      <div className="rating-options">{ratings.map(option => <button key={option.value} className="button" aria-pressed={rating === option.value} disabled={busy || frozen || Boolean(submission.current)} onClick={() => setRating(option.value)}><strong>{option.title}</strong><span>{option.hint}</span></button>)}</div>
      <div className="button-row"><button className="button primary" disabled={!api || !rating || busy || frozen} onClick={() => { void submit(); }}>{busy ? '正在记录…' : retry ? '重试记录本次自评' : '确认自评并安排复习'}</button></div>
    </>}
  </section>;
}
