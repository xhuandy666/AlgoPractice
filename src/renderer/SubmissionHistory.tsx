import { memo, useEffect, useId, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import type { Language } from '../runner/types';
import type { SubmissionHistoryItem } from '../shared/submission-history';
import type { AnswerFormat } from '../shared/answer-format';
import { dateTime, errorText, statusText } from './ui';
import './submission-history.css';

const verdicts = { accepted: '通过', wrong_answer: '答案错误', compile_error: '编译错误', runtime_error: '运行错误', timeout: '超出时间限制', memory_limit: '超出内存限制', output_limit: '超出输出限制', internal_error: '判题异常', unknown: '结果待确认' };
const phases = { submitting: '正在提交', judging: '正在判题', paused: '判题已暂停', completed: '判题完成', unknown: '结果待确认', error: '提交未完成' };
export function submissionStatus(item: SubmissionHistoryItem) {
  return item.source === 'official' ? (item.verdict ? verdicts[item.verdict] : phases[item.status as keyof typeof phases] ?? '结果待确认') : statusText[item.status as keyof typeof statusText] ?? item.status;
}
export function submissionTone(item: SubmissionHistoryItem) {
  if (item.status === 'passed' || item.verdict === 'accepted') return 'success-text';
  if (item.verdict && item.verdict !== 'unknown' || ['failed', 'compile_error', 'runtime_error', 'timeout', 'error'].includes(item.status)) return 'error-text';
  return 'muted';
}
export const SubmissionHistory = memo(function SubmissionHistory({ api, problemId, language, answerFormat, refreshKey, selectedKey, busy, active, onSelect, onArchives }: {
  api?: DesktopBridge; problemId: string; language: Language; refreshKey: string; selectedKey?: string;
  answerFormat?: AnswerFormat;
  busy: boolean; active: boolean; onSelect: (item: SubmissionHistoryItem) => void; onArchives: () => void;
}) {
  const [items, setItems] = useState<SubmissionHistoryItem[]>([]);
  const [offset, setOffset] = useState(0); const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const formatFilterId = useId();
  const [formatFilter, setFormatFilter] = useState<'current' | 'all' | AnswerFormat>(answerFormat ? 'current' : 'all');
  const selectedFormat = formatFilter === 'current' ? answerFormat : formatFilter === 'all' ? undefined : formatFilter;
  useEffect(() => { setOffset(0); setItems([]); }, [problemId, language, selectedFormat]);
  useEffect(() => {
    if (!api || !active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { if (timer) return; timer = setTimeout(() => { timer = undefined; setRetry(value => value + 1); }, 250); };
    const remove = api.onLibraryChanged(refresh), removeMaintenance = api.onMaintenanceEnd(refresh);
    return () => { remove(); removeMaintenance(); if (timer) clearTimeout(timer); };
  }, [api, active]);
  useEffect(() => {
    if (!api || !active) return;
    let alive = true; setLoading(true); setError('');
    void api.submissionHistory({ problemId, language, answerFormat: selectedFormat, offset, limit: 20 }).then(page => {
      if (!alive) return;
      if (!page.items.length && offset > 0) { setOffset(Math.max(0, Math.ceil(page.total / 20 - 1) * 20)); return; }
      setItems(page.items); setTotal(page.total);
    }).catch(error => { if (alive) setError(errorText(error)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, active, problemId, language, selectedFormat, offset, refreshKey, retry]);
  return <section className="submission-history" aria-label="提交历史" aria-busy={loading}>
    <div className="submission-history-heading"><h2>历史提交 <span>{total} 次</span></h2><span className="muted">{language === 'python' ? 'Python' : 'Java'} · 全部练习</span></div>
    <div className="submission-format-filter"><label htmlFor={formatFilterId}>答题格式筛选</label><select id={formatFilterId} value={formatFilter} disabled={busy} onChange={event => setFormatFilter(event.target.value as typeof formatFilter)}>
      {answerFormat && <option value="current">当前格式（{answerFormat === 'acm' ? 'ACM' : '函数式'}）</option>}
      <option value="all">全部格式</option><option value="function">函数式</option><option value="acm">ACM</option>
    </select></div>
    {error ? <div role="alert"><p>{error}</p><button className="text-button" onClick={() => setRetry(value => value + 1)}>重试读取</button></div> : items.length ? <ol>
      {items.map(item => <li key={`${item.source}:${item.id}`}><button data-submission-id={item.id} disabled={busy} aria-pressed={selectedKey === `${item.source}:${item.id}`} className={selectedKey === `${item.source}:${item.id}` ? 'active' : ''} onClick={() => onSelect(item)}>
        <span className="history-row"><strong>{item.source === 'official' ? '力扣提交' : '本地运行'}</strong><span className={`submission-status-dot ${submissionTone(item)}`} aria-hidden="true" /></span>
        <span className="submission-format-tag">{item.answerFormat === 'acm' ? 'ACM' : item.answerFormat === 'function' ? '函数式' : '格式未记录'}</span>
        <span className={submissionTone(item)}>{submissionStatus(item)}</span><time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time>
        {item.remark && <span className="submission-remark-preview">{item.remark}</span>}
      </button></li>)}
    </ol> : <div className="history-empty"><p>{loading ? '正在读取…' : '还没有提交记录'}</p></div>}
    {total > 20 && <div className="submission-pagination"><button className="text-button" disabled={loading || busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页</button><span>{Math.floor(offset / 20) + 1} / {Math.ceil(total / 20)}</span><button className="text-button" disabled={loading || busy || offset + 20 >= total} onClick={() => setOffset(value => value + 20)}>下一页</button></div>}
    <button className="text-button submission-archives" onClick={onArchives}>查看所有练习档案</button>
  </section>;
});
