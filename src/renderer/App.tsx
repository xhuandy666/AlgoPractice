import { setPerformancePage } from './performance-monitor';
import { version as appVersion } from '../../package.json';
import { InterviewPage } from './InterviewPage';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge, EnvironmentInfo, LibraryIndex, Page, RunArchive } from '../shared/bridge';
import type { Language, RunEvent } from '../runner/types';
import { capability, difficultyLabel, previewProblems, sourceLabel } from '../shared/presentation';
import type { ProblemListItem } from '../shared/learning';
import type { ReviewSession } from '../shared/review-plan';
import type { AiHelpDecision } from '../shared/ai';
import { TodayPage } from './TodayPage';
import { NotesPage } from './NotesPage';
import { WorkbenchNoteDialog } from './WorkbenchNoteDialog';
import { SubmissionHistory } from './SubmissionHistory';
import { HistoricalCodePanel } from './HistoricalCodePanel';
import type { SubmissionHistoryDetail, SubmissionHistoryItem } from '../shared/submission-history';
import { LearningSettingsPage } from './LearningSettingsPage';
import { AiPanel } from './AiPanel';
import { OfficialJudgePanel } from './OfficialJudgePanel';
import type { OfficialSubmission } from '../shared/official';
import { ReviewPlanPage } from './ReviewPlanPage';
import { ProblemReviewRating } from './ProblemReviewRating';
import { useOfficialReviewPrompt } from './useOfficialReviewPrompt';
import './review-workbench.css';
import { editsFrozen, flushPendingSaves, setEditsFrozen, useEditsFrozen } from './pending-saves';
import { Editor } from './Editor';
import { LibraryPage } from './LibraryPage';
import { ImportPage } from './ImportPage';
import { ArchivePage } from './ArchivePage';
import { EnvironmentPage } from './EnvironmentPage';
import { usePractice } from './usePractice';
import { makeFrozenPracticeSource, makeReviewPracticeSource, makeReviewSessionPracticeSource, type PracticeNavigationSource } from '../shared/practice-navigation';
import { usePracticeNavigation } from './usePracticeNavigation';
import { useWorkbenchLayout } from './useWorkbenchLayout';
import { WorkbenchSplitter } from './WorkbenchSplitter';
import { practiceShortcutDirection, sidebarAfterNavigation } from './workbench-navigation';
import './workbench-layout.css';
import './workbench-navigation.css';
import { useRuntimeGate } from './useRuntimeGate';
import { RuntimePreparation } from './RuntimePreparation';
import { AcmInputPanel } from './AcmInputPanel';
import { resolvePracticeSpec, serializeAcmTestConfig, type AnswerFormat } from '../shared/answer-format';
import { errorText, formatValue, Icon, type IconName, Statement, statusClass, statusText } from './ui';

