import { useEffect, useState } from 'react';
import type { DesktopBridge, LibraryIndex, PreparedProblemRefresh } from '../shared/bridge';
import type { PageResult, ProblemListItem } from '../shared/learning';
import { capability, difficultyLabel, sourceLabel } from '../shared/presentation';
import { dateTime, errorText, Statement } from './ui';

export function LibraryPage({ api, data, onOpen, onImport, onChanged, onError }: {
  api: DesktopBridge | undefined; data: LibraryIndex; onOpen: (id: string) => void; onImport: (url?: string) => void; onChanged: () => Promise<void>; onError: (error: string) => void;
}) {
  const [query, setQuery] = useState(''); const [listId, setListId] = useState(''); const [chapterId, setChapterId] = useState('');
  const [difficulty, setDifficulty] = useState(''); const [support, setSupport] = useState('');
  const [busy, setBusy] = useState(''); const [refresh, setRefresh] = useState<PreparedProblemRefresh | null>(null);
  const [page, setPage] = useState(0);
  const list = data.lists.find(item => item.id === listId);
  const [result, setResult] = useState<PageResult<ProblemListItem>>({ items: [], total: 0, offset: 0, limit: 30, hasMore: false });
  const [loading, setLoading] = useState(true);
  useEffect(() => { let alive = true; setLoading(true); const timer = setTimeout(() => {
    const request = api ? api.problemPage({ search: query, listId: listId || undefined, chapterId: chapterId || undefined, difficulty: difficulty || undefined, support: support as 'runnable' | 'reading' || undefined, offset: page * 30, limit: 30 }) : Promise.resolve({ items: data.problems.filter(p => !query || p.content.title.includes(query)), total: data.totalProblems, offset: 0, limit: 30, hasMore: false });
    void request.then(value => { if (alive) { setResult(value); if (page > 0 && !value.items.length) setPage(Math.max(0, Math.ceil(value.total / 30) - 1)); } }).catch(error => { if (alive) onError(errorText(error)); }).finally(() => { if (alive) setLoading(false); });
  }, query ? 150 : 0); return () => { alive = false; clearTimeout(timer); }; }, [api, data, query, listId, chapterId, difficulty, support, page]);
  const totalPages = Math.max(1, Math.ceil(result.total / 30)); const safePage = page;
  const operation = async (key: string, action: () => Promise<void>) => { setBusy(key); try { await action(); } catch (error) { onError(errorText(error)); } finally { setBusy(''); } };
  return <section className="library-page scroll-page">
    <div className="page-intro"><div><h2>我的题库</h2></div><button className="button primary" onClick={() => onImport()}>导入题单</button></div>
    <div className="library-filters">
      <label className="search-field">搜索题目<input type="search" placeholder="题名、编号或标签" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      <label>题库范围<select value={listId} onChange={event => { setListId(event.target.value); setChapterId(''); setPage(0); }}><option value="">全部题目 · {data.totalProblems}</option>{data.lists.map(item => <option key={item.id} value={item.id}>{item.title} · {item.items.length}</option>)}</select></label>
      <label>难度<select value={difficulty} onChange={event => { setDifficulty(event.target.value); setPage(0); }}><option value="">全部难度</option>{['基础', '简单', '中等', '困难'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>内容状态<select value={support} onChange={event => { setSupport(event.target.value); setPage(0); }}><option value="">全部状态</option><option value="runnable">本地可运行</option><option value="reading">尚未准备运行</option></select></label>
    </div>
    {list && <div className="list-context"><div><h3>{list.title}</h3><p>{list.chapters.length} 个章节 · {list.items.length} 个条目 · 更新于 {dateTime(list.updatedAt)}</p></div><label><span className="sr-only">章节</span><select aria-label="章节" value={chapterId} onChange={event => { setChapterId(event.target.value); setPage(0); }}><option value="">全部章节</option>{list.chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select></label>{list.sourceUrl && <button className="text-button" onClick={() => onImport(list.sourceUrl)}>预览题单更新</button>}</div>}
    <div className="table-caption"><span>{result.total} 道题目{loading ? ' · 正在读取…' : ''}</span></div>
    <div className="problem-table" role="table" aria-label="题库">
      <div className="problem-table-head" role="row"><span role="columnheader">题目</span><span role="columnheader">难度</span><span role="columnheader">内容</span><span role="columnheader">操作</span></div>
      {result.items.map((problem, index) => {
        const item = problem.listItem;
        const content = problem.content; const available = problem.capability;
        return <div className="problem-table-row" role="row" key={item?.key ?? problem.id}>
          <div role="cell" className="problem-name"><span className="row-index">{safePage * 30 + index + 1}</span><div><button className="title-button" onClick={() => onOpen(problem.id)}>{content.title}</button><p>{content.tags.slice(0, 3).join(' · ') || sourceLabel(content.source)}{content.source === 'local' && content.tags.length > 0 ? ' · 自建样例' : ''}</p></div></div>
          <span role="cell" className="difficulty-text">{difficultyLabel(content.difficulty)}</span>
          <span role="cell" className={available.canRun ? 'availability success-text' : 'availability muted'}>{available.label}{content.media?.complete === false && <small>图示未完整缓存</small>}</span>
          <div role="cell" className="row-actions"><button className="text-button" onClick={() => onOpen(problem.id)}>{available.canRun ? '练习' : '读题'}</button>{content.sourceUrl && <button disabled={!api || !!busy} onClick={() => operation(problem.id, async () => setRefresh(await api!.previewProblemRefresh(problem.id)))}>{busy === problem.id ? '正在读取…' : '刷新题面'}</button>}{list && item && <button disabled={!api || !!busy} onClick={() => operation(item.key, async () => { await api!.detachListItem(list.id, item.key, list.revision); await onChanged(); })}>移出题单</button>}</div>
        </div>;
      })}
    </div>
    {!loading && !result.total && <div className="empty-state"><h3>{data.totalProblems ? '没有符合条件的题目' : '题库还是空的'}</h3><p>{data.totalProblems ? '尝试调整题单范围或搜索条件。' : '导入官方计划、收藏题单，或本地 CSV / JSON 文件。'}</p><button className="text-button" onClick={() => { setQuery(''); setDifficulty(''); setSupport(''); setListId(''); setChapterId(''); }}>查看全部题目</button></div>}
    <div className="pagination"><span>第 {safePage + 1} / {totalPages} 页</span><button disabled={loading || safePage === 0} onClick={() => setPage(safePage - 1)}>上一页</button><button disabled={loading || !result.hasMore} onClick={() => setPage(safePage + 1)}>下一页</button></div>
    {list && <p className="field-help">“移出题单”只解除当前题单的成员关系；题目、草稿和练习档案仍保存在本机。</p>}
    {refresh && <div className="inline-review" aria-label="题面更新预览"><div className="section-heading"><div><h2>题面更新预览</h2><p>{refresh.before.content.title} · {refresh.changed ? '来源内容与本机版本有变化' : '来源内容与本机版本一致'}</p></div><button onClick={() => setRefresh(null)}>关闭预览</button></div><div className="revision-comparison"><section><h3>本机版本</h3><p className="field-help">{refresh.before.content.cases.length} 个用例</p><Statement content={refresh.before.content} /></section><section><h3>来源版本</h3><p className="field-help">{refresh.after.cases.length} 个用例 · {capability(refresh.after).label}</p><Statement content={refresh.after} /></section></div><details><summary>比较模板和用例</summary><div className="revision-comparison"><pre>{JSON.stringify({ starter: refresh.before.content.starter, adapter: refresh.before.content.adapter, cases: refresh.before.content.cases }, null, 2)}</pre><pre>{JSON.stringify({ starter: refresh.after.starter, adapter: refresh.after.adapter, cases: refresh.after.cases }, null, 2)}</pre></div></details><div className="button-row"><button className="button primary" disabled={!api || !!busy || !refresh.changed} onClick={() => operation('apply', async () => { await api!.applyProblemRefresh(refresh.id); setRefresh(null); await onChanged(); })}>保存为新版本</button><span className="field-help">个人代码不变；正在进行的练习继续使用开始时的题面。</span></div></div>}
  </section>;
}
