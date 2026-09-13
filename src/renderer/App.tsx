import { setPerformancePage } from './performance-monitor';
import { InterviewPage } from './InterviewPage';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DesktopBridge, EnvironmentInfo, LibraryIndex, Page, RunArchive } from '../shared/bridge';
import type { Language, RunEvent } from '../runner/types';
import { capability, difficultyLabel, previewProblems, sourceLabel } from '../shared/presentation';
import type { Attempt } from '../storage/practice-store';
import type { ProblemListItem, ReviewItem } from '../shared/learning';
import type { AiHelpDecision } from '../shared/ai';
import { TodayPage } from './TodayPage';
import { NotesPage } from './NotesPage';
import { LearningSettingsPage } from './LearningSettingsPage';
import { AiPanel } from './AiPanel';
import { OfficialJudgePanel } from './OfficialJudgePanel';
import type { OfficialSubmission } from '../shared/official';
import { ReviewRating } from './ReviewRating';
import { editsFrozen, flushPendingSaves, setEditsFrozen, useEditsFrozen } from './pending-saves';
import { Editor } from './Editor';
import { LibraryPage } from './LibraryPage';
import { ImportPage } from './ImportPage';
import { ArchivePage } from './ArchivePage';
import { EnvironmentPage } from './EnvironmentPage';
import { usePractice } from './usePractice';
import { dateTime, errorText, formatValue, Icon, type IconName, Statement, statusClass, statusText } from './ui';

