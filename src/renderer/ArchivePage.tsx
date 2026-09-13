import { useEffect, useMemo, useState } from 'react';
import type { DesktopBridge, RunArchive } from '../shared/bridge';
import { archiveDateBoundary } from '../shared/archive-date';
import type { ProblemContent } from '../shared/library';
import type { ArchiveStatistics, AttemptListItem, AttemptPageFilter, PageResult, RunListItem } from '../shared/learning';
import { Markdown } from './Markdown';
import { CodeComparison } from './CodeComparison';
import { useEditsFrozen } from './pending-saves';
import { errorText, formatValue, Statement, statusClass, statusText } from './ui';

const ATTEMPT_PAGE_SIZE = 30;
const RUN_PAGE_SIZE = 50;
const emptyPage = <T,>(limit: number): PageResult<T> => ({ items: [], total: 0, offset: 0, limit, hasMore: false });
type ArchiveOverview = Awaited<ReturnType<DesktopBridge['archiveOverview']>>;
type ArchiveLearning = Awaited<ReturnType<DesktopBridge['archiveLearning']>>;

function ArchivePager({ page, loading, label, onOffset }: { page: PageResult<unknown>; loading: boolean; label: string; onOffset: (offset: number) => void }) {
  if (!page.total) return null;
  return <div className="compact-actions" role="group" aria-label={`${label}分页`}>
    <button className="button" aria-label={`${label}上一页`} disabled={loading || page.offset === 0} onClick={() => onOffset(Math.max(0, page.offset - page.limit))}>上一页</button>
    <span className="field-help" aria-live="polite">{page.offset + 1}–{Math.min(page.offset + page.items.length, page.total)} / 共 {page.total} 条{loading ? ' · 正在读取…' : ''}</span>
    <button className="button" aria-label={`${label}下一页`} disabled={loading || !page.hasMore} onClick={() => onOffset(page.offset + page.limit)}>下一页</button>
  </div>;
}

