import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Adapter, RunResult, WireValue } from '../runner/types';
import { formatSelfTestInput, parseSelfTestInput } from '../shared/self-test';
import { readSelfTestInput, saveSelfTestInput } from './self-test-store';
import { registerPendingSave } from './pending-saves';
import { errorText, formatValue, shortcut, statusClass, statusText } from './ui';
import './self-test.css';

/** One self-written input for a function problem. It answers "what does my code return for this?" and nothing else:
 * there is no expected output, so the outcome is shown, never judged, and nothing is added to the run history. */
export function SelfTestPanel({ problemId, adapter, names, sample, disabled, outcome, onRun }: {
  problemId: string; adapter: Adapter;
  /** Parameter names in signature order, when the template reveals them. */
  names: readonly string[] | null;
  /** Arguments of the problem's first case, offered as a starting point. */
  sample?: readonly WireValue[];
  disabled: boolean;
  /** The last self-test, with the exact input submitted; `stale` when the code changed since. */
  outcome: { result: RunResult; stale: boolean; input: string } | null;
  onRun: (args: WireValue[], input: string) => void;
}) {
  const [text, setText] = useState(() => readSelfTestInput(problemId) ?? (sample ? formatSelfTestInput(sample) : ''));
  const [problem, setProblem] = useState(''); const helpId = useId(), errorId = useId();
  const saved = useRef(text), latest = useRef(text); latest.current = text;
  const flush = useCallback(() => {
    if (saved.current !== latest.current) { saveSelfTestInput(problemId, latest.current); saved.current = latest.current; }
  }, [problemId]);
  // Debounce ordinary typing, but join the same quit/maintenance handshake as the code draft.
  useEffect(() => registerPendingSave(`self-test-input:${helpId}`, async () => { flush(); }), [helpId, flush]);
  useEffect(() => { const timer = setTimeout(flush, 400); return () => clearTimeout(timer); }, [text, flush]);
  useEffect(() => flush, [flush]);
  const changeText = (value: string) => { latest.current = value; setText(value); if (problem) setProblem(''); };
  const run = () => {
    if (disabled) return;
    try { const args = parseSelfTestInput(text, adapter, names); setProblem(''); onRun(args, text); } catch (error) { setProblem(errorText(error)); }
  };
  const test = outcome?.result.caseResults[0];
  return <section className="self-test" aria-label="自测输入">
    <div className="self-test-heading"><strong>自测输入</strong><span>只运行这一组输入并显示输出；不判对错，不计入运行记录。</span></div>
    <label className="self-test-field"><span id={helpId}>每行一个参数，按函数参数的顺序{names ? `：${names.join('、')}` : `，共 ${adapter.params.length} 行`}</span>
      <textarea aria-label="自测输入内容" aria-describedby={problem ? `${helpId} ${errorId}` : helpId} aria-invalid={problem ? true : undefined} rows={Math.min(8, Math.max(2, adapter.params.length))} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={text}
        onChange={event => changeText(event.target.value)}
        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); run(); } }} /></label>
    {problem && <p id={errorId} className="self-test-error error-text" role="alert">{problem}</p>}
    <div className="button-row"><button type="button" className="button" disabled={disabled} title={`${shortcut('Enter')}（光标在输入框内时）`} onClick={run}>运行这组输入</button>
      {sample && <button type="button" className="text-button" disabled={disabled} onClick={() => changeText(formatSelfTestInput(sample))}>填入示例 1</button>}</div>
    {outcome && <div className="self-test-result" role="status" data-status={outcome.result.status}>
      <p><strong className={statusClass(outcome.result.status)}>{outcome.result.status === 'completed' ? '运行完成' : statusText[outcome.result.status]}</strong><span>{Math.round(outcome.result.durationMs)} ms</span>{outcome.stale && <span className="old-version">针对先前的代码</span>}{outcome.input !== text && <span className="old-version">针对先前的输入</span>}</p>
      <dl>
        <dt>本次输入</dt><dd><pre>{outcome.input}</pre></dd>
        {test && <><dt>输出</dt><dd><pre>{formatValue(test.actual)}</pre></dd></>}
        {(test?.stdout || outcome.result.stdout) && <><dt>标准输出</dt><dd><pre>{test?.stdout || outcome.result.stdout}</pre></dd></>}
        {test?.stderr && <><dt>标准错误</dt><dd><pre>{test.stderr}</pre></dd></>}
        {outcome.result.diagnostics.length > 0 && <><dt>错误信息</dt><dd>{outcome.result.diagnostics.map((diagnostic, index) => <pre key={index}>{diagnostic.line && diagnostic.source === 'user' ? `第 ${diagnostic.line} 行：` : ''}{diagnostic.message}</pre>)}</dd></>}
      </dl>
    </div>}
  </section>;
}
