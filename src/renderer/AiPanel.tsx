import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DesktopBridge, RunArchive } from '../shared/bridge';
import type { Attempt } from '../storage/practice-store';
import type { AiEvent, AiKind, AiPatchApplication, AiProviderState, AiRequestRecord } from '../shared/ai';
import type { Note } from '../shared/learning';
import { CodeComparison } from './CodeComparison';
import { Markdown } from './Markdown';
import { HelpHint } from './HelpHint';
import { dateTime, errorText } from './ui';
import { useEditsFrozen } from './pending-saves';
import './ai-chat.css';

const phaseLabels: Record<AiEvent['phase'], string> = { queued: '请求已保存', connecting: '正在连接模型', receiving: '正在接收回答', validating: '正在检查回答', repairing: '正在修正回答格式', completed: '回答已保存', failed: '请求失败', cancelled: '已停止', interrupted: '请求已中断' };
const statusLabels: Record<AiRequestRecord['status'], string> = { pending: '正在准备回答', streaming: '正在接收回答', repairing: '正在检查回答格式', completed: '已完成', failed: '未取得可用回答', cancelled: '已停止', interrupted: '请求已中断' };
const pendingStatuses = new Set(['pending', 'streaming', 'repairing']);
const terminalPhases = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
type LocalTurn = { id: string; attemptId: string; kind: AiKind; question: string; createdAt: string; status: 'pending' | 'failed' | 'cancelled'; error?: string };
type Operation = { id: string; scope: number; cancelled: boolean; sent: boolean };
// UI drafts only, bounded and in-memory: switching tabs must not discard an unsent question.
const inputDrafts = new Map<string, string>();
function rememberInput(attemptId: string | undefined, text: string) {
  if (!attemptId) return;
  inputDrafts.delete(attemptId);
  if (text) inputDrafts.set(attemptId, text);
  while (inputDrafts.size > 20) inputDrafts.delete(inputDrafts.keys().next().value!);
}
function questionLabel(kind: AiKind, question: string) {
  return question || ({ chat: '聊聊这道题', hint: '给点提示', diagnosis: '检查代码', 'official-review': '分析这次官方提交', 'note-draft': '总结为笔记草稿' } satisfies Record<AiKind, string>)[kind];
}