const pages: { id: Page; label: string; icon: IconName }[] = [
  { id: 'today', label: '学习中心', icon: 'home' },
  { id: 'library', label: '题库', icon: 'library' }, { id: 'workbench', label: '练习工作台', icon: 'code' }, { id: 'interview', label: '模拟面试', icon: 'code' },
  { id: 'sources', label: '导入题单', icon: 'source' }, { id: 'notes', label: '学习笔记', icon: 'library' }, { id: 'archives', label: '练习档案', icon: 'archive' }, { id: 'learning-settings', label: '学习设置', icon: 'settings' }, { id: 'environment', label: '运行环境', icon: 'settings' },
];
function Splitter({ side, value, onChange }: { side: 'statement' | 'history'; value: number; onChange: (value: number) => void }) {
  const move = (element: HTMLElement, x: number) => { const bounds = element.parentElement!.getBoundingClientRect(); onChange(side === 'statement' ? Math.max(22, Math.min(48, (x - bounds.left) / bounds.width * 100)) : Math.max(180, Math.min(320, bounds.right - x))); };
  return <div role="separator" tabIndex={0} aria-label={side === 'statement' ? '调整题面宽度' : '调整记录宽度'} aria-orientation="vertical" aria-valuemin={side === 'statement' ? 22 : 180} aria-valuemax={side === 'statement' ? 48 : 320} aria-valuenow={Math.round(value)}
    className={`pane-splitter ${side}-splitter`} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); move(event.currentTarget, event.clientX); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event.currentTarget, event.clientX); }} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const direction = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'history' ? -1 : 1); const step = side === 'statement' ? 2 : 12; onChange(Math.max(side === 'statement' ? 22 : 180, Math.min(side === 'statement' ? 48 : 320, value + direction * step))); } }} />;
}
export function App() {
  const api: DesktopBridge | undefined = window.algo;
  const [page, setPageRaw] = useState<Page>(() => { const desired = sessionStorage.getItem('algo-page'); sessionStorage.removeItem('algo-page'); return desired === 'interview' ? 'interview' : 'today'; }); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [library, setLibrary] = useState<LibraryIndex>({ problems: api ? [] : previewProblems.map(problem => ({ ...problem, capability: capability(problem.content), capabilities: { statement: true, adapter: true, python: true, java: true, cases: problem.content.cases.length, expected: true } })), totalProblems: api ? 0 : previewProblems.length, lists: [], jobs: [] });
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const [workbenchMounted, setWorkbenchMounted] = useState(false);
  useEffect(() => setPerformancePage(page), [page]);
  const [archiveDate, setArchiveDate] = useState<string | undefined>();
  const [initialImport, setInitialImport] = useState<string | undefined>(); const [importPageKey, setImportPageKey] = useState(0);
  const practice = usePractice(api, setError);
  const [running, setRunning] = useState(false); const [runEvent, setRunEvent] = useState<RunEvent | null>(null); const runId = useRef<string | null>(null);
  const runCancelled = useRef(false);
  const [selectedRun, setSelectedRun] = useState<RunArchive | null>(null);
  const [resultTab, setResultTab] = useState<'local' | 'official'>('local');
  const [officialRecords, setOfficialRecords] = useState<OfficialSubmission[]>([]);
  const [officialFocus, setOfficialFocus] = useState('');
  const [submitting, setSubmitting] = useState(false); const officialAction = useRef(false);
  const attemptId = practice.workspace?.attempt?.id;
  const activeOfficialRecords = officialRecords.filter(record => record.attemptId === attemptId);
  const officialBusy = submitting || activeOfficialRecords.some(record => ['submitting', 'judging'].includes(record.status));
  useEffect(() => {
    let alive = true; setOfficialRecords([]); setOfficialFocus(''); setResultTab('local');
    const refresh = () => { if (api && attemptId) void api.officialSubmissions(attemptId).then(records => { if (alive) setOfficialRecords(current => {
      const newer = new Map(current.map(record => [record.id, record]));
      for (const record of records) if (!newer.has(record.id) || newer.get(record.id)!.updatedAt < record.updatedAt) newer.set(record.id, record);
      return [...newer.values()];
    }); }).catch(error => { if (alive) setError(errorText(error)); }); };
    refresh();
    const removeMaintenance = api?.onMaintenanceEnd(refresh);
    const remove = api?.onOfficialEvent(record => {
      if (alive && record.attemptId === attemptId) setOfficialRecords(current => [record, ...current.filter(item => item.id !== record.id)]);
    });
    return () => { alive = false; remove?.(); removeMaintenance?.(); };
  }, [api, attemptId]);
  const [showHistory, setShowHistory] = useState(true); const [showStatement, setShowStatement] = useState(true);
  const [statementWidth, setStatementWidth] = useState(32); const [historyWidth, setHistoryWidth] = useState(216);
  const [reveal, setReveal] = useState<{ line: number; column: number; serial: number } | null>(null);
  const [command, setCommand] = useState(''); const [commandIndex, setCommandIndex] = useState(0); const commandDialog = useRef<HTMLDialogElement>(null);
  const [commandProblems, setCommandProblems] = useState<ProblemListItem[]>([]);
  useEffect(() => { let alive = true; const timer = setTimeout(() => { if (api) void api.problemPage({ search: command, limit: 20 }).then(value => { if (alive) setCommandProblems(value.items); }).catch(error => { if (alive) setError(errorText(error)); }); else setCommandProblems(library.problems); }, 150); return () => { alive = false; clearTimeout(timer); }; }, [api, command, library]);
  const frozen = useEditsFrozen(); const navigationBusy = useRef(false);
  const [maintenance, setMaintenance] = useState(false); const [panel, setPanel] = useState<'history' | 'ai'>('history');
  const [endedAttempt, setEndedAttempt] = useState<Attempt | null>(null); const [reviewItem, setReviewItem] = useState<ReviewItem | null>(null);
  const [help, setHelp] = useState<AiHelpDecision | null>(null);
  async function setPage(next: Page) {
    if (navigationBusy.current || editsFrozen()) return false; navigationBusy.current = true; setEditsFrozen(true, 'navigation');
    try { await flushPendingSaves(); if (next === 'archives') setArchiveDate(undefined); if (next === 'workbench') setWorkbenchMounted(true); setPageRaw(next); return true; } catch (error) { setError(errorText(error)); return false; }
    finally { navigationBusy.current = false; setEditsFrozen(false, 'navigation'); }
  }
  const refreshLibrary = useCallback(async () => { if (api) setLibrary(await api.libraryIndex()); }, [api]);
  const refreshEnvironment = useCallback(async () => { if (api) setEnvironment(await api.environment()); }, [api]);
  useEffect(() => { void refreshLibrary().catch(error => setError(errorText(error))); void refreshEnvironment().catch(error => setError(errorText(error))); }, [refreshLibrary, refreshEnvironment]);
  useEffect(() => { let timer: ReturnType<typeof setTimeout> | null = null; const remove = api?.onLibraryChanged(() => { if (timer) return; timer = setTimeout(() => { timer = null; void refreshLibrary().catch(error => setError(errorText(error))); }, 250); }); return () => { remove?.(); if (timer) clearTimeout(timer); }; }, [api, refreshLibrary]);
  useEffect(() => api?.onNavigate(next => { setPage(next); void refreshEnvironment().catch(error => setError(errorText(error))); }), [api, refreshEnvironment]);
  useEffect(() => { const remove = api?.onMaintenance(id => { setMaintenance(true); setEditsFrozen(true, 'maintenance'); void flushPendingSaves().then(() => api.maintenanceReady(id)).catch(error => api.maintenanceReady(id, errorText(error))); }); const end = api?.onMaintenanceEnd(() => { setMaintenance(false); setEditsFrozen(false, 'maintenance'); }); return () => { remove?.(); end?.(); }; }, [api]);
  useEffect(() => {
    if (!api || page !== 'workbench' || !practice.workspace?.attempt?.isActive) return;
    let lastInput = performance.now(); const input = () => { lastInput = performance.now(); };
    const pause = () => { void api.pauseActivity().catch(() => {}); };
    const pulse = () => {
      if (!editsFrozen() && document.visibilityState === 'visible' && document.hasFocus() && performance.now() - lastInput < 300000) void api.activityPulse(practice.workspace!.attempt!.id).catch(() => {});
      else pause();
    };
    const visibility = () => { if (document.visibilityState === 'visible') pulse(); else pause(); };
    for (const name of ['keydown', 'pointerdown', 'wheel']) window.addEventListener(name, input, { passive: true });
    window.addEventListener('blur', pause); window.addEventListener('focus', pulse); document.addEventListener('visibilitychange', visibility);
    pulse(); const timer = setInterval(pulse, 10000);
    return () => {
      clearInterval(timer); pause();
      for (const name of ['keydown', 'pointerdown', 'wheel']) window.removeEventListener(name, input);
      window.removeEventListener('blur', pause); window.removeEventListener('focus', pulse); document.removeEventListener('visibilitychange', visibility);
    };
  }, [api, page, practice.workspace?.attempt?.id, practice.workspace?.attempt?.isActive]);
  useEffect(() => { let alive = true; setHelp(null); if (api && practice.workspace?.attempt) void api.takeAiHelp(practice.workspace.attempt.id).then(value => { if (alive && value.show) setHelp(value); }).catch(error => { if (alive) setError(errorText(error)); }); return () => { alive = false; }; }, [api, practice.workspace?.attempt?.id, practice.workspace?.history.length]);
  useEffect(() => api?.onRunEvent(event => { if (event.runId === runId.current) setRunEvent(event); }), [api]);
  useEffect(() => { setSelectedRun(null); setReveal(null); setNotice(''); setEndedAttempt(null); }, [practice.key]);
  useEffect(() => { if (selectedRun && practice.workspace && !practice.workspace.history.some(run => run.id === selectedRun.id)) { setSelectedRun(null); setReveal(null); } }, [practice.workspace, selectedRun]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommand(''); setCommandIndex(0); commandDialog.current?.showModal(); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, []);

  async function openProblem(id: string, language = practice.target.language, scope = 'practice') { if (!await setPage('workbench')) return; setReviewItem(null); setEndedAttempt(null); const opened = await practice.open({ id, language, scope }); if (opened) { setNotice(''); } }
  async function openArchives(date?: string) { if (await setPage('archives')) setArchiveDate(date); }
  async function submitOfficial() {
    const attempt = practice.workspace?.attempt;
    if (!api || !attempt?.isActive || !practice.ready || practice.switching || editsFrozen() || officialAction.current || officialBusy) return;
    officialAction.current = true; setSubmitting(true); setError(''); setResultTab('official');
    const snapshot = practice.snapshot(); const expectedKey = practice.currentKey.current;
    try {
      await practice.flush();
      // Read the saved revision after flushing, then let main validate both code and revision.
      let saved = await api.workspace(snapshot.target.id, snapshot.target.language, snapshot.target.scope);
      if (!saved.draft && practice.currentKey.current === expectedKey && practice.snapshot().code === snapshot.code) {
        await api.saveDraft(snapshot.target.id, snapshot.target.language, snapshot.code, snapshot.target.scope);
        saved = await api.workspace(snapshot.target.id, snapshot.target.language, snapshot.target.scope);
      }
      if (practice.currentKey.current !== expectedKey || saved.attempt?.id !== attempt.id || saved.draft?.code !== snapshot.code) throw new Error('代码或练习已切换，请重新点击提交。');
      const record = await api.officialSubmit({ requestId: crypto.randomUUID(), attemptId: attempt.id, code: snapshot.code, expectedDraftRevision: saved.draft.revision });
      if (practice.currentKey.current === expectedKey) {
        setOfficialFocus(record.id);
        setOfficialRecords(current => current.some(item => item.id === record.id && item.updatedAt >= record.updatedAt) ? current : [record, ...current.filter(item => item.id !== record.id)]);
      }
    } catch (error) { setError(errorText(error)); }
    finally { officialAction.current = false; setSubmitting(false); }
  }
  async function resumeOfficial(id: string) {
    if (!api || officialAction.current || editsFrozen()) return;
    officialAction.current = true; setSubmitting(true);
    try { await api.officialResume(id); } catch (error) { setError(errorText(error)); }
    finally { officialAction.current = false; setSubmitting(false); }
  }
  function openImport(url?: string) { setInitialImport(url); setImportPageKey(value => value + 1); setPage('sources'); }
  async function run() {
    if (editsFrozen() || !api || running || runId.current || !practice.ready || practice.switching || !practice.workspace) return;
    const snapshot = practice.snapshot(); const expectedKey = practice.key; const version = practice.workspace.problem.version;
    const request = crypto.randomUUID(); runId.current = request; runCancelled.current = false; setRunning(true); setResultTab('local'); setRunEvent(null); setError(''); setNotice('');
    try {
      await practice.flush();
      if (runCancelled.current) return;
      const archive = await api.run(snapshot.target.id, snapshot.target.language, snapshot.code, snapshot.target.scope, request, version);
      if (practice.currentKey.current === expectedKey) { practice.acceptRun(archive, expectedKey); setSelectedRun(archive); await practice.refresh(expectedKey); }
      await refreshLibrary();
    } catch (error) { setError(errorText(error)); } finally { setRunning(false); runId.current = null; }
  }
  async function finish() {
    if (running || officialBusy || editsFrozen()) return; await flushPendingSaves(); const ended = await practice.finish(); if (ended) { setEndedAttempt(ended); setNotice('本次练习已归档。'); await refreshLibrary(); }
  }
  const commands = [
    ...pages.map(item => ({ label: item.label, action: () => setPage(item.id) })),
    ...commandProblems.map(problem => ({ label: `练习 · ${problem.content.title}`, action: () => openProblem(problem.id) })),
  ].filter(item => item.label.toLowerCase().includes(command.toLowerCase())).slice(0, 20);
  const workspace = practice.workspace; const problem = workspace?.problem.content; const available = problem ? capability(problem, practice.target.language) : null;
  const canSubmitOfficial = problem?.source === 'leetcode-cn' && Boolean(problem.sourceId && problem.starter[practice.target.language]) && problem.mode === 'function' && /^https:\/\/leetcode\.cn\/problems\/[a-z0-9][a-z0-9-]*(?:\/description)?\/?$/.test(problem.sourceUrl ?? '');
  const result = selectedRun?.result; const sameVersion = Boolean(selectedRun && selectedRun.code === practice.code && selectedRun.problemVersion === workspace?.problem.version);
  const phase = runEvent ? ({ queued: '正在排队', compile: '正在编译', run: '正在执行', finished: '正在保存结果' }[runEvent.phase]) : '正在准备运行';
  return <div className="app-shell app-shell-p2">
    <aside className="sidebar"><a className="wordmark" href="#today" onClick={event => { event.preventDefault(); setPage('today'); }}><span className="brand-symbol">t.</span><span>题炼</span></a>
      <button className="search-launch" onClick={() => { setCommand(''); setCommandIndex(0); commandDialog.current?.showModal(); }}><Icon name="search" /><span>快速切换</span><kbd>⌘ / Ctrl K</kbd></button>
      <nav aria-label="主导航">{pages.map(item => <button key={item.id} aria-current={page === item.id ? 'page' : undefined} onClick={() => setPage(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-footer"><span className="local-indicator" />本地练习 · 随时继续</div>
    </aside>
    <main className="main-shell"><header className="app-header"><div><span className="breadcrumb">{page === 'workbench' && problem ? `${sourceLabel(problem.source)} / ${problem.tags[0] || '算法练习'}` : '题炼 / 我的学习'}</span><h1>{pages.find(item => item.id === page)?.label}</h1></div><span className="local-label"><span className="local-indicator" /> 本地空间</span></header>
      {maintenance && <div className="maintenance-banner" role="status">正在保存编辑并恢复备份，请等待应用重新打开。</div>}
      {error && <div role="alert" className="error-banner"><span>{error}</span><button onClick={() => setError('')}>收起</button></div>}
      {notice && <div role="status" className="preview-banner"><span>{notice}</span><button className="text-button" onClick={() => setPage('archives')}>查看档案</button><button onClick={() => setNotice('')}>收起</button></div>}
      {environment?.reminder && !environment.reminder.deliveredAt && Date.parse(environment.reminder.dueAt) <= Date.now() && <div className="preview-banner overdue-banner" role="status">有一条测试提醒已逾期。<button className="text-button" onClick={() => setPage('environment')}>查看提醒</button></div>}
      {!api && <p className="preview-banner">当前为浏览器设计预览。运行、导入和保存需要打开桌面应用。</p>}
      {page === 'interview' && <InterviewPage api={api} onError={setError} onNavigate={next => { void setPage(next); }} />}
      {page === 'today' && <TodayPage api={api} library={library} onReview={item => { void openProblem(item.problemId, item.language === 'none' ? practice.target.language : item.language).then(() => setReviewItem(item)); }} onSettings={() => { void setPage('learning-settings'); }} onArchives={date => { void openArchives(date); }} onBrowse={() => { void setPage('library'); }} onError={setError} />}
      {page === 'notes' && <NotesPage api={api} library={library} initialSubject={practice.target.id} onError={setError} />}
      {page === 'learning-settings' && <LearningSettingsPage api={api} onError={setError} />}
      {page === 'library' && <LibraryPage api={api} data={library} onOpen={id => { void openProblem(id); }} onImport={openImport} onChanged={refreshLibrary} onError={setError} />}
      {page === 'sources' && <ImportPage key={importPageKey} api={api} jobs={library.jobs} initialUrl={initialImport} onChanged={refreshLibrary} onOpenLibrary={() => setPage('library')} onError={setError} />}
      {page === 'archives' && <ArchivePage key={archiveDate ?? 'all'} initialLearningDate={archiveDate} api={api} onError={setError} onRestore={async archive => { if (!api) return; await practice.flush(); const restored = await api.restoreRun(archive.id, crypto.randomUUID()); await openProblem(restored.draft.problemId, restored.draft.language, restored.draft.scopeId); setNotice('已恢复为新草稿。'); }} />}
      {page === 'environment' && <EnvironmentPage api={api} onError={setError} onChanged={() => { void refreshEnvironment().catch(error => setError(errorText(error))); }} />}
      {workbenchMounted && <div className="workbench-screen" hidden={page !== 'workbench'}>{problem ? <>
        {endedAttempt && <ReviewRating key={endedAttempt.id} api={api} problemId={endedAttempt.problemId} language={endedAttempt.language} attemptId={endedAttempt.id} existingItem={reviewItem} onSaved={() => { void refreshLibrary(); }} onDismiss={() => setEndedAttempt(null)} onError={setError} />}
        {help?.show && <div className="help-prompt"><span>{help.reason === 'compile-error' ? '遇到了编译错误。' : '连续三次运行没有通过。'}需要一起梳理吗？</span><button className="button" onClick={() => { setPanel('ai'); setShowHistory(true); setHelp(null); }}>打开 AI 帮助</button><button className="text-button" onClick={() => { if (workspace?.attempt) void api?.dismissAiHelp(workspace.attempt.id); setHelp(null); }}>先自己想想</button></div>}
        <div className="workbench-toolbar"><div className="topic-line"><span>{difficultyLabel(problem.difficulty)}</span><span>{problem.mode === 'function' ? '函数题' : 'ACM'}</span><span>{available?.label}</span></div><div className="view-controls"><button aria-pressed={showStatement} onClick={() => setShowStatement(!showStatement)}>{showStatement ? '收起题面' : '展开题面'}</button><button aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>{showHistory ? '收起记录' : '展开记录'}</button>{workspace?.attempt ? <button disabled={frozen || running || officialBusy || practice.switching || !practice.ready} onClick={() => { void finish().catch(error => setError(errorText(error))); }}>结束练习</button> : <button disabled={!api || practice.switching || !practice.ready} onClick={() => { void openProblem(practice.target.id, practice.target.language, practice.target.scope); }}>开始新练习</button>}</div></div>
        {workspace?.latestVersion !== workspace?.problem.version && <div className="version-notice">此练习使用开始时的题面；结束后，新练习将使用已缓存的新版。</div>}
        {practice.target.scope !== 'practice' && <div className="version-notice">当前是从档案恢复的独立草稿。<button className="text-button" onClick={() => { void openProblem(practice.target.id, practice.target.language); }}>回到普通草稿</button></div>}
        <div className="workbench workbench-p2" data-statement={showStatement} data-history={showHistory} style={{ '--statement-size': `${statementWidth}%`, '--history-size': `${panel === 'ai' ? Math.max(300, historyWidth) : historyWidth}px` } as CSSProperties}>
          {showStatement && <><section className="statement" aria-label="题目描述"><h2>{problem.title}</h2><Statement content={problem} /><div className="statement-footnote">{available?.reason}{problem.sourceUrl && <button className="text-button" onClick={() => api?.openSource(problem.sourceUrl!).catch(error => setError(errorText(error)))}>打开原站</button>}</div></section><Splitter side="statement" value={statementWidth} onChange={setStatementWidth} /></>}
          <section className="coding-pane" aria-label="代码与测试"><div className="editor-toolbar"><label className="language-label"><span className="sr-only">编程语言</span><select aria-label="编程语言" value={practice.target.language} disabled={!practice.ready || practice.switching || running} onChange={event => { void openProblem(practice.target.id, event.target.value as Language, practice.target.scope); }}><option value="python">Python</option><option value="java">Java</option></select></label><span className={practice.saving === '保存失败' ? 'save-state error-text' : 'save-state'} role="status">{practice.saving}</span>{practice.saving === '保存失败' && <button className="text-button" onClick={() => { void practice.flush().catch(() => {}); }}>重试保存</button>}<div className="run-actions">{canSubmitOfficial && <button className="button official-judge" disabled={!api || !practice.ready || practice.switching || frozen || officialBusy || !workspace?.attempt?.isActive} title="以当前力扣账号提交代码，结果将保存在练习档案" onClick={() => { void submitOfficial(); }}>{officialBusy ? '正在判题…' : '提交到力扣'}</button>}{running ? <button className="button primary" onClick={() => { runCancelled.current = true; void api?.cancel().catch(error => setError(errorText(error))); }}><Icon name="stop" />停止</button> : <button className="button primary" disabled={!api || !practice.ready || practice.switching || !available?.canRun} onClick={() => { void run(); }}><Icon name="play" />运行</button>}</div></div>
            {practice.ready ? <Editor key={practice.key} code={practice.code} language={practice.target.language} readOnly={practice.switching || frozen} onChange={practice.edit} onRun={run} diagnostics={sameVersion ? result?.diagnostics : []} reveal={reveal} /> : <div className="editor-loading">正在读取草稿…</div>}
            <section className="results-pane" aria-label="测试结果"><div className="results-heading"><div className="panel-tabs" role="group" aria-label="判题来源"><button aria-pressed={resultTab === 'local'} onClick={() => setResultTab('local')}>本地运行</button>{(canSubmitOfficial || activeOfficialRecords.length > 0) && <button aria-pressed={resultTab === 'official'} onClick={() => setResultTab('official')}>力扣官方{officialBusy ? ' · 判题中' : ''}</button>}</div>{resultTab === 'local' && <span>{running ? `${phase}${runEvent?.caseIndex === undefined ? '' : ` · 用例 ${runEvent.caseIndex + 1}`}` : `${problem.cases.length} 个本地用例`}</span>}</div>
              {resultTab === 'official' ? <OfficialJudgePanel key={attemptId} records={activeOfficialRecords} currentCode={practice.code} problemVersion={workspace?.problem.version} focusId={officialFocus} busy={officialBusy || frozen} onResume={id => { void resumeOfficial(id); }} onLogin={() => { void api?.loginSource().catch(error => setError(errorText(error))); }} onOpen={url => { void api?.openWebLink(url).catch(error => setError(errorText(error))); }} onCoach={() => { setPanel('ai'); setShowHistory(true); }} /> : <>
              {result ? <><div className="result-summary"><strong className={statusClass(result.status)}>{result.status === 'passed' ? '✓ ' : '· '}{statusText[result.status]}</strong><span>{Math.round(result.durationMs)} ms</span>{!sameVersion && <span className="old-version">针对先前代码或题面版本</span>}</div><div className="case-list">{result.caseResults.map(test => <details className="case-detail" key={test.index}><summary><span>用例 {test.index + 1}</span><span className={statusClass(test.status)}>{statusText[test.status]}</span><code>{formatValue(test.actual).slice(0, 120)}</code></summary><dl><dt>实际输出</dt><dd><pre>{formatValue(test.actual)}</pre></dd><dt>期望输出</dt><dd><pre>{formatValue(test.expected)}</pre></dd>{test.stdout && <><dt>标准输出</dt><dd><pre>{test.stdout}</pre></dd></>}{test.stderr && <><dt>标准错误</dt><dd><pre>{test.stderr}</pre></dd></>}</dl></details>)}</div>{result.diagnostics.map((diagnostic, index) => <div key={index} className="diagnostic-item">{diagnostic.line && diagnostic.source === 'user' && <button className="text-button" disabled={!sameVersion} onClick={() => setReveal({ line: diagnostic.line!, column: diagnostic.column ?? 1, serial: Date.now() })}>定位第 {diagnostic.line} 行{diagnostic.column ? `，第 ${diagnostic.column} 列` : ''}</button>}<pre className="diagnostic">{diagnostic.message}</pre></div>)}{result.stdout && <details><summary>标准输出</summary><pre className="diagnostic">{result.stdout}</pre></details>}</> : <div className="results-empty"><span className="empty-mark">›_</span><p>{available?.canRun ? '写下解法，运行一次看看。' : '此题尚未准备好本地运行。'}<br /><span>{available?.canRun ? '⌘ / Ctrl + Enter 运行，每次执行保存独立快照。' : available?.reason}</span></p></div>}
              </>}
            </section>
          </section>
          {showHistory && <><Splitter side="history" value={historyWidth} onChange={setHistoryWidth} /><aside className="history-pane" aria-label="练习记录与 AI"><div className="panel-tabs"><button aria-pressed={panel === 'history'} onClick={() => setPanel('history')}>运行记录</button><button aria-pressed={panel === 'ai'} onClick={() => setPanel('ai')}>AI 教练</button><button onClick={() => { void setPage('notes'); }}>记笔记</button></div>{panel === 'ai' ? <AiPanel key={workspace?.attempt?.id ?? 'none'} active={page === 'workbench'} api={api} attempt={workspace?.attempt ?? null} code={practice.code} selectedRun={selectedRun} flush={flushPendingSaves} onApply={async requestId => { if (!api || editsFrozen()) return; const key = practice.currentKey.current; setEditsFrozen(true, 'patch'); try { await flushPendingSaves(); const draft = await api.applyAiPatch(requestId); practice.acceptDraft(draft.code, key); await practice.refresh(key); } finally { setEditsFrozen(false, 'patch'); } }} onNoteSaved={() => { void setPage('notes'); }} onSettings={() => { void setPage('learning-settings'); }} onError={setError} /> : <><h2>本次练习 <span>{workspace?.historyTotal ?? workspace?.history.length ?? 0} 次运行</span></h2><p className="muted">{workspace?.attempt ? `开始于 ${dateTime(workspace.attempt.startedAt)}` : '下一次运行会开始新的练习'}</p>{workspace?.history.length ? <ol>{workspace.history.map((row, index) => <li key={row.id}><button className={selectedRun?.id === row.id ? 'active' : ''} onClick={() => { setSelectedRun(row); setResultTab('local'); setReveal(null); }}><span className="history-row"><strong>第 {(workspace.historyTotal ?? workspace.history.length) - index} 次运行</strong><time>{new Date(row.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></span><span className={statusClass(row.result.status)}>{statusText[row.result.status]}</span></button></li>)}</ol> : <div className="history-empty"><span className="history-line" /><p>还没有运行记录</p></div>}<button className="text-button" onClick={() => setPage('archives')}>查看所有练习档案</button></>}</aside></>}
        </div>
      </> : <div className="empty-state"><h2>正在读取工作台</h2><p>可先从题库中选择需要练习的题目。</p><button className="text-button" onClick={() => setPage('library')}>打开题库</button></div>}</div>}
      <footer className="status-bar"><span>{running ? `${phase} · 本地执行` : '题炼 / 先理解，再熟练。'}</span><span>{library.jobs.some(job => job.status === 'running') ? '题单正在后台准备' : `${library.totalProblems} 道题目保存在本机`}</span></footer>
    </main>
    <dialog ref={commandDialog} className="command-dialog" aria-labelledby="command-title" onClick={event => { if (event.target === commandDialog.current) commandDialog.current.close(); }}><h2 id="command-title">快速切换</h2><label htmlFor="command-search" className="sr-only">搜索页面或题目</label><input id="command-search" autoFocus placeholder="搜索页面或题目" value={command} onChange={event => { setCommand(event.target.value); setCommandIndex(0); }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setCommandIndex(index => Math.max(0, Math.min(index + 1, commands.length - 1))); } if (event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex(index => Math.max(0, index - 1)); } if (event.key === 'Enter' && commands[commandIndex]) { event.preventDefault(); void commands[commandIndex].action(); commandDialog.current?.close(); } }} /><div className="command-list">{commands.map((item, index) => <button key={item.label} className={index === commandIndex ? 'selected' : ''} onClick={() => { void item.action(); commandDialog.current?.close(); }}>{item.label}<span>↵</span></button>)}{!commands.length && <p>没有匹配的页面或题目。</p>}</div><button className="text-button" onClick={() => commandDialog.current?.close()}>关闭 <kbd>Esc</kbd></button></dialog>
  </div>;
}
