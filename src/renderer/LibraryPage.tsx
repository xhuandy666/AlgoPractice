import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DesktopBridge, LibraryIndex, PreparedProblemRefresh } from '../shared/bridge';
import type { PageResult, PracticeState, ProblemListItem, ProblemPageFilter } from '../shared/learning';
import { makeFrozenPracticeSource, makeLibraryPracticeSource, resolvePracticeNavigation, type PracticeNavigationSource } from '../shared/practice-navigation';
import { capability, difficultyLabel, sourceLabel } from '../shared/presentation';
import { dateTime, errorText, Icon, Statement } from './ui';
import { Mascot } from './Mascot';
import { Hot100Card } from './Hot100Card';
import { HelpHint } from './HelpHint';
import { LANGUAGES, languageLabel, type Language } from '../shared/languages';
import { readOnlyCandidates, refreshReadOnlyProblems, type BulkRefreshProgress } from './bulk-refresh';

export function LibraryPage({ api, data, onOpen, onImport, onChanged, onError }: {
  api: DesktopBridge | undefined; data: LibraryIndex; onOpen: (id: string, source?: PracticeNavigationSource, list?: { id: string; title: string }) => void; onImport: (url?: string) => void; onChanged: () => Promise<void>; onError: (error: string) => void;
}) {
  const [query, setQuery] = useState(''); const [listId, setListId] = useState(''); const [chapterId, setChapterId] = useState('');
  const [difficulty, setDifficulty] = useState(''); const [support, setSupport] = useState(''); const [practiceState, setPracticeState] = useState<PracticeState | ''>('');
  const [language, setLanguage] = useState<Language | ''>('');
  const [busy, setBusy] = useState(''); const [refresh, setRefresh] = useState<PreparedProblemRefresh | null>(null);
  const [page, setPage] = useState(0);
  const list = data.lists.find(item => item.id === listId);
  // Read-only LeetCode problems of the selected list that a statement refresh might make runnable (bulk-refresh.ts).
  const [readOnly, setReadOnly] = useState<{ id: string; title: string }[]>([]);
  const [bulk, setBulk] = useState<BulkRefreshProgress | null>(null); const [bulkMessage, setBulkMessage] = useState('');
  const bulkController = useRef<AbortController | null>(null);
  const currentList = useRef(listId); currentList.current = listId;
  useEffect(() => () => bulkController.current?.abort(), []);
  useEffect(() => {
    setReadOnly([]); if (!api || !listId) return;
    const controller = new AbortController();
    void readOnlyCandidates(api, listId, controller.signal).then(found => { if (!controller.signal.aborted) setReadOnly(found); }).catch(() => {});
    return () => controller.abort();
  }, [api, listId, data]);
  async function refreshReadOnly() {
    if (!api || bulkController.current || !readOnly.length) return;
    const controller = new AbortController(); bulkController.current = controller; setBulkMessage(''); setBulk({ done: 0, total: readOnly.length, upgraded: 0, current: readOnly[0].title });
    const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true }); });
    try {
      const outcome = await refreshReadOnlyProblems(api, readOnly, { signal: controller.signal, wait, onProgress: setBulk });
      const summary = `已更新 ${outcome.upgraded} 道为可本地运行，${outcome.unchanged} 道仍仅可阅读`;
      setBulkMessage(outcome.status === 'completed' ? `${summary}。` : outcome.status === 'cancelled' ? `已停止：${summary}。` : `已暂停：${outcome.error ?? '读取失败'}。${summary}，可稍后继续。`);
      if (outcome.upgraded) await onChanged();
    } finally {
      bulkController.current = null; setBulk(null);
      // Upgraded problems are runnable now; recount even if the library refresh did not change this page's data.
      const refreshedList = listId; void readOnlyCandidates(api, refreshedList).then(found => { if (refreshedList === currentList.current) setReadOnly(found); }).catch(() => {});
    }
  }
  const [result, setResult] = useState<PageResult<ProblemListItem>>({ items: [], total: 0, offset: 0, limit: 30, hasMore: false });
  const [resultSource, setResultSource] = useState<PracticeNavigationSource | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { let alive = true; setLoading(true); const timer = setTimeout(() => {
    const filter: ProblemPageFilter = { search: query, listId: listId || undefined, chapterId: chapterId || undefined, difficulty: difficulty || undefined, language: language || undefined, support: support as 'runnable' | 'reading' || undefined, practice: practiceState || undefined, offset: page * 30, limit: 30 };
    const label = `${list?.title ?? '全部题库'}${query || chapterId || difficulty || support || language || practiceState ? ' · 当前筛选' : ''}`;
    const request = api ? api.problemPage(filter) : Promise.resolve({ items: data.problems.filter(p => !query || p.content.title.includes(query)), total: data.totalProblems, offset: 0, limit: 30, hasMore: false });
    void request.then(value => { if (alive) { setResult(value); setResultSource(api ? makeLibraryPracticeSource(filter, label) : makeFrozenPracticeSource(value.items.map(item => item.id), '预览题库')); if (page > 0 && !value.items.length) setPage(Math.max(0, Math.ceil(value.total / 30) - 1)); } }).catch(error => { if (alive) onError(errorText(error)); }).finally(() => { if (alive) setLoading(false); });
  }, query ? 150 : 0); return () => { alive = false; clearTimeout(timer); }; }, [api, data, query, listId, chapterId, difficulty, support, language, practiceState, page]);
  const totalPages = Math.max(1, Math.ceil(result.total / 30)); const safePage = page;
  // Opening a problem starts its practice, which changes its practice state. With a state filter the order is fixed
  // before opening, so the opened problem cannot drop out of its own navigation sequence.
  const open = (id: string) => {
    // The selected study list is what the learner is working through, whatever else narrows the view right now.
    const from = list ? { id: list.id, title: list.title } : undefined;
    if (!practiceState || !resultSource || resultSource.kind !== 'library' || !api) { onOpen(id, resultSource ?? makeFrozenPracticeSource([id], '当前题目'), from); return; }
    void resolvePracticeNavigation(resultSource, api).then(ids => onOpen(id, makeFrozenPracticeSource(ids.includes(id) ? ids : [id, ...ids], resultSource.label), from))
      .catch(() => onOpen(id, makeFrozenPracticeSource(result.items.map(item => item.id), resultSource.label), from));
  };
  const filtered = Boolean(query || listId || chapterId || difficulty || support || practiceState || language);
  // Clears every list control at once: a filter left behind keeps the list empty after "查看全部题目".
  const showAll = () => { setQuery(''); setListId(''); setChapterId(''); setDifficulty(''); setSupport(''); setPracticeState(''); setLanguage(''); setPage(0); };
  const operation = async (key: string, action: () => Promise<void>) => { setBusy(key); try { await action(); } catch (error) { onError(errorText(error)); } finally { setBusy(''); } };
  return <section className="library-page scroll-page">
    <div className="page-banner" data-tone="blue"><span className="page-banner-icon" aria-hidden="true"><Icon name="library" size={30} /></span><div><h2>我的题库</h2><p>本机共 {data.totalProblems} 道题 · {data.lists.length} 个题单，挑一题开练吧</p></div><button className="button primary" onClick={() => onImport()}>导入题单</button></div>
    <Hot100Card api={api} lists={data.lists} jobs={data.jobs} progress={data.progress} onChanged={onChanged} onView={id => { setListId(id); setChapterId(''); setQuery(''); setDifficulty(''); setSupport(''); setPracticeState(''); setPage(0); }} />
    <div className="library-filters">
      <label className="search-field"><span className="sr-only">搜索题目</span><Icon name="search" /><input type="search" placeholder="题名、编号或标签" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      <label className="filter-pill" data-active={Boolean(listId)}><span className="sr-only">题库范围</span><select value={listId} onChange={event => { setListId(event.target.value); setChapterId(''); setPage(0); }}><option value="">全部题目 · {data.totalProblems}</option>{data.lists.map(item => <option key={item.id} value={item.id}>{item.title} · {data.progress?.[item.id] ? `已解出 ${data.progress[item.id].solved}/${item.items.length}` : item.items.length}</option>)}</select></label>
      <label className="filter-pill" data-active={Boolean(difficulty)}><span className="sr-only">难度</span><select value={difficulty} onChange={event => { setDifficulty(event.target.value); setPage(0); }}><option value="">全部难度</option>{['基础', '简单', '中等', '困难'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="filter-pill" data-active={Boolean(support)}><span className="sr-only">内容状态</span><select value={support} onChange={event => { setSupport(event.target.value); setPage(0); }}><option value="">全部状态</option><option value="runnable">本地可运行</option><option value="reading">尚未准备运行</option></select></label>
      <label className="filter-pill" data-active={Boolean(practiceState)}><span className="sr-only">练习进度</span><select value={practiceState} onChange={event => { setPracticeState(event.target.value as PracticeState | ''); setPage(0); }}><option value="">全部进度</option><option value="unpracticed">未练过</option><option value="practiced">练过</option><option value="solved">已解出</option><option value="review-due">今日待复习</option></select></label>
      <label className="filter-pill" data-active={Boolean(language)}><span className="sr-only">语言模板</span><select aria-label="题库语言" value={language} onChange={event => { setLanguage(event.target.value as Language | ''); setPage(0); }}><option value="">全部语言</option>{LANGUAGES.map(id => <option key={id} value={id}>{languageLabel(id)}</option>)}</select></label>
      {filtered && <button type="button" className="text-button clear-filters" onClick={showAll}>清除筛选</button>}
      <span className="table-caption">{result.total} 道题目{loading ? ' · 正在读取…' : ''}</span>
    </div>
    {list && <div className="list-context"><div><div className="heading-with-help"><h3>{list.title}</h3><HelpHint label="题单管理说明">移出题单仅解除当前题单关联，题目、草稿和练习档案仍保留在本机。</HelpHint></div><p>{list.chapters.length} 个章节 · {list.items.length} 个条目 · 更新于 {dateTime(list.updatedAt)}</p></div><label className="filter-pill" data-active={Boolean(chapterId)}><span className="sr-only">章节</span><select aria-label="章节" value={chapterId} onChange={event => { setChapterId(event.target.value); setPage(0); }}><option value="">全部章节</option>{list.chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select></label>{list.sourceUrl && <button className="text-button" onClick={() => onImport(list.sourceUrl)}>预览题单更新</button>}{bulk ? <span className="bulk-refresh-status" role="status">正在检查 {bulk.done + 1} / {bulk.total}：{bulk.current} · 已可运行 {bulk.upgraded} 道<button type="button" className="text-button" onClick={() => bulkController.current?.abort()}>停止</button></span> : readOnly.length > 0 && <span className="bulk-refresh"><button type="button" className="text-button" onClick={() => { void refreshReadOnly(); }}>刷新只读题（{readOnly.length}）</button><HelpHint label="刷新只读题说明">逐题从力扣重新读取题面，每题间隔约 1 秒；只有刷新后能本地运行的题才会保存为新版本。进行中和历史的练习不受影响。需要联网；遇到登录或限流时会暂停，可稍后继续。</HelpHint></span>}{bulkMessage && <p className="bulk-refresh-message" role="status">{bulkMessage}</p>}</div>}
    <div className="problem-table" role="table" aria-label="题库" aria-busy={loading}>
      <div className="problem-table-head" role="row"><span role="columnheader">题目</span><span role="columnheader">难度</span><span role="columnheader">内容</span><span role="columnheader">操作</span></div>
      {result.items.map((problem, index) => {
        const item = problem.listItem;
        const content = problem.content; const available = problem.capability;
        const hasCppTemplate = problem.capabilities.cppTemplate ?? problem.capabilities.cpp;
        const missingNewTemplates = !problem.capabilities.go || !hasCppTemplate;
        const difficultyId = content.difficulty.toLowerCase();
        return <div className="problem-table-row" role="row" key={item?.key ?? problem.id} data-difficulty={difficultyId} data-runnable={available.canRun} style={{ '--card-index': index } as CSSProperties}>
          <div role="cell" className="problem-name"><span className="row-index" aria-hidden="true">{safePage * 30 + index + 1}</span><div><button className="title-button" onClick={() => open(problem.id)}>{content.title}</button>{problem.practice?.solved ? <span className="practice-chip" data-state="solved">已解出</span> : problem.practice?.practiced ? <span className="practice-chip" data-state="practiced">练过</span> : null}{problem.practice?.reviewDue && <span className="practice-chip" data-state="due">待复习</span>}<p>{content.tags.slice(0, 3).join(' · ') || sourceLabel(content.source)}{content.source === 'local' && content.tags.length > 0 ? ' · 自建样例' : ''}</p></div></div>
          <span role="cell" className="difficulty-text" data-difficulty={difficultyId}>{difficultyLabel(content.difficulty)}</span>
          <span role="cell" className={available.canRun ? 'availability success-text' : 'availability muted'}><span className="availability-label">{available.canRun && <Icon name="check" size={14} strokeWidth={3} />}{available.label}</span><small>{LANGUAGES.filter(id => id === 'cpp' ? hasCppTemplate : problem.capabilities[id]).map(languageLabel).join(' / ') || '暂无语言模板'}</small>{content.media?.complete === false && <small>图示未完整缓存</small>}</span>
          <div role="cell" className="row-actions"><button className={available.canRun ? 'button primary row-start' : 'button row-start'} onClick={() => open(problem.id)}>{available.canRun ? '练习' : '读题'}</button>{(content.sourceUrl || (content.source === 'local' && missingNewTemplates)) && <button className="text-button" disabled={!api || !!busy} title={content.sourceUrl ? '主动读取线上题面和语言模板，确认后保存新版本；不覆盖旧练习或个人代码。' : '从随应用提供的本地演示补全模板，不联网。'} onClick={() => operation(problem.id, async () => setRefresh(await api!.previewProblemRefresh(problem.id)))}>{busy === problem.id ? '正在读取…' : missingNewTemplates ? '补全语言模板' : '刷新题面'}</button>}{list && item && <button className="text-button" disabled={!api || !!busy} onClick={() => operation(item.key, async () => { await api!.detachListItem(list.id, item.key, list.revision); await onChanged(); })}>移出题单</button>}</div>
        </div>;
      })}
    </div>
    {!loading && !result.total && <div className="empty-state"><Mascot mood={data.totalProblems ? 'think' : 'sleep'} size={96} /><h3>{data.totalProblems ? '没有符合条件的题目' : '题库暂无题目'}</h3><p>{data.totalProblems ? '尝试调整题单范围或搜索条件。' : '导入官方计划、收藏题单，或本地 CSV / JSON 文件。'}</p><button className="button" onClick={showAll}>查看全部题目</button></div>}
    <div className="pagination"><span>第 {safePage + 1} / {totalPages} 页</span><button className="button" disabled={loading || safePage === 0} onClick={() => setPage(safePage - 1)}>上一页</button><button className="button" disabled={loading || !result.hasMore} onClick={() => setPage(safePage + 1)}>下一页</button></div>
    {refresh && <div className="inline-review" aria-label="题面更新预览"><div className="section-heading"><div><h2>题面更新预览</h2><p>{refresh.before.content.title} · {refresh.changed ? '来源内容与本机版本有变化' : '来源内容与本机版本一致'}</p></div><button onClick={() => setRefresh(null)}>关闭预览</button></div><div className="revision-comparison"><section><h3>本机版本</h3><p className="field-help">{refresh.before.content.cases.length} 个用例</p><Statement content={refresh.before.content} /></section><section><h3>来源版本</h3><p className="field-help">{refresh.after.cases.length} 个用例 · {capability(refresh.after).label}</p><Statement content={refresh.after} /></section></div><details><summary>比较模板和用例</summary><div className="revision-comparison"><pre>{JSON.stringify({ starter: refresh.before.content.starter, adapter: refresh.before.content.adapter, cases: refresh.before.content.cases }, null, 2)}</pre><pre>{JSON.stringify({ starter: refresh.after.starter, adapter: refresh.after.adapter, cases: refresh.after.cases }, null, 2)}</pre></div></details><div className="button-row"><button className="button primary" disabled={!api || !!busy || !refresh.changed} onClick={() => operation('apply', async () => { await api!.applyProblemRefresh(refresh.id); setRefresh(null); await onChanged(); })}>保存为新版本</button><HelpHint label="题面更新说明">个人代码不变，进行中的练习仍使用开始时的题面。</HelpHint></div></div>}
  </section>;
}