const pages: { id: Page; label: string; icon: IconName }[] = [
  { id: 'today', label: '学习中心', icon: 'home' },
  { id: 'reviews', label: '复习计划', icon: 'archive' },
  { id: 'library', label: '题库', icon: 'library' }, { id: 'workbench', label: '练习工作台', icon: 'code' }, { id: 'interview', label: '模拟面试', icon: 'code' },
  { id: 'sources', label: '导入题单', icon: 'source' }, { id: 'notes', label: '学习笔记', icon: 'library' }, { id: 'archives', label: '练习档案', icon: 'archive' }, { id: 'learning-settings', label: '学习设置', icon: 'settings' }, { id: 'environment', label: '运行环境', icon: 'settings' },
];
export function App() {
  const api: DesktopBridge | undefined = window.algo;
  const [page, setPageRaw] = useState<Page>(() => { const desired = sessionStorage.getItem('algo-page'); sessionStorage.removeItem('algo-page'); return desired === 'interview' ? 'interview' : 'today'; }); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [library, setLibrary] = useState<LibraryIndex>({ problems: api ? [] : previewProblems.map(problem => ({ ...problem, capability: capability(problem.content), capabilities: { statement: true, adapter: true, python: true, java: true, cases: problem.content.cases.length, expected: true } })), totalProblems: api ? 0 : previewProblems.length, lists: [], jobs: [] });
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null);
  const [workbenchMounted, setWorkbenchMounted] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [practiceSource, setPracticeSource] = useState<PracticeNavigationSource | null>(null);
  const [problemOpening, setProblemOpening] = useState(false); const problemOpenAction = useRef(false), reviewEntryAction = useRef(false);
  const [neighborOpening, setNeighborOpening] = useState(false); const neighborAction = useRef(false);
  useEffect(() => setPerformancePage(page), [page]);
  const [archiveDate, setArchiveDate] = useState<string | undefined>();
  const [initialImport, setInitialImport] = useState<string | undefined>(); const [importPageKey, setImportPageKey] = useState(0);
  const practice = usePractice(api, setError);
  const runFingerprint = () => `${practice.currentKey.current}:${practice.snapshot().generation}:${page}`;
  const runtimeGate = useRuntimeGate(api, runFingerprint, setError);
  const [running, setRunning] = useState(false); const [runEvent, setRunEvent] = useState<RunEvent | null>(null); const runId = useRef<string | null>(null);
  const [finishing, setFinishing] = useState(false); const finishAction = useRef(false);
  const runCancelled = useRef(false);
  const [selectedRun, setSelectedRun] = useState<RunArchive | null>(null);
  const [historicalCode, setHistoricalCode] = useState<SubmissionHistoryDetail | null>(null);
  const [historyOpening, setHistoryOpening] = useState(false); const historyAction = useRef(false);
  const historyRequest = useRef(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [noteDialog, setNoteDialog] = useState<{ problem: { id: string; title: string }; initialNoteId?: string } | null>(null);
  const remarkSaved = useCallback(() => setHistoryRevision(value => value + 1), []);
  const closeHistoricalCode = useCallback(() => {
    if (editsFrozen() || historyAction.current) return;
    historyAction.current = true; setHistoryOpening(true);
    void flushPendingSaves().then(() => setHistoricalCode(null)).catch(error => setError(errorText(error))).finally(() => { historyAction.current = false; setHistoryOpening(false); });
  }, []);
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
  const statementToggle = useRef<HTMLButtonElement>(null);
  const layout = useWorkbenchLayout({ active: page === 'workbench', showStatement, showHistory });
  const practiceNavigation = usePracticeNavigation(api, practiceSource, practice.target.id);
  const [reveal, setReveal] = useState<{ line: number; column: number; serial: number } | null>(null);
  const [command, setCommand] = useState(''); const [commandIndex, setCommandIndex] = useState(0); const commandDialog = useRef<HTMLDialogElement>(null);
  const [commandProblems, setCommandProblems] = useState<ProblemListItem[]>([]);
  useEffect(() => { let alive = true; const timer = setTimeout(() => { if (api) void api.problemPage({ search: command, limit: 20 }).then(value => { if (alive) setCommandProblems(value.items); }).catch(error => { if (alive) setError(errorText(error)); }); else setCommandProblems(library.problems); }, 150); return () => { alive = false; clearTimeout(timer); }; }, [api, command, library]);
  const frozen = useEditsFrozen(); const navigationBusy = useRef(false);
  const [maintenance, setMaintenance] = useState(false); const [panel, setPanel] = useState<'history' | 'ai'>('history');
  useEffect(() => api?.onAiEvent(event => { if (event.kind === 'official-review' && event.attemptId === attemptId && event.phase === 'queued' && page === 'workbench') setPanel('ai'); }), [api, attemptId, page]);
  const [reviewSession, setReviewSession] = useState<ReviewSession | null>(null);
  const [manualReview, setManualReview] = useState<{ id: string; title: string; attemptId?: string } | null>(null);
  const [reviewAdvancing, setReviewAdvancing] = useState(false);
  const officialPrompt = useOfficialReviewPrompt(api, { page, workspaceKey: practice.key, problemId: practice.target.id,
    submitCleaningUp: submitting, blocked: maintenance || frozen || running || finishing || practice.switching ||
      historyOpening || Boolean(noteDialog || manualReview) || !practice.ready }, setError);
  useEffect(() => { if (officialPrompt.resolvedId) setNotice('该题此学习日的自评已记录；可在复习计划中查看或更正。'); }, [officialPrompt.resolvedId]);
  const [help, setHelp] = useState<AiHelpDecision | null>(null);
  async function setPage(next: Page) {
    if (navigationBusy.current || finishAction.current || editsFrozen() || ((problemOpenAction.current || reviewEntryAction.current || neighborAction.current) && next !== 'workbench')) return false; officialPrompt.invalidate(); navigationBusy.current = true; setEditsFrozen(true, 'navigation');
    try { await flushPendingSaves(); if (next !== page) { runtimeGate.invalidate(); setManualReview(null); officialPrompt.dismiss(); } if (next === 'archives') setArchiveDate(undefined); if (next === 'workbench') setWorkbenchMounted(true); else { historyRequest.current++; setHistoricalCode(null); } setSidebarCollapsed(current => sidebarAfterNavigation(page, next, current)); setPageRaw(next); return true; } catch (error) { setError(errorText(error)); return false; }
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
  useEffect(() => { setSelectedRun(null); setHistoricalCode(null); setReveal(null); setNotice(''); }, [practice.key]);
  useEffect(() => { if (selectedRun && practice.workspace && !practice.workspace.history.some(run => run.id === selectedRun.id)) { setSelectedRun(null); setReveal(null); } }, [practice.workspace, selectedRun]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.defaultPrevented || document.querySelector('dialog[open]')) return; if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommand(''); setCommandIndex(0); commandDialog.current?.showModal(); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, []);

  async function openProblem(id: string, language = practice.target.language, scope = 'practice', answerFormat?: AnswerFormat, source?: PracticeNavigationSource) {
    if (running || officialBusy || problemOpenAction.current || practice.switching || historyAction.current || finishAction.current || editsFrozen()) return false;
    problemOpenAction.current = true; setProblemOpening(true);
    try {
      if (!await setPage('workbench')) return false;
      officialPrompt.invalidate(); runtimeGate.invalidate(); setManualReview(null); officialPrompt.dismiss();
      const opened = await practice.open({ id, language, scope, answerFormat });
      if (opened) {
        setNotice(''); if (!scope.startsWith('review:')) setReviewSession(null);
        if (source) setPracticeSource(source);
        else if (!practiceSource || id !== practice.target.id) setPracticeSource(makeFrozenPracticeSource([id], '单题练习'));
      }
      return Boolean(opened);
    } finally { problemOpenAction.current = false; setProblemOpening(false); }
  }
  async function openReviewProblem(problemId: string, session?: ReviewSession, source?: PracticeNavigationSource) {
    if (!api) { setError('复习和草稿保存需要打开桌面应用。'); return; }
    if (reviewEntryAction.current || problemOpenAction.current || running || officialBusy || editsFrozen() || finishAction.current || historyAction.current) return;
    reviewEntryAction.current = true;
    try {
      const current = session ?? await api.startReviewSession({ requestId: crypto.randomUUID(), problemIds: [problemId] });
      if (current.currentProblemId !== problemId || current.status !== 'active') throw new Error('复习队列已经变化，请在复习计划中重新选择。');
      const metadata = (await api.problemPage({ ids: [problemId], limit: 1 })).items[0];
      let language = practice.target.language;
      if (metadata && !metadata.capabilities[language]) language = metadata.capabilities.python ? 'python' : metadata.capabilities.java ? 'java' : language;
      if (await openProblem(problemId, language, `review:${current.id}`, undefined, source ?? makeReviewSessionPracticeSource(current))) {
        setReviewSession(current); setShowHistory(false); setPanel('history'); setHelp(null);
      }
    } catch (error) { setError(errorText(error)); }
    finally { reviewEntryAction.current = false; }
  }
  const navigationDisabled = !practice.ready || practice.switching || problemOpening || neighborOpening || frozen || finishing || running || officialBusy || historyOpening || reviewAdvancing || practiceNavigation.loading || Boolean(noteDialog || manualReview || officialPrompt.opportunity);
  async function jumpToProblem(id: string | null) {
    if (!id || navigationDisabled || neighborAction.current || !practiceSource) return;
    const expectedKey = practice.currentKey.current;
    neighborAction.current = true; setNeighborOpening(true);
    try {
      const metadata = api ? (await api.problemPage({ ids: [id], limit: 1 })).items[0] : null;
      if (practice.currentKey.current !== expectedKey) return;
      const language = metadata && !metadata.capabilities[practice.target.language]
        ? metadata.capabilities.python ? 'python' : metadata.capabilities.java ? 'java' : practice.target.language : practice.target.language;
      // Browsing keeps both the entry sequence and a review session's persisted position untouched.
      await openProblem(id, language, practice.target.scope, undefined, practiceSource);
    } catch (error) { setError(errorText(error)); }
    finally { neighborAction.current = false; setNeighborOpening(false); }
  }
  useEffect(() => {
    if (page !== 'workbench') return;
    const handler = (event: KeyboardEvent) => {
      const editable = event.target instanceof Element && Boolean(event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .monaco-editor'));
      const direction = practiceShortcutDirection(event, editable, Boolean(document.querySelector('dialog[open]')));
      if (!direction || navigationDisabled) return;
      event.preventDefault(); void jumpToProblem(direction === 'previous' ? practiceNavigation.previousId : practiceNavigation.nextId);
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  });
  async function advanceReview(skipped: boolean) {
    if (!api || !reviewSession || reviewSession.currentProblemId !== practice.target.id || reviewAdvancing || editsFrozen() || running || officialBusy) return;
    setReviewAdvancing(true);
    try {
      await flushPendingSaves();
      const next = await api.advanceReviewSession({ sessionId: reviewSession.id, problemId: practice.target.id, skipped });
      setReviewSession(next);
      if (next.currentProblemId) await openReviewProblem(next.currentProblemId, next, practiceSource ?? undefined);
      else { await setPage('reviews'); setNotice(`本轮复习已结束 · 跳过 ${next.skippedProblemIds.length} 题`); }
    } catch (error) { setError(errorText(error)); }
    finally { setReviewAdvancing(false); }
  }
  async function openArchives(date?: string) { if (await setPage('archives')) setArchiveDate(date); }
  async function openHistoricalCode(item: SubmissionHistoryItem) {
    if (!api || editsFrozen() || historyAction.current || running || officialBusy || practice.switching) return;
    const key = practice.currentKey.current; const request = ++historyRequest.current;
    historyAction.current = true; setHistoryOpening(true);
    try {
      await flushPendingSaves();
      const record = await api.submissionHistoryDetail(item.source, item.id);
      if (practice.currentKey.current === key && historyRequest.current === request) setHistoricalCode(record);
    } catch (error) { setError(errorText(error)); }
    finally { historyAction.current = false; setHistoryOpening(false); }
  }
  async function submitOfficial() {
    const attempt = practice.workspace?.attempt;
    if (!api || !attempt?.isActive || !practice.ready || practice.switching || editsFrozen() || officialAction.current || officialBusy || historyAction.current || finishAction.current) return;
    officialAction.current = true; setSubmitting(true); setError(''); setResultTab('official');
    const snapshot = practice.snapshot(); const expectedKey = practice.currentKey.current;
    try {
      await flushPendingSaves();
      setHistoricalCode(null);
      // Read the saved revision after flushing, then let main validate both code and revision.
      let saved = await api.workspace(snapshot.target.id, snapshot.target.language, snapshot.target.scope, snapshot.target.answerFormat);
      if (!saved.draft && practice.currentKey.current === expectedKey && practice.snapshot().code === snapshot.code) {
        await api.saveDraft(snapshot.target.id, snapshot.target.language, snapshot.code, snapshot.target.scope, { answerFormat: snapshot.target.answerFormat });
        saved = await api.workspace(snapshot.target.id, snapshot.target.language, snapshot.target.scope, snapshot.target.answerFormat);
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
    if (editsFrozen() || !api || running || runId.current || runtimeGate.checking || runtimeGate.isInstalling(practice.target.language) || !practice.ready || practice.switching || !practice.workspace || historyAction.current || finishAction.current) return;
    const snapshot = practice.snapshot(); const expectedKey = practice.key; const version = practice.workspace.problem.version;
    const fingerprint = runFingerprint(); setError(''); setNotice('');
    try {
      await flushPendingSaves();
      setHistoricalCode(null);
      if (fingerprint !== runFingerprint()) return;
      await runtimeGate.request({ problemId: snapshot.target.id, language: snapshot.target.language, code: snapshot.code, scope: snapshot.target.scope, version, answerFormat: snapshot.target.answerFormat, fingerprint }, async token => {
        const request = crypto.randomUUID(); runId.current = request; runCancelled.current = false; setRunning(true); setResultTab('local'); setRunEvent(null);
        try {
          const archive = await api.run(snapshot.target.id, snapshot.target.language, snapshot.code, snapshot.target.scope, request, version, { answerFormat: snapshot.target.answerFormat, preparationToken: token });
          if (practice.currentKey.current === expectedKey) { practice.acceptRun(archive, expectedKey); setSelectedRun(archive); await practice.refresh(expectedKey); }
          await refreshLibrary();
        } finally { setRunning(false); runId.current = null; }
      });
    } catch (error) { setError(errorText(error)); }
  }
  async function finish() {
    if (running || officialBusy || editsFrozen() || finishAction.current || historyAction.current) return;
    runtimeGate.invalidate(); finishAction.current = true; setFinishing(true);
    try { await flushPendingSaves(); const ended = await practice.finish(); if (ended) { setNotice('本次练习已归档；结束练习不自动记录自评。'); await refreshLibrary(); } }
    finally { finishAction.current = false; setFinishing(false); }
  }
  const commands = [
    ...pages.map(item => ({ label: item.label, action: () => setPage(item.id) })),
    ...commandProblems.map(problem => ({ label: `练习 · ${problem.content.title}`, action: () => openProblem(problem.id, undefined, 'practice', undefined, makeFrozenPracticeSource([problem.id], '快速切换 · 单题')) })),
  ].filter(item => item.label.toLowerCase().includes(command.toLowerCase())).slice(0, 20);
  const workspace = practice.workspace; const problem = workspace?.problem.content;
  const spec = problem && workspace ? resolvePracticeSpec(problem, workspace.problem.version, practice.target.answerFormat, practice.testConfig) : null;
  const available = spec ? capability(spec.content, practice.target.language) : null;
  const canSubmitOfficial = problem?.source === 'leetcode-cn' && Boolean(problem.sourceId && problem.starter[practice.target.language]) && practice.target.answerFormat === 'function' && /^https:\/\/leetcode\.cn\/problems\/[a-z0-9][a-z0-9-]*(?:\/description)?\/?$/.test(problem.sourceUrl ?? '');
  const result = selectedRun?.result; const sameVersion = Boolean(selectedRun && selectedRun.code === practice.code && selectedRun.problemVersion === workspace?.problem.version && (selectedRun.answerFormat ?? problem?.mode) === practice.target.answerFormat && (!selectedRun.specVersion || selectedRun.specVersion === spec?.specVersion) && (practice.target.answerFormat !== 'acm' || (selectedRun.testConfig && practice.testConfig && serializeAcmTestConfig(selectedRun.testConfig) === serializeAcmTestConfig(practice.testConfig))));
  const phase = runEvent ? ({ queued: '正在排队', compile: '正在编译', run: '正在执行', finished: '正在保存结果' }[runEvent.phase]) : '正在准备运行';
  const viewControls = <div className="view-controls"><button ref={statementToggle} aria-pressed={showStatement} onClick={() => setShowStatement(!showStatement)}>{showStatement ? '收起题面' : '展开题面'}</button><button aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>{showHistory ? '收起记录' : '展开记录'}</button>{workspace?.attempt ? <button disabled={frozen || finishing || historyOpening || running || officialBusy || practice.switching || !practice.ready} onClick={() => { void finish().catch(error => setError(errorText(error))); }}>结束练习</button> : <button disabled={!api || practice.switching || !practice.ready} onClick={() => { void openProblem(practice.target.id, practice.target.language, practice.target.scope); }}>开始新练习</button>}</div>;
  return <div className="app-shell app-shell-p2" data-page={page} data-sidebar-collapsed={sidebarCollapsed}>
    <aside id="main-navigation" className="sidebar"><a className="wordmark" aria-label="题炼 · 学习中心" title="学习中心" href="#today" onClick={event => { event.preventDefault(); setPage('today'); }}><span className="brand-symbol">t.</span><span>题炼</span></a>
      <button className="search-launch" aria-label="快速切换页面或题目" onClick={() => { setCommand(''); setCommandIndex(0); commandDialog.current?.showModal(); }}><Icon name="search" /><span>快速切换</span><kbd>⌘ / Ctrl K</kbd></button>
      <nav aria-label="主导航">{pages.map(item => <button key={item.id} title={item.label} aria-label={item.label} data-group-start={item.id === 'sources' || item.id === 'learning-settings' || undefined} aria-current={page === item.id ? 'page' : undefined} onClick={() => setPage(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-footer"><span className="local-indicator" />本地练习 · <span aria-label={`当前版本 ${appVersion}`}>v{appVersion}</span></div>
    </aside>
    <main className="main-shell"><header className="app-header"><div className="header-title"><button type="button" className="sidebar-toggle" aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} aria-expanded={!sidebarCollapsed} aria-controls="main-navigation" onClick={() => setSidebarCollapsed(current => !current)}><Icon name="sidebar" /></button><div><span className="breadcrumb">{page === 'workbench' && problem ? `${sourceLabel(problem.source)} / ${problem.tags[0] || '算法练习'}` : '题炼 / 我的学习'}</span><h1>{pages.find(item => item.id === page)?.label}</h1></div></div>{page === 'workbench' && problem ? viewControls : <span className="local-label"><span className="local-indicator" /> 本地空间</span>}</header>
      {maintenance && <div className="maintenance-banner" role="status">正在保存编辑并恢复备份，请等待应用重新打开。</div>}
      {error && <div role="alert" className="error-banner"><span>{error}</span><button onClick={() => setError('')}>收起</button></div>}
      {notice && <div role="status" className="preview-banner"><span>{notice}</span><button className="text-button" onClick={() => setPage(/自评|复习/.test(notice) ? 'reviews' : 'archives')}>{/自评|复习/.test(notice) ? '查看复习计划' : '查看档案'}</button><button onClick={() => setNotice('')}>收起</button></div>}
      {environment?.reminder && !environment.reminder.deliveredAt && Date.parse(environment.reminder.dueAt) <= Date.now() && <div className="preview-banner overdue-banner" role="status">有一条测试提醒已逾期。<button className="text-button" onClick={() => setPage('environment')}>查看提醒</button></div>}
      {!api && <p className="preview-banner">当前为浏览器设计预览。运行、导入和保存需要打开桌面应用。</p>}
      {page === 'interview' && <InterviewPage api={api} onError={setError} onNavigate={next => { void setPage(next); }} />}
      {page === 'today' && <TodayPage api={api} library={library} onReview={item => { void openReviewProblem(item.problemId, undefined, makeReviewPracticeSource({ view: 'today' }, '今日复习')); }} onReviewPlan={() => { void setPage('reviews'); }} onSettings={() => { void setPage('learning-settings'); }} onArchives={date => { void openArchives(date); }} onBrowse={() => { void setPage('library'); }} onError={setError} />}
      {page === 'reviews' && <ReviewPlanPage api={api} onPractice={openReviewProblem} onChanged={refreshLibrary} onError={setError} />}
      {page === 'notes' && <NotesPage api={api} library={library} initialSubject={practice.target.id} onError={setError} />}
      {page === 'learning-settings' && <LearningSettingsPage api={api} onError={setError} />}
      {page === 'library' && <LibraryPage api={api} data={library} onOpen={(id, source) => { void openProblem(id, undefined, 'practice', undefined, source); }} onImport={openImport} onChanged={refreshLibrary} onError={setError} />}
      {page === 'sources' && <ImportPage key={importPageKey} api={api} lists={library.lists} jobs={library.jobs} initialUrl={initialImport} onChanged={refreshLibrary} onOpenLibrary={() => setPage('library')} onError={setError} />}
      {page === 'archives' && <ArchivePage key={archiveDate ?? 'all'} initialLearningDate={archiveDate} api={api} onError={setError} onRestore={async archive => { if (!api) return; await practice.flush(); const restored = await api.restoreRun(archive.id, crypto.randomUUID()); await openProblem(restored.draft.problemId, restored.draft.language, restored.draft.scopeId, restored.draft.answerFormat ?? undefined, makeFrozenPracticeSource([restored.draft.problemId], '档案恢复 · 单题')); setNotice('已恢复为新草稿。'); }} />}
      {page === 'environment' && <EnvironmentPage api={api} onError={setError} onChanged={() => { void refreshEnvironment().catch(error => setError(errorText(error))); }} />}
      {workbenchMounted && <div className="workbench-screen" hidden={page !== 'workbench'}>{problem ? <>
        {reviewSession && practice.target.scope === `review:${reviewSession.id}` && <section className="version-notice review-session-bar" aria-label="复习会话"><span>{reviewSession.currentProblemId === practice.target.id ? '复习' : '浏览邻题 · 队列进度保留'} · 第 {reviewSession.position + 1} / {reviewSession.problemIds.length} 题</span><div className="button-row"><button className="button" disabled={navigationDisabled || Boolean(officialPrompt.opportunity)} onClick={() => setManualReview({ id: practice.target.id, title: problem.title, attemptId: workspace?.attempt?.id })}>记录本题自评</button>{reviewSession.currentProblemId === practice.target.id ? <><button className="button" disabled={navigationDisabled} onClick={() => { void advanceReview(false); }}>已自评，下一题</button><button className="text-button" disabled={navigationDisabled} onClick={() => { void advanceReview(true); }}>跳过本题</button></> : <button className="button" disabled={navigationDisabled} onClick={() => { void jumpToProblem(reviewSession.currentProblemId); }}>回到队列当前题</button>}<button className="text-button" disabled={frozen || reviewAdvancing || problemOpening || neighborOpening} onClick={() => { void setPage('reviews'); }}>退出并保留进度</button></div></section>}
        {help?.show && <div className="help-prompt"><span>{help.reason === 'compile-error' ? '编译未通过' : '连续 3 次运行未通过'}</span><button className="button" onClick={() => { setPanel('ai'); setShowHistory(true); setHelp(null); }}>打开 AI 教练</button><button className="text-button" onClick={() => { if (workspace?.attempt) void api?.dismissAiHelp(workspace.attempt.id); setHelp(null); }}>关闭提示</button></div>}
        {workspace?.latestVersion !== workspace?.problem.version && <div className="version-notice">此练习使用开始时的题面；结束后，新练习将使用已缓存的新版。</div>}
        {practice.target.scope !== 'practice' && <div className="version-notice">{practice.target.scope.startsWith('review:') ? '当前为独立复习草稿，不覆盖普通练习。' : '当前是从档案恢复的独立草稿。'}<button className="text-button" onClick={() => { void openProblem(practice.target.id, practice.target.language); }}>回到普通草稿</button></div>}
        {runtimeGate.pending && <RuntimePreparation language={runtimeGate.pending.input.language} state={runtimeGate.pending.prepared.runtime} progress={runtimeGate.progress[runtimeGate.pending.input.language]} installing={runtimeGate.installing[runtimeGate.pending.input.language]} autoInstall={runtimeGate.pending.prepared.autoInstall} intentCurrent={runtimeGate.intentCurrent} error={runtimeGate.error} onInstall={() => { void runtimeGate.install(); }} onOffline={() => { void runtimeGate.install(true); }} onSelect={() => { void runtimeGate.select(); }} onCancel={() => { void runtimeGate.cancel(); }} onDismiss={runtimeGate.dismiss} onAutoInstallChange={value => { void runtimeGate.setAutoInstall(value); }} />}
        {practice.target.answerFormat === 'acm' && problem.source === 'leetcode-cn' && <div className="version-notice">当前为本地 ACM 练习，不能直接提交力扣。<button className="text-button" disabled={running || officialBusy || problem.mode !== 'function'} onClick={() => { void openProblem(practice.target.id, practice.target.language, practice.target.scope, 'function'); }}>切换函数式</button></div>}
        <div ref={layout.workbenchRef} className="workbench workbench-p2" data-layout={layout.mode} data-statement={showStatement} data-history={showHistory} style={layout.style}>
          {showStatement && <><section className="statement" aria-label="题目描述"><div className="statement-heading"><span>题目</span><button aria-label="收起题目描述" onClick={() => { setShowStatement(false); statementToggle.current?.focus(); }}>收起</button></div><nav className="practice-navigation" aria-label="题目切换"><div className="button-row"><button className="button" aria-keyshortcuts="Alt+ArrowLeft" title="上一题 · Alt + ←（输入框和代码编辑器内不触发）" disabled={navigationDisabled || !practiceNavigation.previousId} onClick={() => { void jumpToProblem(practiceNavigation.previousId); }}>← 上一题</button><button className="button" aria-keyshortcuts="Alt+ArrowRight" title="下一题 · Alt + →（输入框和代码编辑器内不触发）" disabled={navigationDisabled || !practiceNavigation.nextId} onClick={() => { void jumpToProblem(practiceNavigation.nextId); }}>下一题 →</button></div><p className="practice-navigation-status" role="status">{practiceNavigation.loading ? '正在读取题单顺序…' : practiceNavigation.index >= 0 ? `${practiceNavigation.label} · ${practiceNavigation.index + 1} / ${practiceNavigation.total}` : practiceNavigation.label || '单题练习'}</p>{practiceNavigation.error && <p className="practice-navigation-error">{practiceNavigation.error}<button className="text-button" disabled={problemOpening || neighborOpening} onClick={practiceNavigation.reload}>重试</button></p>}<span className="practice-navigation-help">Alt + ← / → 切题；输入时不触发</span></nav><h2>{problem.title}</h2><div className="statement-meta"><span className="problem-difficulty">{difficultyLabel(problem.difficulty)}</span><span>{problem.mode === 'function' ? '函数题' : 'ACM'}</span>{problem.sourceUrl && <button className="text-button" disabled={!api} onClick={() => api?.openSource(problem.sourceUrl!).catch(error => setError(errorText(error)))}>打开原站 ↗</button>}</div><Statement content={problem} /><div className="statement-footnote"><strong>{available?.label}</strong><p>{available?.reason}</p></div></section><WorkbenchSplitter side="statement" value={layout.sizes.statement} {...layout.ranges.statement} defaultValue={layout.defaults.statement} onChange={value => layout.changeSize('statement', value)} /></>}
          <section ref={layout.codingRef} style={layout.codingStyle} className="coding-pane" aria-label="代码与测试"><div className="editor-toolbar"><label className="language-label"><span className="sr-only">编程语言</span><select aria-label="编程语言" value={practice.target.language} disabled={!practice.ready || practice.switching || running || officialBusy} onChange={event => { void openProblem(practice.target.id, event.target.value as Language, practice.target.scope, practice.target.answerFormat); }}><option value="python">Python</option><option value="java">Java</option></select></label><label className="language-label"><span className="sr-only">答题格式</span><select aria-label="答题格式" value={practice.target.answerFormat ?? problem.mode} disabled={!practice.ready || practice.switching || running || officialBusy} onChange={event => { void openProblem(practice.target.id, practice.target.language, practice.target.scope, event.target.value as AnswerFormat); }}><option value="function" disabled={problem.mode !== 'function'}>函数式</option><option value="acm">ACM · 标准输入输出</option></select></label><span className={practice.saving === '保存失败' ? 'save-state error-text' : 'save-state'} role="status">{practice.saving}</span>{practice.saving === '保存失败' && <button className="text-button" onClick={() => { void practice.flush().catch(() => {}); }}>重试保存</button>}<div className="run-actions">{canSubmitOfficial && <button className="button official-judge" disabled={!api || !practice.ready || practice.switching || frozen || officialBusy || !workspace?.attempt?.isActive} title="以当前力扣账号提交代码，结果将保存在练习档案" onClick={() => { void submitOfficial(); }}>{officialBusy ? '正在判题…' : '提交到力扣'}</button>}{running ? <button className="button primary" onClick={() => { runCancelled.current = true; void api?.cancel().catch(error => setError(errorText(error))); }}><Icon name="stop" />停止</button> : <button className="button primary" disabled={!api || !practice.ready || practice.switching || runtimeGate.checking || runtimeGate.installing[practice.target.language] || !available?.canRun} onClick={() => { void run(); }}><Icon name="play" />{runtimeGate.installing[practice.target.language] ? '环境安装中…' : runtimeGate.checking ? '检测环境…' : '运行'}</button>}</div></div>
            {practice.ready ? <Editor key={practice.key} code={practice.code} language={practice.target.language} readOnly={practice.switching || frozen || finishing} onChange={value => { runtimeGate.invalidate(); practice.edit(value); }} onRun={run} diagnostics={sameVersion ? result?.diagnostics : []} reveal={reveal} /> : <div className="editor-loading">正在读取草稿…</div>}
            <WorkbenchSplitter side="results" value={layout.sizes.results} {...layout.ranges.results} defaultValue={layout.defaults.results} onChange={value => layout.changeSize('results', value)} />
            {historicalCode && api ? <HistoricalCodePanel key={`${historicalCode.source}:${historicalCode.id}`} api={api} record={historicalCode} busy={historyOpening || practice.switching || !practice.ready || running || submitting || finishing} onClose={closeHistoricalCode} onRemarkSaved={remarkSaved} /> : <section className="results-pane" aria-label="测试结果"><div className="results-heading"><div className="panel-tabs" role="group" aria-label="判题来源"><button aria-pressed={resultTab === 'local'} onClick={() => setResultTab('local')}>本地运行</button>{(canSubmitOfficial || activeOfficialRecords.length > 0) && <button aria-pressed={resultTab === 'official'} onClick={() => setResultTab('official')}>力扣官方{officialBusy ? ' · 判题中' : ''}</button>}</div>{resultTab === 'local' && <span>{running ? `${phase}${runEvent?.caseIndex === undefined ? '' : ` · 用例 ${runEvent.caseIndex + 1}`}` : `${spec?.content.cases.length ?? 0} 个本地用例`}</span>}</div>
              {practice.target.answerFormat === 'acm' && practice.testConfig && spec && <AcmInputPanel config={practice.testConfig} disabled={running || frozen || practice.switching} inputDescription={spec.inputDescription} outputDescription={spec.outputDescription} onChange={value => { runtimeGate.invalidate(); practice.editTests(value); }} />}
              {resultTab === 'official' ? <OfficialJudgePanel key={attemptId} records={activeOfficialRecords} currentCode={practice.code} problemVersion={workspace?.problem.version} focusId={officialFocus} busy={officialBusy || frozen} onResume={id => { void resumeOfficial(id); }} onLogin={() => { void api?.loginSource().catch(error => setError(errorText(error))); }} onOpen={url => { void api?.openWebLink(url).catch(error => setError(errorText(error))); }} onCoach={() => { setPanel('ai'); setShowHistory(true); }} /> : <>
              {result ? <><div className="result-summary"><strong className={statusClass(result.status)}>{result.status === 'passed' ? '✓ ' : '· '}{statusText[result.status]}</strong><span>{Math.round(result.durationMs)} ms</span>{!sameVersion && <span className="old-version">针对先前代码、题面或测试配置</span>}</div><div className="case-list">{result.caseResults.map(test => <details className="case-detail" key={test.index}><summary><span>用例 {test.index + 1}</span><span className={statusClass(test.status)}>{statusText[test.status]}</span><code>{formatValue(test.actual).slice(0, 120)}</code></summary><dl><dt>实际输出</dt><dd><pre>{formatValue(test.actual)}</pre></dd><dt>期望输出</dt><dd><pre>{formatValue(test.expected)}</pre></dd>{test.stdout && <><dt>标准输出</dt><dd><pre>{test.stdout}</pre></dd></>}{test.stderr && <><dt>标准错误</dt><dd><pre>{test.stderr}</pre></dd></>}</dl></details>)}</div>{result.diagnostics.map((diagnostic, index) => <div key={index} className="diagnostic-item">{diagnostic.line && diagnostic.source === 'user' && <button className="text-button" disabled={!sameVersion} onClick={() => setReveal({ line: diagnostic.line!, column: diagnostic.column ?? 1, serial: Date.now() })}>定位第 {diagnostic.line} 行{diagnostic.column ? `，第 ${diagnostic.column} 列` : ''}</button>}<pre className="diagnostic">{diagnostic.message}</pre></div>)}{result.stdout && <details><summary>标准输出</summary><pre className="diagnostic">{result.stdout}</pre></details>}</> : <div className="results-empty"><span className="empty-mark">›_</span><p>{available?.canRun ? '尚未运行' : '此题暂不支持本地运行'}<br /><span>{available?.canRun ? '⌘ / Ctrl + Enter 运行' : available?.reason}</span></p></div>}
              </>}
            </section>}
          </section>
          {showHistory && <><WorkbenchSplitter side="history" value={layout.sizes.history} {...layout.ranges.history} defaultValue={layout.defaults.history} onChange={value => layout.changeSize('history', value)} /><aside className="history-pane" aria-label="练习记录与 AI"><div className="panel-tabs"><button aria-pressed={panel === 'history'} onClick={() => setPanel('history')}>运行记录</button><button aria-pressed={panel === 'ai'} onClick={() => setPanel('ai')}>AI 教练</button><button disabled={!api || frozen || practice.switching || finishing} onClick={() => setNoteDialog({ problem: { id: practice.target.id, title: problem.title } })}>记笔记</button></div>{panel === 'ai' ? <AiPanel key={workspace?.attempt?.id ?? 'none'} active={page === 'workbench'} api={api} attempt={workspace?.attempt ?? null} code={practice.code} selectedRun={selectedRun} flush={flushPendingSaves} onApply={async requestId => { if (!api || editsFrozen()) return; const key = practice.currentKey.current; setEditsFrozen(true, 'patch'); try { await flushPendingSaves(); const draft = await api.applyAiPatch(requestId); practice.acceptDraft(draft.code, key); await practice.refresh(key); } finally { setEditsFrozen(false, 'patch'); } }} onNoteSaved={note => setNoteDialog({ problem: { id: practice.target.id, title: problem.title }, initialNoteId: note.id })} onSettings={() => { void setPage('learning-settings'); }} onError={setError} /> : <SubmissionHistory key={practice.key} active={page === 'workbench'} api={api} problemId={practice.target.id} language={practice.target.language} answerFormat={practice.target.answerFormat} refreshKey={`${workspace?.history[0]?.id ?? ''}:${activeOfficialRecords.map(record => `${record.id}:${record.updatedAt}`).join(',')}:${historyRevision}`} selectedKey={historicalCode ? `${historicalCode.source}:${historicalCode.id}` : undefined} busy={historyOpening || frozen || running || officialBusy || practice.switching || finishing} onSelect={item => { void openHistoricalCode(item); }} onArchives={() => { void setPage('archives'); }} />}</aside></>}
        </div>
      </> : <div className="empty-state"><h2>正在读取工作台</h2><p>可先从题库中选择需要练习的题目。</p><button className="text-button" onClick={() => setPage('library')}>打开题库</button></div>}</div>}
      <footer className="status-bar"><span>{running ? `${phase} · 本地执行` : '题炼'}</span><span>{library.jobs.some(job => job.status === 'running') ? '题单正在后台准备' : `${library.totalProblems} 道题目保存在本机`}</span></footer>
    </main>
    {noteDialog && api && <WorkbenchNoteDialog key={`${noteDialog.problem.id}:${noteDialog.initialNoteId ?? 'new'}`} api={api} problem={noteDialog.problem} initialNoteId={noteDialog.initialNoteId} onClose={() => setNoteDialog(null)} onError={setError} />}
    {officialPrompt.opportunity && api && <ProblemReviewRating key={officialPrompt.opportunity.id} api={api} problem={{ id: officialPrompt.opportunity.problemId, title: problem?.title ?? '本题' }} mode={{ kind: 'official', opportunity: officialPrompt.opportunity }} autoPrompt onSaved={async () => { officialPrompt.dismiss(); setNotice('自评已记录，题目复习计划已更新。'); await refreshLibrary(); }} onDismiss={officialPrompt.dismiss} onError={setError} />}
    {manualReview && api && <ProblemReviewRating key={`manual:${manualReview.id}`} api={api} problem={manualReview} mode={{ kind: 'manual', attemptId: manualReview.attemptId }} onSaved={async () => { setManualReview(null); setNotice('自评已记录，可继续下一题。'); await refreshLibrary(); }} onDismiss={() => setManualReview(null)} onError={setError} />}
    <dialog ref={commandDialog} className="command-dialog" aria-labelledby="command-title" onClick={event => { if (event.target === commandDialog.current) commandDialog.current.close(); }}><h2 id="command-title">快速切换</h2><label htmlFor="command-search" className="sr-only">搜索页面或题目</label><input id="command-search" autoFocus placeholder="搜索页面或题目" value={command} onChange={event => { setCommand(event.target.value); setCommandIndex(0); }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setCommandIndex(index => Math.max(0, Math.min(index + 1, commands.length - 1))); } if (event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex(index => Math.max(0, index - 1)); } if (event.key === 'Enter' && commands[commandIndex]) { event.preventDefault(); void commands[commandIndex].action(); commandDialog.current?.close(); } }} /><div className="command-list">{commands.map((item, index) => <button key={item.label} className={index === commandIndex ? 'selected' : ''} onClick={() => { void item.action(); commandDialog.current?.close(); }}>{item.label}<span>↵</span></button>)}{!commands.length && <p>没有匹配的页面或题目。</p>}</div><button className="text-button" onClick={() => commandDialog.current?.close()}>关闭 <kbd>Esc</kbd></button></dialog>
  </div>;
}
