import { useEffect, useId, useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import { languageLabel, type Language } from '../shared/languages';
import { Markdown } from './Markdown';
import { loadReviewReference, type ReviewReference } from './review-reference';
import { dateTime, errorText } from './ui';
import './review-reference.css';

/** The compare step of a recall review: the learner's own latest passing code and notes for the problem, opened only
 * on request so that recalling comes first. It reads records; it never edits the review draft or rates anything. */
export function ReviewReferenceDialog({ api, problem, language, canRate, onRate, onClose }: {
  api: DesktopBridge; problem: { id: string; title: string }; language: Language;
  /** Today's rating is still open, so the dialog can lead straight into it. */
  canRate: boolean; onRate: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const [reference, setReference] = useState<ReviewReference | null>(null), [failure, setFailure] = useState('');
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current; if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let alive = true; setReference(null); setFailure('');
    void loadReviewReference(api, problem.id, language).then(value => { if (alive) setReference(value); }).catch(error => { if (alive) setFailure(errorText(error)); });
    return () => { alive = false; };
  }, [api, problem.id, language]);
  const code = reference?.code;
  return <dialog ref={dialog} className="review-reference" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <header className="review-reference-heading"><div><h2 id={titleId}>对照上次的解法</h2><p>{problem.title} · 只读，不会改动这次的复习草稿</p></div><button type="button" className="text-button" onClick={onClose}>关闭</button></header>
    {failure ? <p className="error-text" role="alert">没能读取记录：{failure}</p> : !reference ? <p className="review-reference-empty" role="status">正在读取你的记录…</p> : <>
      <section aria-label="上次通过的代码"><h3>上次通过的代码</h3>
        {code ? <><p className="review-reference-meta">{code.source === 'official' ? '力扣官方通过' : '本地测试通过'} · {languageLabel(code.language)}{code.answerFormat === 'acm' ? ' · ACM 格式' : ''} · {dateTime(code.createdAt)}{code.language !== language ? ` · 这道题没有 ${languageLabel(language)} 的通过记录` : ''}</p><pre className="review-reference-code" tabIndex={0}><code>{code.code}</code></pre></>
          : <p className="review-reference-empty">这道题还没有通过的代码记录。</p>}
      </section>
      <section aria-label="这道题的笔记"><h3>这道题的笔记</h3>
        {reference.notes.length ? reference.notes.map(note => <article key={note.id} className="review-reference-note"><h4>{note.title || '未命名笔记'}<span>{dateTime(note.updatedAt)}</span></h4><Markdown text={note.markdown} /></article>)
          : <p className="review-reference-empty">这道题还没有笔记。复习时想到的要点，可以用“记笔记”留给下一次。</p>}
      </section>
    </>}
    <footer className="review-reference-actions">{canRate && <button type="button" className="button primary" onClick={onRate}>对照完了，去自评</button>}<button type="button" className="button" onClick={onClose}>{canRate ? '继续作答' : '关闭'}</button></footer>
  </dialog>;
}
