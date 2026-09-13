import { useEffect, useState } from 'react';
import type { OfficialSubmission, OfficialVerdict } from '../shared/official';
import { dateTime } from './ui';

const verdicts: Record<OfficialVerdict, string> = {
  accepted: '通过', wrong_answer: '答案错误', compile_error: '编译错误', runtime_error: '运行错误',
  timeout: '运行超时', memory_limit: '超出内存限制', output_limit: '超出输出限制', internal_error: '判题服务异常', unknown: '查看官方结果',
};
const phases: Record<OfficialSubmission['status'], string> = {
  submitting: '正在提交', judging: '判题中', paused: '等待继续查询', completed: '判题完成', unknown: '提交状态待确认', error: '未完成提交',
};
export function OfficialJudgePanel({ records, currentCode, problemVersion, focusId, busy = false, onResume, onLogin, onOpen, onCoach }: {
  records: OfficialSubmission[]; currentCode?: string; problemVersion?: string; focusId?: string; busy?: boolean;
  onResume?: (id: string) => void; onLogin?: () => void; onOpen: (url: string) => void; onCoach?: () => void;
}) {
  const [selectedId, setSelectedId] = useState('');
  useEffect(() => { if (focusId) setSelectedId(focusId); }, [focusId]);
  const ordered = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const record = ordered.find(item => item.id === selectedId) ?? ordered[0];
  if (!record) return <section className="official-results" aria-label="力扣官方判题"><p className="field-help">提交后，在这里查看力扣的判题结果。</p></section>;
  const result = record.result;
  const pending = record.status === 'submitting' || record.status === 'judging';
  const stale = currentCode !== undefined && (record.code !== currentCode || problemVersion !== undefined && record.problemVersion !== problemVersion);
  const label = result ? verdicts[result.status] : phases[record.status];
  const tone = result?.status === 'accepted' ? 'success-text' : pending ? '' : 'warning-text';
  return <section className="official-results" aria-label="力扣官方判题" aria-busy={pending}>
    <div className="official-results-toolbar"><span className="official-origin">力扣国服 · 官方判题</span>{ordered.length > 1 && <label className="official-history-select"><span className="sr-only">官方提交记录</span><select aria-label="官方提交记录" value={record.id} onChange={event => setSelectedId(event.target.value)}>{ordered.map(item => <option value={item.id} key={item.id}>{dateTime(item.createdAt)} · {item.result ? verdicts[item.result.status] : phases[item.status]}</option>)}</select></label>}</div>
    <div className="result-summary" role="status"><strong className={tone}>{label}</strong><span>{result?.runtime}</span><span>{result?.memory}</span>{stale && <span className="old-version">针对先前代码或题面版本</span>}</div>
    {result?.passedCases !== undefined && result.totalCases !== undefined && <p className="official-case-count">{result.passedCases} / {result.totalCases} 个测试用例通过</p>}
    {record.error && <p className="field-help warning-text">{record.error.message}</p>}
    {record.status === 'unknown' && <p className="field-help">力扣可能已经收到代码。请先查看官网提交记录，确认后再决定是否重新提交。</p>}
    {result && <>
      {result.status === 'unknown' && <p className="field-help">{result.statusMessage}</p>}
      {result.compileError && <pre className="diagnostic">{result.compileError}</pre>}
      {result.runtimeError && <pre className="diagnostic">{result.runtimeError}</pre>}
      {(result.input !== undefined || result.expectedOutput !== undefined || result.actualOutput !== undefined) && <details className="case-detail" open={result.status !== 'accepted'}><summary>官方返回的用例详情</summary><dl>
        {result.input !== undefined && <><dt>输入</dt><dd><pre>{result.input}</pre></dd></>}
        {result.actualOutput !== undefined && <><dt>实际输出</dt><dd><pre>{result.actualOutput}</pre></dd></>}
        {result.expectedOutput !== undefined && <><dt>期望输出</dt><dd><pre>{result.expectedOutput}</pre></dd></>}
      </dl></details>}
    </>}
    <div className="compact-actions">
      {record.status === 'paused' && onResume && <button className="button" disabled={busy} onClick={() => onResume(record.id)}>继续查询</button>}
      {record.error && ['authentication', 'verification'].includes(record.error.code) && onLogin && <button className="button" disabled={busy} onClick={onLogin}>登录力扣</button>}
      {record.resultUrl && <button className="text-button" onClick={() => onOpen(record.resultUrl!)}>查看官方记录 ↗</button>}
      {record.status === 'unknown' && <button className="text-button" onClick={() => onOpen(`https://leetcode.cn/problems/${record.slug}/submissions/`)}>查看官网提交记录 ↗</button>}
      {result && result.status !== 'accepted' && !stale && onCoach && <button className="text-button" onClick={onCoach}>让 AI 帮我分析</button>}
    </div>
    <details className="official-code-snapshot"><summary>本次提交的代码 · {record.language === 'python' ? 'Python3' : 'Java'}</summary><pre className="archive-code">{record.code}</pre></details>
  </section>;
}
