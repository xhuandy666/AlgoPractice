import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import { SUBMISSION_REMARK_LIMIT, type SubmissionHistoryDetail, type SubmissionRemark } from '../shared/submission-history';
import { Editor } from './Editor';
import { editsFrozen, registerPendingSave, useEditsFrozen } from './pending-saves';
import { dateTime, errorText } from './ui';
import { submissionStatus, submissionTone } from './SubmissionHistory';

const noop = () => {};
export const HistoricalCodePanel = memo(function HistoricalCodePanel({ api, record, busy, onClose, onRemarkSaved }: {
  api: DesktopBridge; record: SubmissionHistoryDetail; busy: boolean; onClose: () => void; onRemarkSaved: (remark: SubmissionRemark) => void;
}) {
  const [remark, setRemark] = useState(record.remark); const [status, setStatus] = useState('');
  const [failure, setFailure] = useState(''); const [copied, setCopied] = useState(false);
  const frozen = useEditsFrozen() || busy;
  const current = useRef({ text: record.remark, saved: record.remark, revision: record.remarkRevision });
  const inFlight = useRef<Promise<void> | null>(null); const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacks = useRef(onRemarkSaved); callbacks.current = onRemarkSaved;
  const alive = useRef(true);
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (inFlight.current) { await inFlight.current; return; }
    const work = async () => {
      while (current.current.text !== current.current.saved) {
        const text = current.current.text;
        if (alive.current) { setStatus('正在保存…'); setFailure(''); }
        try {
          const saved = await api.saveSubmissionRemark({ source: record.source, id: record.id, remark: text, expectedRevision: current.current.revision });
          current.current.saved = text; current.current.revision = saved.remarkRevision;
          if (alive.current) { setStatus('已保存'); callbacks.current(saved); }
        } catch (error) {
          // Refresh only the revision. Keep the user's input for an explicit retry,
          // including when a successful save's IPC response was lost.
          try {
            const latest = await api.submissionHistoryDetail(record.source, record.id);
            current.current.revision = latest.remarkRevision; current.current.saved = latest.remark;
          } catch { /* A transport failure must not discard the draft. */ }
          if (alive.current) { setStatus(''); setFailure(errorText(error)); }
          throw error;
        }
      }
      if (alive.current) setFailure('');
    };
    const promise = work(); inFlight.current = promise;
    try { await promise; } finally { inFlight.current = null; }
  }, [api, record.id, record.source]);
  useEffect(() => {
    alive.current = true;
    const remove = registerPendingSave(`提交备注:${record.source}:${record.id}`, flush);
    return () => { alive.current = false; remove(); if (timer.current) clearTimeout(timer.current); };
  }, [flush, record.id, record.source]);
  const save = () => { void flush().catch(() => {}); };
  return <section className="results-pane historical-code-panel" aria-label="历史代码">
    <div className="historical-code-heading"><div><strong>历史代码 <span className="historical-readonly">只读</span></strong><p><span className={submissionTone(record)}>{submissionStatus(record)}</span><span>{record.source === 'official' ? '力扣提交' : '本地运行'} · {record.language === 'python' ? 'Python' : 'Java'}</span><time dateTime={record.createdAt}>{dateTime(record.createdAt)}</time></p></div><div className="historical-code-actions"><button className="text-button" disabled={frozen} onClick={() => { void api.copyCode(record.code).then(() => setCopied(true)).catch(error => setFailure(errorText(error))); }}>{copied ? '已复制' : '复制代码'}</button><button className="text-button" disabled={frozen} onClick={onClose}>返回运行结果</button></div></div>
    <div className="submission-remark"><label htmlFor="submission-remark">备注</label><input id="submission-remark" aria-label="提交备注" value={remark} maxLength={SUBMISSION_REMARK_LIMIT} disabled={frozen} placeholder="例如：哈希表 · 一次遍历（选填）" onChange={event => {
      if (editsFrozen() || busy) return;
      const value = event.target.value; current.current.text = value; setRemark(value); setStatus(''); setFailure('');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(save, 650);
    }} onBlur={save} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); save(); } }} /><span role="status">{status}</span></div>
    {failure && <div className="submission-save-error" role="alert"><span>{failure}</span><button className="text-button" onClick={save}>重试保存备注</button></div>}
    <Editor code={record.code} language={record.language} label="历史提交代码" readOnly onChange={noop} onRun={noop} />
  </section>;
});
