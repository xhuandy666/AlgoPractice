import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge, RunArchive } from '../shared/bridge';
import type { Attempt } from '../storage/practice-store';
import type { AiEvent, AiKind, AiLevel, AiPatchApplication, AiProviderState, AiRequestRecord } from '../shared/ai';
import type { Note, NoteListItem } from '../shared/learning';
import { CodeComparison } from './CodeComparison';
import { Markdown } from './Markdown';
import { dateTime, errorText } from './ui';
import { useEditsFrozen } from './pending-saves';

const levels: { value: AiLevel; title: string }[] = [{ value: 'L0', title: 'L0 · 理解题意' }, { value: 'L1', title: 'L1 · 找到方向' }, { value: 'L2', title: 'L2 · 局部线索' }, { value: 'L3', title: 'L3 · 定位与纠错' }, { value: 'L4', title: 'L4 · 完整解法' }];
const phaseLabels: Record<AiEvent['phase'], string> = { queued: '请求已保存', connecting: '正在连接模型', receiving: '正在接收回答', validating: '正在检查回答', repairing: '正在修正回答格式', completed: '回答已保存', failed: '请求失败', cancelled: '已停止', interrupted: '请求已中断' };
const statusLabels: Record<AiRequestRecord['status'], string> = { pending: '等待响应', streaming: '正在接收', repairing: '修正格式中', completed: '已完成', failed: '未取得可用回答', cancelled: '已停止', interrupted: '应用中断' };
export function AiPanel({ api, attempt, code, selectedRun, onApply, onNoteSaved, onSettings, onError, flush, reviewMode = false, active = true }: {
  reviewMode?: boolean; active?: boolean;
  api: DesktopBridge | undefined; attempt: Attempt | null; code: string; selectedRun: RunArchive | null;
  onApply: (requestId: string) => Promise<void>; onNoteSaved: (note: Note) => void; onSettings: () => void;
  onError: (message: string) => void; flush: () => Promise<unknown>;
}) {
  const [provider, setProvider] = useState<AiProviderState | null>(null); const [requests, setRequests] = useState<AiRequestRecord[]>([]);
  const [notes, setNotes] = useState<NoteListItem[]>([]); const [noteIds, setNoteIds] = useState<string[]>([]); const [includeHistory, setIncludeHistory] = useState(false);
  const [noteSearch, setNoteSearch] = useState(''); const [notePage, setNotePage] = useState(0); const [noteTotal, setNoteTotal] = useState(0);
  const [question, setQuestion] = useState(''); const [level, setLevel] = useState<AiLevel>('L0'); const [unlocked, setUnlocked] = useState(false);
  const [useSelectedRun, setUseSelectedRun] = useState(false); const [event, setEvent] = useState<AiEvent | null>(null); const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(''); const [patch, setPatch] = useState<AiPatchApplication | null>(null); const [message, setMessage] = useState('');
  const working = useRef(false); const generation = useRef(0); const frozen = useEditsFrozen();
  const load = useCallback(async () => {
    if (!api || !active) return; const token = ++generation.current;
    const [state, records] = await Promise.all([api.aiProvider(), attempt ? api.aiRequests(attempt.id) : Promise.resolve([])]);
    if (token !== generation.current) return; setProvider(state); setRequests(records); 
    const activeRequest = records.find(record => ['pending', 'streaming', 'repairing'].includes(record.status)); setActiveId(activeRequest?.id ?? null);
  }, [api, attempt?.id, active]);
  useEffect(() => { if (!active) return; void load().catch(error => onError(errorText(error))); const remove = api?.onLibraryChanged(() => { void load().catch(error => onError(errorText(error))); }); const unlisten = api?.onAiEvent(next => {
    if (next.attemptId !== attempt?.id) return; setEvent(next);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(next.phase)) { setActiveId(null); void load().catch(error => onError(errorText(error))); } else setActiveId(next.requestId);
  }); return () => { generation.current++; remove?.(); unlisten?.(); }; }, [api, load, attempt?.id, active]);
  useEffect(() => { if (!active) return; let alive = true; const timer = setTimeout(() => { if (api && attempt) void api.notePage({ confirmedOnly: true, relevantProblemId: attempt.problemId, search: noteSearch, offset: notePage * 20, limit: 20 }).then(value => { if (alive) { setNotes(value.items); setNoteTotal(value.total); } }).catch(error => { if (alive) onError(errorText(error)); }); }, 150); return () => { alive = false; clearTimeout(timer); }; }, [api, attempt?.problemId, noteSearch, notePage, requests, active]);
  useEffect(() => { setUnlocked(false); setPatch(null); }, [level]);
  const canAsk = Boolean(api && (attempt?.isActive || reviewMode && attempt) && provider?.hasKey && !activeId && !busy && !frozen);
  async function ask(kind: AiKind = 'hint') {
    if (!api || !attempt || !canAsk || working.current || (level === 'L4' && !unlocked)) return;
    working.current = true; setBusy('request'); setPatch(null); setMessage('');
    const requestId = crypto.randomUUID(); const currentAttempt = attempt.id;
    try {
      await flush(); setActiveId(requestId);
      const record = await api.askAi({ requestId, attemptId: currentAttempt, kind, level, question: question.trim() || (reviewMode ? '请复盘本场冻结代码与文字思路。根据所提供的运行证据解释问题，把复杂度和可读性作为附依据与不确定性的建议。没有文字思路时不要评价表达能力，不生成总分或企业通过概率。' : kind === 'diagnosis' ? '请根据这次运行的事实，帮助我定位问题。' : kind === 'note-draft' ? '请整理本次练习中值得复习的要点，形成笔记草稿。' : '请给我当前等级的帮助，让我继续自己思考。'),
        ...(useSelectedRun && selectedRun?.attemptId === currentAttempt ? { runId: selectedRun.id } : {}), noteIds,
        conversationIds: includeHistory ? requests.filter(previous => previous.status === 'completed').slice(-4).map(previous => previous.id) : [], unlockCompleteSolution: level === 'L4' && unlocked });
      setRequests(previous => [...previous.filter(item => item.id !== record.id), record]); setQuestion(''); setUnlocked(false);
    } catch (error) { onError(errorText(error)); } finally { working.current = false; setBusy(''); setActiveId(null); }
  }
  async function preview(record: AiRequestRecord) {
    if (!api || busy || frozen) return; setBusy(record.id); setMessage('');
    try { await flush(); setPatch(await api.previewAiPatch(record.id)); } catch (error) { onError(errorText(error)); } finally { setBusy(''); }
  }
  async function apply() {
    if (!patch || busy || frozen) return; setBusy('patch');
    try { await onApply(patch.requestId); setPatch(null); setMessage('修改已应用到当前草稿。请运行本地用例检查。'); } catch (error) { onError(errorText(error)); } finally { setBusy(''); }
  }
  async function saveNote(record: AiRequestRecord) {
    if (!api || busy || frozen) return; setBusy(record.id);
    try { onNoteSaved(await api.saveAiNoteDraft(record.id)); } catch (error) { onError(errorText(error)); } finally { setBusy(''); }
  }
  if (!active) return null;
  return <section className="ai-panel" aria-label="AI 分级帮助"><h3>留一点空间，自己想通</h3><p className="field-help">选择帮助等级，再主动发送。回答依据对应的代码与运行快照。</p>
    {!provider?.hasKey && <div className="empty-state"><p>先配置你自己的模型接口与 Key。</p><button className="button" onClick={onSettings}>配置 AI</button></div>}
    {!attempt?.isActive && !reviewMode && <p className="field-help">开始一次练习后，可以请求分级帮助。已结束练习的回答保留在档案中。</p>}
    <label className="p3-field">帮助等级<select aria-label="AI 帮助等级" value={level} disabled={Boolean(activeId || busy) || frozen} onChange={change => setLevel(change.target.value as AiLevel)}>{levels.map(option => <option key={option.value} value={option.value}>{option.title}</option>)}</select></label>
    {level === 'L4' && <div className="ai-unlock"><p>完整解法可能影响独立练习。每次请求前需要明确解锁。</p><button className="button" disabled={unlocked || Boolean(activeId || busy) || frozen} onClick={() => setUnlocked(true)}>{unlocked ? '本次已解锁' : '解锁本次完整解法'}</button></div>}
    <label className="p3-field">想问什么<textarea aria-label="AI 提问" value={question} maxLength={4000} disabled={Boolean(activeId || busy) || frozen} placeholder="例如：我的循环边界在哪里出了问题？" onChange={change => setQuestion(change.target.value)} /></label>
    <details><summary>本次发送的上下文</summary><div className="p3-form"><p className="field-help">当前题面与代码、匹配代码的运行证据。其余档案不会自动发送。</p><label className="checkbox-field"><input type="checkbox" checked={includeHistory} disabled={Boolean(activeId || busy) || frozen} onChange={change => setIncludeHistory(change.target.checked)} />带上最近四次已完成的对话</label>{selectedRun && selectedRun.attemptId === attempt?.id && <label className="checkbox-field"><input type="checkbox" checked={useSelectedRun} disabled={Boolean(activeId || busy) || frozen} onChange={change => setUseSelectedRun(change.target.checked)} />分析当前选中的运行快照{selectedRun.code !== code ? '（旧代码）' : ''}</label>}<p className="field-help">最多选择 3 篇已确认笔记（当前 {noteIds.length} 篇）。</p><label>搜索已确认笔记<input type="search" aria-label="搜索引用笔记" value={noteSearch} onChange={event => { setNoteSearch(event.target.value); setNotePage(0); }} /></label>{notes.map(note => <label className="checkbox-field" key={note.id}><input type="checkbox" checked={noteIds.includes(note.id)} disabled={Boolean(activeId || busy) || frozen || (!noteIds.includes(note.id) && noteIds.length >= 3)} onChange={change => setNoteIds(previous => change.target.checked ? [...previous, note.id] : previous.filter(id => id !== note.id))} />{note.confirmed!.title}</label>)}<div className="pagination"><span>{noteTotal} 篇 · 第 {notePage + 1} / {Math.max(1, Math.ceil(noteTotal / 20))} 页</span><button disabled={notePage === 0} onClick={() => setNotePage(notePage - 1)}>上一页</button><button disabled={(notePage + 1) * 20 >= noteTotal} onClick={() => setNotePage(notePage + 1)}>下一页</button></div>{noteIds.length > 0 && <button className="text-button" disabled={Boolean(activeId || busy) || frozen} onClick={() => setNoteIds([])}>清空已选笔记</button>}</div></details>
    <div className="button-row">{activeId ? <button className="button" onClick={() => { void api?.cancelAi(activeId).catch(error => onError(errorText(error))); }}>停止 AI 请求</button> : <button className="button primary" disabled={!canAsk || (level === 'L4' && !unlocked)} onClick={() => { void ask(); }}>请求这个等级的帮助</button>}</div>
    <div className="compact-actions"><button className="text-button" disabled={!canAsk || (level === 'L4' && !unlocked)} onClick={() => { void ask('diagnosis'); }}>分析错误证据</button><button className="text-button" disabled={!canAsk || (level === 'L4' && !unlocked)} onClick={() => { void ask('note-draft'); }}>总结为笔记草稿</button></div>
    {event && activeId && <p role="status" className="ai-status">{phaseLabels[event.phase]}{event.receivedBytes === undefined ? '' : ` · 已接收 ${Math.ceil(event.receivedBytes / 1024)} KiB`}。内容通过检查后展示。</p>}
    {message && <p role="status" className="success-text">{message}</p>}
    <div className="ai-request-list">{[...requests].reverse().map(record => <article className="ai-request" key={record.id}><header><strong>{record.snapshot.level} · {statusLabels[record.status]}</strong><time>{dateTime(record.createdAt)}</time></header><p className="ai-question">{record.snapshot.question}</p>{record.snapshot.code !== code && <p className="ai-status warning-text">针对先前代码版本</p>}{record.response ? <><h3>{record.response.title}</h3><Markdown text={record.response.explanation} onOpenLink={url => { void api?.openWebLink(url).catch(error => onError(errorText(error))); }} />{record.response.nextSteps.length > 0 && <ol>{record.response.nextSteps.map((step, index) => <li key={index}><Markdown text={step} /></li>)}</ol>}{record.response.evidence.length > 0 && <details><summary>使用的运行证据</summary>{record.response.evidence.map((evidence, index) => <pre className="diagnostic" key={index}>{evidence.quote}</pre>)}</details>}{record.response.inferences.length > 0 && <details><summary>需要验证的判断</summary>{record.response.inferences.map((inference, index) => <div key={index}><Markdown text={inference.text} /><p className="field-help">依据：{inference.reason}</p></div>)}</details>}{record.response.completeSolution && <details><summary>查看已解锁的完整解法</summary><Markdown text={record.response.completeSolution.explanation} /><pre className="archive-code">{record.response.completeSolution.code}</pre></details>}{!reviewMode && (record.response.patch || record.response.completeSolution) && <button className="button" disabled={Boolean(busy) || frozen} onClick={() => { void preview(record); }}>预览修改建议</button>}{record.response.noteDraft && <div><h4>{record.response.noteDraft.title}</h4><Markdown text={record.response.noteDraft.markdown} /><button className="button" disabled={Boolean(busy) || frozen} onClick={() => { void saveNote(record); }}>保存为笔记草稿</button></div>}{patch && patch.requestId === record.id && <div><p className="field-help">应用前会再次核对代码版本。修改本身不会自动运行或判为正确。</p><CodeComparison before={record.snapshot.code} after={patch.code} language={patch.language} label="AI 修改差异" /><div className="compact-actions"><button className="button primary" disabled={Boolean(busy) || frozen} onClick={() => { void apply(); }}>应用到当前草稿</button><button className="text-button" onClick={() => setPatch(null)}>收起差异</button></div></div>}</> : record.error ? <p role="alert" className="error-text">{record.error.message}</p> : <p className="ai-status">正在等待可用的回答。</p>}{record.cachedFromRequestId && <p className="ai-status">复用了完全相同请求的已完成回答。</p>}<p className="ai-status">{record.usage?.totalTokens === null || !record.usage ? '用量未知' : `供应商报告 ${record.usage.totalTokens} Token`} · {record.snapshot.provider.model}</p></article>)}</div>
  </section>;
}
