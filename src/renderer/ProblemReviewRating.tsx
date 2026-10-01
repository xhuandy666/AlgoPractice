import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import type { ReviewRating } from '../shared/learning';
import type { ProblemReviewEvent, ProblemReviewPreview, ProblemReviewResult, ReviewAssessmentDraft, ReviewAssessmentDraftInput, ReviewOpportunity } from '../shared/review-plan';
import { errorText } from './ui';
import { registerPendingSave, useEditsFrozen } from './pending-saves';
import { canDiscardConflictedReviewDraft, equivalentCommittedReviewDraft, matchesReviewDraftIdentity, type ReviewDraftRecoveryExpectation } from './review-draft-recovery';
import './review-rating.css';

export const problemRatings = [
  { value: 1 as const, title: '忘了', hint: '未能独立回忆解法，或需要关键提示' },
  { value: 2 as const, title: '困难', hint: '独立完成，但回忆或实现费劲' },
  { value: 3 as const, title: '良好', hint: '独立完成，过程基本顺利' },
  { value: 4 as const, title: '轻松', hint: '无需提示，轻松完成并能解释关键点' },
];
export type ProblemReviewRatingMode = { kind: 'official'; opportunity: ReviewOpportunity }
  | { kind: 'manual'; attemptId?: string } | { kind: 'correction'; event: ProblemReviewEvent };
export interface ProblemReviewRatingProps {
  api: DesktopBridge | undefined; problem: { id: string; title: string }; mode: ProblemReviewRatingMode;
  onSaved: (result: ProblemReviewResult) => void | Promise<void>; onDismiss: () => void | Promise<void>;
  onError: (message: string) => void; autoPrompt?: boolean;
}
const timeLabel = (at: string, zone: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(at));