export function ArchivePage({ api, initialLearningDate, onRestore, onError }: { initialLearningDate?: string; api: DesktopBridge | undefined; onRestore: (run: RunArchive) => Promise<void>; onError: (message: string) => void }) {
  const [learningDate, setLearningDate] = useState(initialLearningDate ?? '');
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const dateTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  const [deleting, setDeleting] = useState(false); const [deleteOpen, setDeleteOpen] = useState(false);
  const [language, setLanguage] = useState('all'); const [helpFilter, setHelpFilter] = useState('all'); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [refresh, setRefresh] = useState(0);
  const [compare, setCompare] = useState(''); const [statistics, setStatistics] = useState<ArchiveStatistics | null>(null); const frozen = useEditsFrozen();
  const [archives, setArchives] = useState<PageResult<AttemptListItem>>(emptyPage(ATTEMPT_PAGE_SIZE)); const [archiveOffset, setArchiveOffset] = useState(0);
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(''); const [overview, setOverview] = useState<ArchiveOverview | null>(null); const [detailLoading, setDetailLoading] = useState(false);
  const [runPage, setRunPage] = useState<PageResult<RunListItem>>(emptyPage(RUN_PAGE_SIZE)); const [runOffset, setRunOffset] = useState(0); const [runPageLoading, setRunPageLoading] = useState(false);
  const [runId, setRunId] = useState(''); const [runValue, setRunValue] = useState<RunArchive | null>(null); const [runLoading, setRunLoading] = useState(false);
  const [comparedValue, setComparedValue] = useState<RunArchive | null>(null); const [compareLoading, setCompareLoading] = useState(false);
  const [learning, setLearning] = useState<{ attemptId: string; refresh: number; value: ArchiveLearning } | null>(null); const [learningLoading, setLearningLoading] = useState(false);
  const [aiOpen, setAiOpen] = useState(false); const [notesOpen, setNotesOpen] = useState(false);
  const [loading, setLoading] = useState(true); const [restoring, setRestoring] = useState(false);
  const dateFilter = useMemo((): { from?: string; to?: string; error?: string } => {
    if (from && to && from > to) return { error: '开始日期不能晚于截止日期。' };
    try { return { ...(from ? { from: archiveDateBoundary(from, timeZone) } : {}), ...(to ? { to: archiveDateBoundary(to, timeZone, true) } : {}) }; }
    catch { return { error: '请检查日期和学习时区。' }; }
  }, [from, to, timeZone]);
  useEffect(() => { const remove = api?.onLibraryChanged(() => { if (!deleting) setRefresh(value => value + 1); }); return () => remove?.(); }, [api, deleting]);
  useEffect(() => { let alive = true; if (api) void Promise.all([api.learningStatistics(), api.learningSettings()]).then(([value, settings]) => { if (alive) { setStatistics(value); setTimeZone(settings.timeZone); } }).catch(error => { if (alive) onError(errorText(error)); }); return () => { alive = false; }; }, [api, refresh]);
  useEffect(() => {
    let alive = true; setLoading(true);
    const filters: AttemptPageFilter = { offset: archiveOffset, limit: ATTEMPT_PAGE_SIZE, ...(learningDate ? { learningDate, timeZone } : {}),
      ...(query.trim() ? { search: query.trim() } : {}), ...(filter !== 'all' ? { state: filter as 'active' | 'ended' } : {}),
      ...(language !== 'all' ? { language: language as 'python' | 'java' } : {}), ...(helpFilter !== 'all' ? { helpLevel: helpFilter as AttemptPageFilter['helpLevel'] } : {}),
      ...(dateFilter.from ? { from: dateFilter.from } : {}), ...(dateFilter.to ? { to: dateFilter.to } : {}) };
    if (!api || dateFilter.error) { setArchives(emptyPage(ATTEMPT_PAGE_SIZE)); setLoading(false); return; }
    void api.attemptPage(filters).then(page => {
      if (!alive) return;
      if (archiveOffset > 0 && page.items.length === 0) { setArchiveOffset(Math.max(0, Math.floor((page.total - 1) / ATTEMPT_PAGE_SIZE) * ATTEMPT_PAGE_SIZE)); return; }
      setArchives(page);
    }).catch(error => { if (alive) onError(errorText(error)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, archiveOffset, query, filter, language, helpFilter, dateFilter, refresh, learningDate, timeZone]);
  function selectArchive(id: string) { if (id === selected) return; setSelected(id); setRunOffset(0); setRunId(''); setCompare(''); setRunPage(emptyPage(RUN_PAGE_SIZE)); setDeleteOpen(false); setLearning(null); setAiOpen(false); setNotesOpen(false); }
  useEffect(() => {
    let alive = true; setOverview(current => current?.attempt.id === selected ? current : null); setDetailLoading(Boolean(selected && api));
    if (selected && api) void api.archiveOverview(selected).then(value => { if (alive) setOverview(value); }).catch(error => { if (alive) { setOverview(null); onError(errorText(error)); } }).finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [selected, api, refresh]);
  useEffect(() => {
    let alive = true; setRunPageLoading(Boolean(selected && api));
    if (selected && api) void api.runPage({ attemptId: selected, offset: runOffset, limit: RUN_PAGE_SIZE }).then(page => {
      if (!alive) return;
      if (runOffset > 0 && page.items.length === 0) { setRunOffset(Math.max(0, Math.floor((page.total - 1) / RUN_PAGE_SIZE) * RUN_PAGE_SIZE)); return; }
      setRunPage(page); setRunId(current => current || page.items[0]?.id || '');
    }).catch(error => { if (alive) onError(errorText(error)); }).finally(() => { if (alive) setRunPageLoading(false); });
    return () => { alive = false; };
  }, [selected, api, runOffset, refresh]);
  useEffect(() => {
    let alive = true; setRunValue(null); setRunLoading(Boolean(runId && api));
    if (runId && api && selected) void api.runDetail(runId).then(value => { if (value.attemptId !== selected) throw new Error('运行快照与所选练习不一致。'); if (alive) setRunValue(value); }).catch(error => { if (alive) onError(errorText(error)); }).finally(() => { if (alive) setRunLoading(false); });
    return () => { alive = false; };
  }, [runId, selected, api]);
  useEffect(() => {
    let alive = true; setComparedValue(null); setCompareLoading(Boolean(compare && compare !== 'final' && api));
    if (compare && compare !== 'final' && api && selected) void api.runDetail(compare).then(value => { if (value.attemptId !== selected) throw new Error('对比快照与所选练习不一致。'); if (alive) setComparedValue(value); }).catch(error => { if (alive) onError(errorText(error)); }).finally(() => { if (alive) setCompareLoading(false); });
    return () => { alive = false; };
  }, [compare, selected, api]);
  const learningNeeded = aiOpen || notesOpen;
  useEffect(() => {
    if (!api || !selected || !learningNeeded || (learning?.attemptId === selected && learning.refresh === refresh)) return;
    let alive = true; setLearningLoading(true);
    void api.archiveLearning(selected).then(value => { if (alive) setLearning({ attemptId: selected, refresh, value }); }).catch(error => { if (alive) onError(errorText(error)); }).finally(() => { if (alive) setLearningLoading(false); });
    return () => { alive = false; };
  }, [selected, api, refresh, learningNeeded]);
  const detail = overview?.attempt.id === selected ? overview : null;
  const run = runValue?.id === runId && runValue.attemptId === selected ? runValue : null;
  const comparedRun = comparedValue?.id === compare && comparedValue.attemptId === selected ? comparedValue : null;
  const learningValue = learning?.attemptId === selected ? learning.value : null;
  const content = detail?.attempt.problemSnapshot as unknown as ProblemContent | undefined;
  return <section className="archives-page scroll-page"><div className="page-intro"><div><h2>每一次练习，都有存档</h2><p>题面、代码和测试结果保留当时的版本。恢复历史会另建草稿。</p></div><span className="muted">{archives.total} 次练习</span></div>
    {statistics && <details className="learning-section"><summary>学习统计 · 有效练习 {Math.round(statistics.activeMs / 60000)} 分钟 · 复习 {statistics.reviewedItems} 项</summary><p className="field-help">仅累计前台练习且近期有操作的时间；关闭窗口、系统睡眠和长期闲置不计入。</p><div className="study-list">{statistics.days.slice(-14).reverse().map(day => <div className="study-row" key={day.date}><strong>{day.date}</strong><span>{Math.round(day.activeMs / 60000)} 分钟 · {day.runs} 次运行 · {day.passedRuns} 次通过 · {day.reviewCount} 次复习</span></div>)}</div></details>}
    {learningDate && <div className="archive-day-filter"><span>{learningDate} 的学习记录</span><button className="text-button" onClick={() => { setLearningDate(''); setArchiveOffset(0); }}>查看全部日期 ×</button></div>}
    <div className="library-filters"><label className="search-field">搜索练习<input type="search" value={query} placeholder="按题目名称查找" onChange={event => { setQuery(event.target.value); setArchiveOffset(0); }} /></label><label>练习状态<select value={filter} onChange={event => { setFilter(event.target.value); setArchiveOffset(0); }}><option value="all">全部练习</option><option value="ended">已结束</option><option value="active">进行中</option></select></label><label>语言<select value={language} onChange={event => { setLanguage(event.target.value); setArchiveOffset(0); }}><option value="all">全部语言</option><option value="python">Python</option><option value="java">Java</option></select></label><label>最高 AI 帮助<select value={helpFilter} onChange={event => { setHelpFilter(event.target.value); setArchiveOffset(0); }}><option value="all">全部</option><option value="none">未取得 AI 帮助</option>{['L0','L1','L2','L3','L4'].map(value => <option key={value}>{value}</option>)}</select></label><label>开始日期（{timeZone}）<input type="date" value={from} onChange={event => { setFrom(event.target.value); setArchiveOffset(0); }} /></label><label>截止日期<input type="date" value={to} onChange={event => { setTo(event.target.value); setArchiveOffset(0); }} /></label></div>
    {dateFilter.error && <p className="field-help error-text" role="status">{dateFilter.error}</p>}
    <ArchivePager page={archives} loading={loading || deleting || restoring} label="练习档案" onOffset={setArchiveOffset} />
    <div className="archive-layout"><div className="archive-list" aria-label="练习列表" aria-busy={loading}>{archives.items.map(row => <button key={row.attempt.id} className={selected === row.attempt.id ? 'selected' : ''} disabled={deleting || restoring || loading} onClick={() => selectArchive(row.attempt.id)}><span className="archive-title">{row.title}</span><span>{row.attempt.language === 'python' ? 'Python' : 'Java'} · {dateTime(row.attempt.startedAt)}</span><span>{row.attempt.isActive ? '进行中' : '已结束'} · {row.runCount} 次运行 · {Math.round((row.activeMs ?? 0) / 60000)} 分钟{row.helpLevel ? ` · ${row.helpLevel} 帮助` : ''}</span>{!row.attempt.isActive && row.attempt.lastRunMatchesFinal === false && <span className="warning-text">最终代码尚未运行</span>}</button>)}{!archives.items.length && <div className="empty-state"><h3>{loading ? '正在读取档案…' : '还没有匹配的练习'}</h3><p>在工作台开始练习并运行代码后，记录会出现在这里。</p></div>}</div>
      <section className="archive-detail" aria-label="档案详情">{detail ? <><div className="section-heading"><div><h3>{content?.title || detail.attempt.problemId}</h3><p>{dateTime(detail.attempt.startedAt)}{detail.attempt.endedAt ? ` → ${dateTime(detail.attempt.endedAt)}` : ' · 进行中'}</p></div><span className="muted">{detail.attempt.language === 'python' ? 'Python' : 'Java'}</span></div>
        {!detail.attempt.isActive && <div className="archive-conclusion" role="status"><strong>{detail.attempt.lastRunMatchesFinal ? '最终代码与最后一次运行一致' : '最终代码尚未运行'}</strong><p>{detail.attempt.lastRunMatchesFinal ? '测试结果仅对应这里保存的代码和用例。' : '最后一次测试的结果不能代表最终代码。归档内容不会因后续修改而改变。'}</p></div>}
        {content?.description && <details><summary>查看当时的题面</summary><Statement content={{ ...content, descriptionFormat: content.descriptionFormat || 'plain', constraints: content.constraints || [], cases: content.cases || [] }} /></details>}
        {!detail.attempt.isActive && <details><summary>归档的最终代码</summary><pre className="archive-code">{detail.attempt.finalCode}</pre></details>}
        <div className="archive-run-picker"><label>选择运行快照<select aria-label="选择运行快照" value={runId} disabled={runPageLoading} onChange={event => { setRunId(event.target.value); if (compare === event.target.value) setCompare(''); }}><option value="" disabled>选择一次运行</option>{run && !runPage.items.some(row => row.id === run.id) && <option value={run.id}>已选快照 · {dateTime(run.createdAt)}（另一页）</option>}{runPage.items.map((row, index) => <option key={row.id} value={row.id}>第 {runPage.total - runPage.offset - index} 次 · {row.status === 'queued' ? '等待运行' : statusText[row.status]} · {dateTime(row.createdAt)}</option>)}</select></label>{run && <button className="button" disabled={restoring || frozen || deleting} onClick={async () => { setRestoring(true); try { await onRestore(run); } catch (error) { onError(errorText(error)); } finally { setRestoring(false); } }}>{restoring ? '正在恢复…' : '恢复为独立草稿'}</button>}</div>
        <ArchivePager page={runPage} loading={runPageLoading || deleting || restoring} label="运行记录" onOffset={setRunOffset} />
        {run && <details className="archive-learning"><summary>比较代码差异</summary><label className="p3-field">对比基准<select aria-label="对比基准" value={compare} disabled={runPageLoading} onChange={event => setCompare(event.target.value)}><option value="">选择另一次运行</option>{comparedRun && comparedRun.id !== run.id && !runPage.items.some(row => row.id === comparedRun.id) && <option value={comparedRun.id}>已选基准 · {dateTime(comparedRun.createdAt)}（另一页）</option>}{runPage.items.filter(row => row.id !== run.id).map(row => <option key={row.id} value={row.id}>运行 · {dateTime(row.createdAt)}</option>)}{detail.attempt.finalCode !== null && <option value="final">归档最终代码</option>}</select></label>{compareLoading && <p className="field-help" role="status">正在读取对比快照…</p>}{(comparedRun || compare === 'final') && <CodeComparison before={comparedRun?.code ?? detail.attempt.finalCode ?? ''} after={run.code} language={run.language} label="档案代码差异" />}</details>}
        {run ? <><div className="result-summary"><strong className={statusClass(run.result.status)}>{statusText[run.result.status]}</strong><span>{Math.round(run.result.durationMs)} ms</span></div><pre className="archive-code">{run.code}</pre><div className="archive-case-list">{run.result.caseResults.map(test => <div className="case-row" key={test.index}><span>用例 {test.index + 1}</span><span className={statusClass(test.status)}>{statusText[test.status]}</span><code>{formatValue(test.actual)}</code></div>)}</div>{run.result.diagnostics.map((diagnostic, index) => <pre className="diagnostic" key={index}>{diagnostic.message}</pre>)}<details><summary>执行环境与版本</summary><dl className="system-details"><dt>题面版本</dt><dd>{run.problemVersion}</dd><dt>运行时</dt><dd>{run.result.runtimeVersion}</dd><dt>平台</dt><dd>{run.result.hostPlatform}</dd></dl></details></> : <p className="field-help" role="status">{runLoading || runPageLoading ? '正在读取运行记录…' : runPage.total ? '选择一次运行，查看代码与测试结果。' : '这次练习尚无已完成的运行记录。'}</p>}
        {!detail.attempt.isActive && !detail.interviewId && <div className="archive-learning"><button className="text-button danger-text" disabled={frozen || deleting || restoring} onClick={() => setDeleteOpen(true)}>删除本次练习档案</button>{deleteOpen && <div role="alertdialog" aria-label="确认删除练习档案" className="review-rating"><h3>删除本次练习档案？</h3><p>本次运行快照、AI 对话和活动统计将被删除。独立笔记、已经记录的复习评分、普通草稿及恢复出的草稿保留，并解除对本次档案的来源关联。其他档案中已固定的引用内容与外部备份需分别管理。</p><div className="compact-actions"><button className="button" disabled={frozen || deleting} onClick={() => { if (!api) return; setDeleting(true); void api.deleteArchive(detail.attempt.id).then(() => { selectArchive(''); setOverview(null); setRefresh(value => value + 1); }).catch(error => onError(errorText(error))).finally(() => setDeleting(false)); }}>确认删除档案</button><button className="text-button" disabled={deleting} onClick={() => setDeleteOpen(false)}>取消</button></div></div>}</div>}
        <details className="archive-learning" open={aiOpen} onToggle={event => setAiOpen(event.currentTarget.open)}><summary>AI 帮助记录{learningValue ? `（${learningValue.aiRequests.length}）` : ''}</summary>{learningLoading && <p className="field-help" role="status">正在读取 AI 帮助记录…</p>}{learningValue?.aiRequests.map(record => <article className="ai-request" key={record.id}><h4>{record.snapshot.level} · {record.snapshot.question}</h4><p className="field-help">{dateTime(record.createdAt)} · {record.snapshot.provider.model} · {record.status === 'completed' ? '已取得回答' : record.status === 'cancelled' ? '已停止' : record.status === 'interrupted' ? '应用中断' : '未取得可用回答'}</p>{record.response ? <><h4>{record.response.title}</h4><Markdown text={record.response.explanation} />{record.response.nextSteps.length > 0 && <ol>{record.response.nextSteps.map((step, index) => <li key={index}><Markdown text={step} /></li>)}</ol>}{record.response.evidence.length > 0 && <details><summary>本次使用的运行证据</summary>{record.response.evidence.map((evidence, index) => <pre className="diagnostic" key={index}>{evidence.quote}</pre>)}</details>}{record.response.inferences.length > 0 && <details><summary>需要验证的判断</summary>{record.response.inferences.map((inference, index) => <div key={index}><Markdown text={inference.text} /><p className="field-help">依据：{inference.reason}</p></div>)}</details>}{record.response.patch && <details><summary>当时的修改建议</summary>{record.response.patch.edits.map((edit, index) => <div key={index}><p className="field-help">第 {edit.startLine}–{edit.endLine} 行替换为</p><pre className="archive-code">{edit.replacement}</pre></div>)}</details>}{record.response.completeSolution && <details><summary>已解锁的完整解法</summary><Markdown text={record.response.completeSolution.explanation} /><pre className="archive-code">{record.response.completeSolution.code}</pre></details>}{record.response.noteDraft && <details><summary>当时的笔记提案：{record.response.noteDraft.title}</summary><Markdown text={record.response.noteDraft.markdown} /><p className="field-help">{record.response.noteDraft.tags.join(' / ')}</p></details>}<p className="field-help">{record.usage?.totalTokens === null || !record.usage ? '用量未知' : `供应商报告 ${record.usage.totalTokens} Token`}{record.cachedFromRequestId ? ' · 复用已完成回答' : ''}</p><details><summary>本次请求所用的代码</summary><pre className="archive-code">{record.snapshot.code}</pre></details></> : <p>{record.error?.message}</p>}</article>)}</details>
        <details className="archive-learning" open={notesOpen} onToggle={event => setNotesOpen(event.currentTarget.open)}><summary>结束练习时的已确认笔记{learningValue ? `（${learningValue.noteVersions.length}）` : ''}</summary>{learningLoading && <p className="field-help" role="status">正在读取已确认笔记…</p>}{learningValue?.noteVersions.map(note => <article key={`${note.noteId}:${note.version}`}><h4>{note.title} · v{note.version}</h4><Markdown text={note.markdown} onAttachment={hash => { void api?.exportAttachment(hash).catch(error => onError(errorText(error))); }} /></article>)}</details>
      </> : <div className="empty-state"><h3>{detailLoading ? '正在读取所选档案…' : '选择一次练习，查看当时的过程'}</h3><p>不同练习相互独立，同一次练习包含多次运行。</p></div>}</section>
    </div>
  </section>;
}