export function AiPanel({ api, attempt, code, onApply, onNoteSaved, onSettings, onError, flush, reviewMode = false, active = true }: {
  reviewMode?: boolean; active?: boolean;
  api: DesktopBridge | undefined; attempt: Attempt | null; code: string; selectedRun: RunArchive | null;
  onApply: (requestId: string) => Promise<void>; onNoteSaved: (note: Note) => void; onSettings: () => void;
  onError: (message: string) => void; flush: () => Promise<unknown>;
}) {
  const [provider, setProvider] = useState<AiProviderState | null>(null);
  const [requests, setRequests] = useState<AiRequestRecord[]>([]);
  const [localTurns, setLocalTurns] = useState<LocalTurn[]>([]);
  const [question, setQuestion] = useState(() => attempt ? inputDrafts.get(attempt.id) ?? '' : '');
  const [event, setEvent] = useState<AiEvent | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [autoSaving, setAutoSaving] = useState(false);
  const [pendingAutoValue, setPendingAutoValue] = useState<boolean | null>(null);
  const [patch, setPatch] = useState<AiPatchApplication | null>(null);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [settingError, setSettingError] = useState('');
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const conversation = useRef<HTMLDivElement>(null);
  const pinnedToLatest = useRef(true);
  const composing = useRef(false);
  const operation = useRef<Operation | null>(null);
  const actionWorking = useRef(false);
  const settingWorking = useRef(false);
  const scope = useRef(0);
  const scopeKey = `${attempt?.id ?? 'none'}:${active}:${reviewMode}`;
  const lastScopeKey = useRef(scopeKey);
  const draftAttempt = useRef(attempt?.id);
  const loadSequence = useRef(0);
  const frozen = useEditsFrozen();
  // Invalidate callbacks before effect cleanup when the attempt or panel visibility changes.
  if (lastScopeKey.current !== scopeKey) { lastScopeKey.current = scopeKey; scope.current++; }
  const current = (token: number) => scope.current === token;

  const load = useCallback(async () => {
    if (!api || !active) return;
    const token = scope.current, sequence = ++loadSequence.current;
    const [state, records] = await Promise.all([api.aiProvider(), attempt ? api.aiRequests(attempt.id) : Promise.resolve([])]);
    if (scope.current !== token || loadSequence.current !== sequence) return;
    setProvider(state); setRequests(records); setLoadError('');
    setLocalTurns(previous => previous.filter(turn => !records.some(record => record.id === turn.id)));
    const pending = records.find(record => pendingStatuses.has(record.status));
    setActiveId(operation.current?.scope === token ? operation.current.id : pending?.id ?? null);
  }, [api, attempt?.id, active]);

  useEffect(() => {
    setRequests([]); setLocalTurns([]); setEvent(null); setActiveId(null);
    if (draftAttempt.current !== attempt?.id) { draftAttempt.current = attempt?.id; setQuestion(attempt ? inputDrafts.get(attempt.id) ?? '' : ''); }
    setBusy(''); setPatch(null); setMessage(''); setLoadError(''); setSettingError(''); setProvider(null);
    setAutoSaving(false); setPendingAutoValue(null); setAwayFromLatest(false); pinnedToLatest.current = true;
    operation.current = null; actionWorking.current = false; settingWorking.current = false; composing.current = false;
    if (!active) return;
    const token = scope.current;
    const failedLoad = (error: unknown) => { if (scope.current === token) { setLoadError(errorText(error)); onError(errorText(error)); } };
    void load().catch(failedLoad);
    const remove = api?.onLibraryChanged(() => { void load().catch(failedLoad); });
    const unlisten = api?.onAiEvent(next => {
      if (scope.current !== token || next.attemptId !== attempt?.id) return;
      setEvent(next);
      if (terminalPhases.has(next.phase)) {
        setActiveId(previous => previous === next.requestId ? null : previous);
        void load().catch(failedLoad);
      } else {
        setActiveId(next.requestId);
        // An automatic official analysis has no optimistic renderer turn.
        if (next.phase === 'queued' && operation.current?.id !== next.requestId) void load().catch(failedLoad);
      }
    });
    return () => { scope.current++; loadSequence.current++; remove?.(); unlisten?.(); };
  }, [api, load, attempt?.id, active, reviewMode, onError]);

  useLayoutEffect(() => {
    if (!active || !pinnedToLatest.current) return;
    const element = conversation.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [active, requests, localTurns, event, patch]);

  const strict = Boolean(attempt?.isActive && attempt.mode === 'strict');
  const hasContext = Boolean(attempt && (attempt.isActive || reviewMode));
  const configured = Boolean(provider?.hasKey && provider.config);
  const pending = requests.some(record => record.attemptId === attempt?.id && pendingStatuses.has(record.status));
  const canAsk = Boolean(api && active && hasContext && configured && !strict && !activeId && !pending && !busy && !frozen);
  const composerDisabled = !api || !hasContext || !configured || strict || Boolean(activeId || pending || busy) || frozen;
  const turns = [
    ...requests.filter(record => record.attemptId === attempt?.id).map(record => ({ id: record.id, createdAt: record.createdAt, record, local: null })),
    ...localTurns.filter(turn => turn.attemptId === attempt?.id && !requests.some(record => record.id === turn.id)).map(local => ({ id: local.id, createdAt: local.createdAt, record: null, local })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  async function ask(kind: AiKind, text = '', officialSubmissionId?: string) {
    if (!api || !attempt || !canAsk || operation.current || actionWorking.current) return;
    const askedQuestion = text.trim();
    if (kind === 'chat' && !askedQuestion) return;
    const requestId = crypto.randomUUID(), token = scope.current, attemptId = attempt.id;
    const op: Operation = { id: requestId, scope: token, cancelled: false, sent: false };
    operation.current = op; pinnedToLatest.current = true; setAwayFromLatest(false);
    setBusy('request'); setActiveId(requestId); setEvent(null); setPatch(null); setMessage('');
    setLocalTurns(previous => [...previous, { id: requestId, attemptId, kind, question: askedQuestion, createdAt: new Date().toISOString(), status: 'pending' }]);
    try {
      await flush();
      if (!current(token) || op.cancelled) {
        if (current(token)) setLocalTurns(previous => previous.map(turn => turn.id === requestId ? { ...turn, status: 'cancelled' } : turn));
        return;
      }
      op.sent = true;
      const record = await api.askAi({ requestId, attemptId, kind, question: askedQuestion,
        ...(kind === 'official-review' && officialSubmissionId ? { officialSubmissionId } : {}) });
      if (!current(token)) return;
      loadSequence.current++;
      setRequests(previous => [...previous.filter(item => item.id !== record.id), record]);
      setLocalTurns(previous => previous.filter(turn => turn.id !== requestId));
      if (kind === 'chat' && record.status === 'completed') {
        if (inputDrafts.get(attemptId)?.trim() === askedQuestion) rememberInput(attemptId, '');
        setQuestion(previous => previous.trim() === askedQuestion ? '' : previous);
      }
    } catch (error) {
      if (!current(token)) return;
      setLocalTurns(previous => previous.map(turn => turn.id === requestId ? { ...turn, status: 'failed', error: errorText(error) } : turn));
      onError(errorText(error));
    } finally {
      if (operation.current === op) {
        operation.current = null;
        if (current(token)) { setBusy(''); setActiveId(previous => previous === requestId ? null : previous); }
      }
    }
  }

  async function stop() {
    if (!api || !activeId) return;
    const token = scope.current, op = operation.current;
    if (op?.id === activeId) { op.cancelled = true; if (!op.sent) return; }
    try { await api.cancelAi(activeId); } catch (error) { if (current(token)) onError(errorText(error)); }
  }
  async function reload() {
    const token = scope.current;
    try { await load(); }
    catch (error) { if (current(token)) { setLoadError(errorText(error)); onError(errorText(error)); } }
  }
  async function preview(record: AiRequestRecord) {
    if (!api || busy || actionWorking.current || frozen || reviewMode || strict) return;
    const token = scope.current; actionWorking.current = true; setBusy(record.id); setMessage('');
    try { await flush(); if (!current(token)) return; const result = await api.previewAiPatch(record.id); if (current(token)) setPatch(result); }
    catch (error) { if (current(token)) onError(errorText(error)); }
    finally { if (current(token)) { actionWorking.current = false; setBusy(''); } }
  }
  async function apply() {
    if (!patch || busy || actionWorking.current || frozen || reviewMode || strict) return;
    const token = scope.current; actionWorking.current = true; setBusy('patch');
    try { await onApply(patch.requestId); if (current(token)) { setPatch(null); setMessage('修改已应用到当前草稿。请运行本地用例检查。'); } }
    catch (error) { if (current(token)) onError(errorText(error)); }
    finally { if (current(token)) { actionWorking.current = false; setBusy(''); } }
  }
  async function saveNote(record: AiRequestRecord) {
    if (!api || busy || actionWorking.current || frozen || strict) return;
    const token = scope.current; actionWorking.current = true; setBusy(record.id);
    try { const note = await api.saveAiNoteDraft(record.id); if (current(token)) onNoteSaved(note); }
    catch (error) { if (current(token)) onError(errorText(error)); }
    finally { if (current(token)) { actionWorking.current = false; setBusy(''); } }
  }
  async function saveAutoAnalysis(enabled: boolean) {
    if (!api || settingWorking.current || frozen || strict) return;
    const token = scope.current; settingWorking.current = true; setAutoSaving(true); setPendingAutoValue(enabled); setSettingError('');
    try { const state = await api.saveAiAutoAnalysis(enabled); if (current(token)) setProvider(state); }
    catch (error) { if (current(token)) { setSettingError(errorText(error)); onError(errorText(error)); } }
    finally { if (current(token)) { settingWorking.current = false; setAutoSaving(false); setPendingAutoValue(null); } }
  }

  if (!active) return null;
  return <section className="ai-panel ai-chat-panel" aria-label="AI 教练">
    <header className="ai-panel-intro"><h3>{reviewMode ? 'AI 复盘' : 'AI 教练'}</h3></header>
    <div className="ai-conversation" ref={conversation} onScroll={change => {
      const element = change.currentTarget, nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      pinnedToLatest.current = nearBottom; setAwayFromLatest(!nearBottom);
    }}>
      {loadError ? <div className="ai-chat-notice" role="alert"><p className="error-text">{loadError}</p><button className="text-button" onClick={() => { void reload(); }}>重新加载对话</button></div> : !provider ? <p className="ai-status" role="status">正在加载 AI 设置与对话…</p> : !configured && <div className="ai-chat-notice"><p>先配置你自己的模型接口与 Key。</p><button className="button" onClick={onSettings}>配置 AI</button></div>}
      {strict ? <p className="ai-chat-notice">严格面试进行中，AI 教练暂不可用。</p> : !hasContext && <p className="ai-chat-notice">开始一次练习后，可以向 AI 教练提问。</p>}
      {message && <p role="status" className="success-text ai-chat-notice">{message}</p>}
      {provider && configured && hasContext && !strict && turns.length === 0 && <div className="ai-chat-empty"><p>输入问题，或选择下方操作。</p></div>}
      <div className="ai-request-list" role="log" aria-label="AI 对话记录" aria-live="polite" aria-relevant="additions">
        {turns.map(({ id, record, local }) => {
          const kind = record?.snapshot.kind ?? local!.kind, text = record?.snapshot.question ?? local!.question;
          const status = record?.status ?? local!.status;
          const progress = event?.requestId === id && !terminalPhases.has(event.phase) ? phaseLabels[event.phase] : statusLabels[status];
          const failure = record?.error?.message ?? local?.error;
          const response = record?.response;
          return <article className="ai-request ai-chat-turn" key={id} data-request-id={id} data-status={status}>
            <div className="ai-chat-message ai-chat-user"><span className="ai-chat-speaker">你</span><p className="ai-question">{questionLabel(kind, text)}</p></div>
            <div className="ai-chat-message ai-chat-assistant"><span className="ai-chat-speaker">AI 教练</span>
              {response && record ? <>
                <h4>{response.title}</h4>
                <Markdown text={response.explanation} onOpenLink={url => { void api?.openWebLink(url).catch(error => onError(errorText(error))); }} />
                {response.nextSteps.length > 0 && <ol>{response.nextSteps.map((step, index) => <li key={index}><Markdown text={step} /></li>)}</ol>}
                {record.snapshot.code !== code && <p className="ai-status warning-text">针对先前代码版本</p>}
                <div className="ai-message-secondary">
                  {!reviewMode && (response.patch || response.completeSolution) && <button className="button" disabled={Boolean(busy) || frozen || strict} onClick={() => { void preview(record); }}>预览修改建议</button>}
                  {response.noteDraft && <details><summary>笔记草稿</summary><h4>{response.noteDraft.title}</h4><Markdown text={response.noteDraft.markdown} /><button className="button" disabled={Boolean(busy) || frozen || strict} onClick={() => { void saveNote(record); }}>保存为笔记草稿</button></details>}
                  {response.completeSolution && <details><summary>查看完整解法</summary><Markdown text={response.completeSolution.explanation} /><pre className="archive-code">{response.completeSolution.code}</pre></details>}
                  <details><summary>回答详情</summary>
                    <p className="ai-status"><time dateTime={record.createdAt}>{dateTime(record.createdAt)}</time> · {statusLabels[record.status]}</p>
                    {record.snapshot.previousRun && <p className="ai-status">包含旧代码的运行记录，仅作对照</p>}
                    {record.snapshot.conversationMemory?.status === 'degraded' && <p className="ai-status">部分历史对话未发送</p>}
                    {response.evidence.length > 0 && <details><summary>使用的运行证据</summary>{response.evidence.map((evidence, index) => <pre className="diagnostic" key={index}>{evidence.quote}</pre>)}</details>}
                    {response.inferences.length > 0 && <details><summary>需要验证的判断</summary>{response.inferences.map((inference, index) => <div key={index}><Markdown text={inference.text} /><p className="field-help">依据：{inference.reason}</p></div>)}</details>}
                    {record.cachedFromRequestId && <p className="ai-status">已复用相同请求的回答</p>}
                    <p className="ai-status">{record.usage?.totalTokens === null || !record.usage ? '用量未知' : `供应商报告 ${record.usage.totalTokens} Token`} · {record.snapshot.provider.model}</p>
                  </details>
                </div>
                {patch?.requestId === record.id && !reviewMode && <div className="ai-patch-preview">
                  <p className="field-help">应用后请运行用例验证。</p>
                  <CodeComparison before={record.snapshot.code} after={patch.code} language={patch.language} label="AI 修改差异" />
                  <div className="compact-actions"><button className="button primary" disabled={Boolean(busy) || frozen || strict} onClick={() => { void apply(); }}>应用到当前草稿</button><button className="text-button" disabled={Boolean(busy)} onClick={() => setPatch(null)}>收起差异</button></div>
                </div>}
              </> : failure ? <div className="ai-chat-failure"><p role="alert" className="error-text">{failure}</p><button className="text-button" disabled={!canAsk} onClick={() => { void ask(kind, text, record?.snapshot.officialSubmissionId); }}>重试这次提问</button></div> : <p className="ai-status" role={pendingStatuses.has(status) ? 'status' : undefined}>{progress}{event?.requestId === id && event.receivedBytes !== undefined && pendingStatuses.has(status) ? ` · 已接收 ${Math.ceil(event.receivedBytes / 1024)} KiB` : ''}</p>}
            </div>
          </article>;
        })}
      </div>
    </div>
    {awayFromLatest && <button className="ai-jump-latest text-button" onClick={() => { pinnedToLatest.current = true; setAwayFromLatest(false); const element = conversation.current; if (element) element.scrollTop = element.scrollHeight; }}>查看最新消息</button>}
    <form className="ai-composer" onSubmit={submit => { submit.preventDefault(); void ask('chat', question); }}>
      <div className="ai-quick-actions"><button type="button" className="button" disabled={!canAsk} onClick={() => { void ask('hint'); }}>给点提示</button><button type="button" className="button" disabled={!canAsk} onClick={() => { void ask('diagnosis'); }}>检查代码</button></div>
      <label className="p3-field ai-chat-input"><span>向 AI 教练提问</span><textarea aria-label="AI 提问" aria-describedby="ai-chat-keyboard-help" value={question} maxLength={4000} disabled={composerDisabled} placeholder="聊聊你的思路，或问一个具体问题…" onChange={change => { setQuestion(change.target.value); rememberInput(attempt?.id, change.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={key => {
        if (key.key !== 'Enter' || key.shiftKey || key.altKey || key.ctrlKey || key.metaKey || key.nativeEvent.isComposing || composing.current || key.keyCode === 229) return;
        key.preventDefault(); void ask('chat', question);
      }} /></label>
      <div className="ai-composer-actions"><span className="field-help" id="ai-chat-keyboard-help">Enter 发送 · Shift + Enter 换行</span>{activeId ? <button type="button" className="button" onClick={() => { void stop(); }}>停止 AI 请求</button> : <button type="submit" className="button primary" disabled={!canAsk || !question.trim()}>发送</button>}</div>
      <div className="ai-composer-secondary"><button type="button" className="text-button" disabled={!canAsk} onClick={() => { void ask('note-draft'); }}>总结为笔记草稿</button></div>
      <div className="control-with-help ai-auto-analysis"><label className="checkbox-field"><input type="checkbox" aria-label="提交后自动分析" aria-describedby="ai-auto-help" checked={pendingAutoValue ?? provider?.autoAnalyzeOfficial ?? false} disabled={!api || !configured || autoSaving || frozen || strict} onChange={change => { void saveAutoAnalysis(change.target.checked); }} />提交后自动分析{autoSaving && <span className="field-help" role="status">保存中…</span>}</label><HelpHint id="ai-auto-help" label="提交后自动分析说明">仅力扣官方提交完成后分析；本地运行不会自动触发。</HelpHint></div>
      {settingError && <p role="alert" className="error-text">{settingError} 请重试开关。</p>}
    </form>
  </section>;
}