/** A submitted draft freezes the source, date slot and request identity in SQLite, not in the modal. */
export function ProblemReviewRating({ api, problem, mode, onSaved, onDismiss, onError, autoPrompt = false }: ProblemReviewRatingProps) {
  const headingId = useId(), descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null), errorRegion = useRef<HTMLParagraphElement>(null);
  const mounted = useRef(true), operation = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draft = useRef<ReviewAssessmentDraft | null>(null), selected = useRef<ReviewRating | null>(null);
  const pendingReadback = useRef<{ expectation: ReviewDraftRecoveryExpectation; version: number; error: string; needsUpperBound: boolean } | null>(null);
  const requestId = useRef<string>(crypto.randomUUID()), serial = useRef<Promise<void>>(Promise.resolve());
  const inFlight = useRef<Promise<void> | null>(null);
  const editVersion = useRef(0), savedVersion = useRef(0), sent = useRef(false), resolved = useRef(false);
  const callbacks = useRef({ onSaved, onDismiss, onError }); callbacks.current = { onSaved, onDismiss, onError };
  const sourceId = mode.kind === 'official' ? mode.opportunity.id : mode.kind === 'correction' ? mode.event.id : problem.id;
  const key = `problem-review:${mode.kind}:${sourceId}`;
  const [rating, setRating] = useState<ReviewRating | null>(null), [loading, setLoading] = useState(true), [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false), [locked, setLocked] = useState(false), [failure, setFailure] = useState('');
  const [preview, setPreview] = useState<ProblemReviewPreview | null>(null), [previewBusy, setPreviewBusy] = useState(false);
  const [saved, setSaved] = useState<ProblemReviewResult | null>(null), [context, setContext] = useState<ReviewAssessmentDraft | null>(null);
  const [invalidated, setInvalidated] = useState(false); const frozen = useEditsFrozen();
  const source = mode.kind === 'official' ? mode.opportunity : mode.kind === 'correction' ? mode.event : null;

  const persist = useCallback((submit = false) => {
    if (timer.current) clearTimeout(timer.current); timer.current = null;
    const next = serial.current.catch(() => undefined).then(async () => {
      if (!api || resolved.current || (!selected.current && !draft.current)) return;
      // A failed readback must keep the original write window; a new CAS retry cannot prove the old ACK.
      if (pendingReadback.current) {
        const pending = pendingReadback.current;
        if (pending.needsUpperBound) { pending.expectation.finishedAt = await api.reviewAssessmentTime(); pending.needsUpperBound = false; }
        const committed = await api.reviewAssessmentDraft(key);
        if (!equivalentCommittedReviewDraft(committed, pending.expectation)) {
          pendingReadback.current = null;
          throw new Error(`草稿保存未确认：${pending.error}。原输入已保留，请恢复最新版本后重试。`);
        }
        draft.current = committed; savedVersion.current = pending.version; sent.current = Boolean(committed!.submittedAt);
        pendingReadback.current = null;
        if (mounted.current) { setContext(committed); setLocked(sent.current); }
        if (committed!.resolvedEventId) return;
      }
      while (savedVersion.current !== editVersion.current || (submit && !sent.current)) {
        const version = editVersion.current, previous = draft.current;
        const input: ReviewAssessmentDraftInput = { key, problemId: problem.id, source: mode.kind,
          ...(mode.kind === 'official' ? { opportunityId: mode.opportunity.id } : mode.kind === 'correction' ? { eventId: mode.event.id } : {}),
          rating: selected.current, requestId: requestId.current, ...(previous ? { expectedRevision: previous.revision } : {}),
          ...(submit ? { submitted: true } : {}),
        };
        const observation = previous?.submittedAt ? previous : mode.kind === 'official'
          ? { learningDate: mode.opportunity.learningDate, timeZone: mode.opportunity.timeZone, observedAt: mode.opportunity.acceptedAt }
          : mode.kind === 'correction' ? mode.event : undefined;
        // Bound the write with its own process clock: renderer/main wall-clock readings may differ.
        const startedAt = await api.reviewAssessmentTime();
        if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error('无法确认草稿保存时间，请重试；原输入已保留。');
        let result: ReviewAssessmentDraft;
        try { result = await api.saveReviewAssessmentDraft(input); }
        catch (error) {
          const expectation = { input, startedAt, finishedAt: NaN, observation, priorSubmittedAt: previous?.submittedAt };
          const pending = { expectation, version, error: errorText(error), needsUpperBound: true };
          pendingReadback.current = pending;
          expectation.finishedAt = await api.reviewAssessmentTime(); pending.needsUpperBound = false;
          const committed = await api.reviewAssessmentDraft(key);
          if (!equivalentCommittedReviewDraft(committed, expectation)) {
            pendingReadback.current = null;
            throw new Error(`草稿保存未确认：${errorText(error)}。本机草稿与本次输入、来源或观察身份不一致，未覆盖任何内容；原输入已保留。`);
          }
          pendingReadback.current = null;
          result = committed!;
        }
        draft.current = result; savedVersion.current = version; sent.current = Boolean(result.submittedAt);
        if (mounted.current) { setContext(result); setLocked(sent.current); }
        if (result.resolvedEventId) break;
      }
    });
    serial.current = next; return next;
  }, [api, key, problem.id, mode.kind, sourceId]);

  function showPermanentCollision(current: ReviewAssessmentDraft) {
    setInvalidated(true);
    setFailure(`${current.learningDate} 的评分已由另一入口记录。本草稿不再提交，也不会自动更正已有评分；可在评分历史查看，明确关闭时将作废本草稿。`);
  }

  const acceptResult = useCallback(async (result: ProblemReviewResult) => {
    resolved.current = true; sent.current = true;
    if (mounted.current) { setSaved(result); setLocked(true); setFailure(''); }
    // The observation resolves the draft and increments its revision in the same transaction.
    // Re-read that revision, and never remove a draft belonging to another request.
    try {
      const current = await api?.reviewAssessmentDraft(key);
      if (current && current.requestId === result.event.requestId && current.resolvedEventId === result.event.id && current.problemId === result.event.problemId) {
        await api?.deleteReviewAssessmentDraft(key, current.revision);
        draft.current = null;
      }
    } catch (error) {
      if (mounted.current) setFailure('评分已记录，但草稿清理未完成。再次打开会先核对原记录，不会重复评分。');
      callbacks.current.onError(errorText(error));
    }
    // A refresh failure is not a failed assessment: leave a confirmed result visible.
    try { await callbacks.current.onSaved(result); } catch (error) { callbacks.current.onError(errorText(error)); }
  }, [api, key]);

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current; if (element && !element.open) element.showModal();
    const remove = registerPendingSave(`题目自评 ${key}`, async () => { await persist(); if (inFlight.current) await inFlight.current; });
    return () => { mounted.current = false; remove(); if (timer.current) clearTimeout(timer.current); element?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [key, persist]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!api) throw new Error('请在桌面应用中记录自评。');
      const existing = await api.reviewAssessmentDraft(key);
      if (!alive) return;
      if (existing) {
        if (!matchesReviewDraftIdentity(existing, { key, problemId: problem.id, source: mode.kind, requestId: existing.requestId, rating: existing.rating,
          ...(mode.kind === 'official' ? { opportunityId: mode.opportunity.id } : mode.kind === 'correction' ? { eventId: mode.event.id } : {}) })) throw new Error('草稿来源不匹配，请关闭后重新打开。');
        draft.current = existing; requestId.current = existing.requestId; selected.current = existing.rating;
        sent.current = Boolean(existing.submittedAt); setRating(existing.rating); setContext(existing); setLocked(sent.current);
        const result = await api.problemReviewRequest(existing.requestId);
        if (result && alive) await acceptResult(result);
        else if (alive && existing.conflictEventId) showPermanentCollision(existing);
      }
    })().catch(error => { if (alive) { setLoadFailed(true); setFailure(errorText(error)); callbacks.current.onError(errorText(error)); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, key, problem.id, mode.kind, sourceId, acceptResult]);

  useEffect(() => {
    if (!api || !rating || saved || loading || invalidated) { setPreview(null); setPreviewBusy(false); return; }
    let alive = true; setPreviewBusy(true); setPreview(null);
    const handle = setTimeout(() => { void api.previewProblemReview({ problemId: problem.id, rating, source: mode.kind,
      ...(mode.kind === 'official' ? { opportunityId: mode.opportunity.id } : mode.kind === 'correction' ? { eventId: mode.event.id } : {}),
      ...(draft.current?.submittedAt ? { requestId: requestId.current } : {}),
    }).then(value => { if (alive) setPreview(value); }).catch(error => { if (alive) setFailure(errorText(error)); }).finally(() => { if (alive) setPreviewBusy(false); }); }, 100);
    return () => { alive = false; clearTimeout(handle); };
  }, [api, rating, loading, saved, problem.id, mode.kind, sourceId, invalidated, context?.updatedAt, context?.submittedAt]);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const remove = api.onLibraryChanged(() => { if (!operation.current && !resolved.current) void (async () => {
      const result = await api.problemReviewRequest(requestId.current);
      if (!alive || operation.current || resolved.current) return;
      if (result) { await acceptResult(result); return; }
      if (draft.current?.submittedAt) {
        const current = await api.reviewAssessmentDraft(key);
        if (!alive || operation.current || resolved.current) return;
        if (canDiscardConflictedReviewDraft(current, draft.current, false)) {
          draft.current = current; setContext(current); showPermanentCollision(current!); return;
        }
      }
      let obsolete = false;
      if (mode.kind === 'official') {
        const page = await api.reviewOpportunities({ problemId: problem.id, learningDate: mode.opportunity.learningDate, limit: 100 });
        obsolete = page.items.find(row => row.id === mode.opportunity.id)?.state === 'assessed';
      } else {
        const detail = await api.problemReviewDetail(problem.id, { limit: 100 });
        if (mode.kind === 'manual') {
          const date = draft.current?.learningDate;
          obsolete = Boolean(date && detail.events.items.some(event => event.kind === 'review' && event.learningDate === date && event.requestId !== requestId.current));
        } else {
          obsolete = detail.events.items.some(event => event.id === mode.event.id && event.effectiveRating !== mode.event.effectiveRating);
        }
      }
      if (alive && obsolete && !operation.current && !resolved.current) { setInvalidated(true); setFailure('这次自评已由另一入口记录或更正。当前输入不会自动写成新观察；请关闭后在评分历史查看。'); }
    })().catch(error => { if (alive) callbacks.current.onError(errorText(error)); }); });
    return () => { alive = false; remove(); };
  }, [api, mode.kind, sourceId, problem.id, acceptResult]);

  function choose(value: ReviewRating) {
    if (operation.current || loading || loadFailed || frozen || sent.current || resolved.current || invalidated) return;
    selected.current = value; editVersion.current++; setRating(value); setFailure('');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void persist().catch(error => { if (mounted.current) setFailure(`草稿尚未保存：${errorText(error)}。请重试后再关闭。`); }); }, 250);
  }
  async function submit() {
    if (!api || !selected.current || operation.current || frozen || loading || loadFailed || invalidated || resolved.current || conflict) return;
    operation.current = true; setBusy(true); setFailure('');
    let finish!: () => void; inFlight.current = new Promise<void>(resolve => { finish = resolve; });
    try {
      // An unknown response is resolved before any repeat write; the original identity is never replaced.
      const existing = await api.problemReviewRequest(requestId.current);
      if (existing) { await acceptResult(existing); return; }
      await persist(true); setLocked(true);
      const value = selected.current;
      if (!value) throw new Error('请先选择本次自评。');
      const result = mode.kind === 'official' ? await api.submitReviewOpportunity({ requestId: requestId.current, opportunityId: mode.opportunity.id, rating: value })
        : mode.kind === 'correction' ? await api.correctProblemReview({ requestId: requestId.current, eventId: mode.event.id, rating: value })
          : await api.recordProblemReview({ requestId: requestId.current, problemId: problem.id, rating: value, ...(mode.attemptId ? { attemptId: mode.attemptId } : {}) });
      await acceptResult(result);
    } catch (error) {
      let permanentCollision = false;
      try {
        const result = await api.problemReviewRequest(requestId.current);
        if (result) { await acceptResult(result); return; }
        if (draft.current?.submittedAt) {
          const current = await api.reviewAssessmentDraft(key);
          if (canDiscardConflictedReviewDraft(current, draft.current, false)) {
            draft.current = current; if (mounted.current) { setContext(current); showPermanentCollision(current!); } permanentCollision = true;
          }
        }
      } catch { /* If readback also fails, the original unknown request and input remain intact. */ }
      if (!permanentCollision && mounted.current) { setFailure(`${errorText(error)}。输入和原请求已保留；重试会先核对记录，不会新增一次评分。`); errorRegion.current?.focus(); }
      callbacks.current.onError(errorText(error));
    }
    finally { operation.current = false; finish(); inFlight.current = null; if (mounted.current) setBusy(false); }
  }
  async function dismiss() {
    if (operation.current || frozen) return;
    operation.current = true; setBusy(true);
    try {
      await persist();
      if (api && sent.current && !resolved.current) {
        const result = await api.problemReviewRequest(requestId.current);
        if (result) await acceptResult(result);
        else if (draft.current?.submittedAt) {
          const current = await api.reviewAssessmentDraft(key);
          if (canDiscardConflictedReviewDraft(current, draft.current, false)) {
            // Only this explicit close discards a proven, permanently occupied date slot.
            await api.deleteReviewAssessmentDraft(key, current!.revision); draft.current = null; resolved.current = true;
          }
        }
      }
      if (api && mode.kind === 'official' && !resolved.current && !invalidated) await api.skipReviewOpportunity(mode.opportunity.id);
      await callbacks.current.onDismiss();
    } catch (error) { setFailure(`未能关闭：${errorText(error)}。请重试，输入仍保留。`); callbacks.current.onError(errorText(error)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  const disabled = loading || loadFailed || busy || frozen || locked || invalidated || Boolean(saved);
  const zone = saved?.event.timeZone ?? source?.timeZone ?? context?.timeZone ?? preview?.timeZone;
  const learningDate = saved?.event.learningDate ?? source?.learningDate ?? context?.learningDate ?? preview?.learningDate;
  const title = mode.kind === 'correction' ? '修改这次自评' : mode.kind === 'official' ? autoPrompt ? '这次通过时表现如何' : '补填这次解答的自评' : '记录今天的复习';
  const previewMatchesFrozenSource = !locked || Boolean(context && preview && preview.learningDate === context.learningDate
    && preview.timeZone === context.timeZone && preview.observedAt === context.observedAt);
  const conflict = Boolean(preview?.conflictEventId && mode.kind !== 'correction' && previewMatchesFrozenSource);
  return <dialog ref={dialog} className="problem-rating-dialog" aria-labelledby={headingId} aria-describedby={descriptionId} onCancel={event => { event.preventDefault(); void dismiss(); }} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    if (/^[1-4]$/.test(event.key)) { event.preventDefault(); choose(Number(event.key) as ReviewRating); }
  }}>
    <header className="problem-rating-header"><div><p className="problem-rating-eyebrow">{mode.kind === 'official' ? '力扣官方 AC' : mode.kind === 'correction' ? '评分更正' : '主动自评'}</p><h2 id={headingId}>{saved ? '自评已记录' : title}</h2><p className="problem-rating-subject">{problem.title}</p></div><button type="button" className="problem-rating-close" aria-label="关闭自评" disabled={busy || frozen} onClick={() => { void dismiss(); }}>×</button></header>
    <div className="problem-rating-body">
      <p id={descriptionId} className="problem-rating-context">{saved ? <>学习日 <strong>{saved.event.learningDate}</strong>（{saved.event.timeZone}）</> : mode.kind === 'official' ? <>{learningDate && <>学习日 <strong>{learningDate}</strong>（{zone}） · </>}通过确认于 {timeLabel(mode.opportunity.acceptedAt, mode.opportunity.timeZone)}</> : mode.kind === 'correction' ? <>修改 {mode.event.learningDate}（{mode.event.timeZone}）的评分，原记录仍保留。</> : context?.submittedAt ? <>正在核对学习日 <strong>{context.learningDate}</strong>（{context.timeZone}）的原请求。</> : <>记录今天的回忆或重做。{learningDate && <>学习日 {learningDate}（{zone}）</>}</>}</p>
      {source?.sourceDeleted && <p className="problem-rating-warning">来源档案已删除，无法查看代码；来源与记录时间仍保留。</p>}
      {saved ? <div className="problem-rating-confirmed" role="status"><strong>{problemRatings.find(row => row.value === saved.event.effectiveRating)?.title}</strong><p>{saved.event.isInitialAssessment ? '首次评估已建立计划。' : mode.kind === 'correction' ? '评分已更正。' : ''}下次到期 {saved.plan.dueAt && timeLabel(saved.plan.dueAt, zone ?? 'UTC')}。{saved.plan.suspended && '计划已暂停，恢复后才会加入复习。'}</p></div> : <>
        <fieldset className="problem-rating-options" disabled={disabled}><legend>选择本次表现</legend>{problemRatings.map(option => <label key={option.value} className="problem-rating-option" data-selected={rating === option.value}><input type="radio" name={headingId} value={option.value} checked={rating === option.value} onChange={() => choose(option.value)} /><span><strong><kbd aria-hidden="true">{option.value}</kbd>{option.title}</strong><small>{option.hint}</small></span></label>)}</fieldset>
        <div className="problem-rating-preview" role="status" aria-live="polite">{loading ? '正在恢复自评草稿…' : previewBusy ? '正在预览安排…' : conflict ? '该学习日已有自评。请关闭后从评分历史修改。' : preview ? <>预计下次到期：<strong>{timeLabel(preview.dueAt, preview.timeZone)}</strong>{preview.affectedDates.length > 1 && <>。将更新 {preview.affectedDates.join('、')} 的记录和后续安排。</>}</> : '选择评级后显示下次安排。'}</div>
        {locked && <p className="problem-rating-warning">评级和来源已锁定，重试将核对原请求。</p>}
      </>}
      {failure && <p ref={errorRegion} tabIndex={-1} className="problem-rating-error" role="alert">{failure}</p>}
    </div>
    <footer className="problem-rating-footer"><span>{busy ? '正在保存…' : '1–4 选择评级 · Esc 关闭'}</span><div>{saved || invalidated ? <button type="button" className="button" disabled={busy || frozen} onClick={() => { void dismiss(); }}>关闭</button> : <><button type="button" className="button" disabled={busy || frozen} onClick={() => { void dismiss(); }}>稍后再评</button><button type="button" className="button primary" disabled={!api || !rating || loading || busy || frozen || conflict} onClick={() => { void submit(); }}>{busy ? '正在记录…' : locked ? '核对并重试原请求' : mode.kind === 'correction' ? '保存更正' : '记录自评并安排复习'}</button></>}</div></footer>
  </dialog>;
}
