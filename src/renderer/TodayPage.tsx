import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge, LibraryIndex } from '../shared/bridge';
import type { ArchiveStatistics, ProblemListItem, ReviewEvent, ReviewItem, ReviewRating, TodayQueue } from '../shared/learning';
import type { ReminderStatus } from '../shared/maintenance';
import { errorText } from './ui';
import { ratings, reviewLabel } from './ReviewRating';
import { useEditsFrozen } from './pending-saves';

const reminderLabels: Record<ReminderStatus['phase'], string> = { stopped: '提醒暂未启动', disabled: '提醒已关闭', idle: '暂时没有待提醒的复习', scheduled: '等待今日提醒时间', quiet: '当前在安静时段', overdue: '有逾期复习，已在这里补显示', snoozed: '已安排稍后提醒', delivered: '今日提醒已发送', failed: '系统提醒未能发送' };
export function TodayPage({ api, library, onOpen, onReview, onSettings, onError }: { api: DesktopBridge | undefined; library: LibraryIndex; onOpen: (id: string) => void; onReview: (item: ReviewItem) => void; onSettings: () => void; onError: (message: string) => void }) {
  const [queue, setQueue] = useState<TodayQueue | null>(null); const [items, setItems] = useState<ReviewItem[]>([]);
  const [statistics, setStatistics] = useState<ArchiveStatistics | null>(null); const [reminder, setReminder] = useState<ReminderStatus | null>(null);
  const [filter, setFilter] = useState<'today' | 'due' | 'all' | 'paused'>('today'); const [busy, setBusy] = useState('');
  const [selected, setSelected] = useState(''); const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [correcting, setCorrecting] = useState<ReviewEvent | null>(null); const [correction, setCorrection] = useState<ReviewRating>(3);
  const [message, setMessage] = useState(''); const working = useRef(false); const correctionRequest = useRef<string | null>(null);
  const frozen = useEditsFrozen(); const generation = useRef(0);
  const load = useCallback(async () => {
    if (!api) return; const current = ++generation.current;
    const [nextQueue, nextItems, nextStatistics, nextReminder] = await Promise.all([api.todayQueue(), api.reviewItems(), api.learningStatistics(), api.reminderState()]);
    if (current !== generation.current) return;
    setQueue(nextQueue); setItems(nextItems); setStatistics(nextStatistics); setReminder(nextReminder);
  }, [api]);
  useEffect(() => { void load().catch(error => onError(errorText(error))); const remove = api?.onLibraryChanged(() => { void load().catch(error => onError(errorText(error))); }); const timer = setInterval(() => { void load().catch(error => onError(errorText(error))); }, 60000); return () => { generation.current++; remove?.(); clearInterval(timer); }; }, [api, load]);
  useEffect(() => { let alive = true; setEvents([]); setCorrecting(null); correctionRequest.current = null; if (api && selected) void api.reviewEvents(selected).then(value => { if (alive) setEvents(value); }).catch(error => onError(errorText(error))); return () => { alive = false; }; }, [api, selected, items]);
  const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: queue?.timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const [problemRows, setProblemRows] = useState<ProblemListItem[]>([]); const [listPage, setListPage] = useState(0);
  const problems = new Map([...library.problems, ...problemRows].map(problem => [problem.id, problem]));
  const title = (item: ReviewItem) => problems.get(item.problemId)?.content.title || item.problemId;
  const visible = filter === 'today' ? queue?.items ?? [] : items.filter(item => filter === 'paused' ? item.suspended : filter === 'due' ? !item.suspended && Date.parse(item.dueAt) <= Date.now() : true);
  const pageCount = Math.max(1, Math.ceil(visible.length / 30)); const safePage = Math.min(listPage, pageCount - 1); const visiblePage = visible.slice(safePage * 30, safePage * 30 + 30);
  const wantedIds = [...new Set([...visiblePage.map(item => item.problemId), ...(queue?.newProblemIds ?? []).slice(0, 3)])].sort().join('\n');
  useEffect(() => { let alive = true; if (api && wantedIds) void api.problemPage({ ids: wantedIds.split('\n'), limit: 100 }).then(value => { if (alive) setProblemRows(value.items); }).catch(error => { if (alive) onError(errorText(error)); }); return () => { alive = false; }; }, [api, wantedIds, library]);
  const suggestions = (queue?.newProblemIds ?? []).map(id => problems.get(id)).filter(problem => problem && problem.capability.canRun);
  async function change(item: ReviewItem, patch: { suspended?: boolean; scheduledAt?: string | null }) {
    if (!api || working.current || frozen) return; working.current = true; setBusy(item.id); setMessage('');
    try { await api.updateReviewItem(item.id, patch); await load(); setMessage('复习安排已更新，原到期日和历史评分保持记录。'); }
    catch (error) { onError(errorText(error)); } finally { working.current = false; setBusy(''); }
  }
  async function correct() {
    if (!api || !correcting || working.current || frozen) return; working.current = true; setBusy('correction');
    correctionRequest.current ??= crypto.randomUUID();
    try { await api.correctReview({ requestId: correctionRequest.current, eventId: correcting.id, rating: correction }); setCorrecting(null); correctionRequest.current = null; await load(); setMessage('评分更正已记录，复习时间已按原复习日期重新计算。'); }
    catch (error) { onError(errorText(error)); } finally { working.current = false; setBusy(''); }
  }
  async function snooze() {
    if (!api || working.current || frozen) return; working.current = true; setBusy('snooze');
    try { setReminder(await api.snoozeReviews()); } catch (error) { onError(errorText(error)); } finally { working.current = false; setBusy(''); }
  }
  return <section className="learning-page scroll-page"><div className="page-intro"><div><h2>今天，从需要回忆的题开始</h2><p>{queue ? `${queue.date} · ${queue.timeZone}` : '读取本机学习计划…'}。到期日、自评和练习证据分别保存。</p></div><button className="button" onClick={onSettings}>学习设置</button></div>
    <dl className="learning-summary"><div><dt>待复习</dt><dd>{queue?.dueCount ?? '—'}<small>项</small></dd></div><div><dt>今日已复习</dt><dd>{queue?.reviewedToday ?? '—'}<small>项</small></dd></div><div><dt>今日剩余预算</dt><dd>{queue ? queue.remainingBudget ?? '不限' : '—'}</dd></div><div><dt>累计有效练习</dt><dd>{statistics ? Math.round(statistics.activeMs / 60000) : '—'}<small>分钟</small></dd></div></dl>
    {message && <p role="status" className="success-text">{message}</p>}
    <div className="learning-layout"><div><div className="section-heading"><div><h3>复习安排</h3><p className="field-help">思路复习和不同语言重写分别计算；未练习的项目不会自动记为重来。</p></div><label className="p3-field"><span className="sr-only">复习列表范围</span><select aria-label="复习列表范围" value={filter} onChange={event => { setFilter(event.target.value as typeof filter); setListPage(0); }}><option value="today">今日安排</option><option value="due">全部到期</option><option value="all">全部复习项</option><option value="paused">已暂停</option></select></label></div>
      <ol className="study-list">{visiblePage.map(item => <li className="study-row" key={item.id}><div><h3>{title(item)}</h3><p>{reviewLabel(item)} · 到期 {date(item.dueAt)}{item.suspended ? ' · 已暂停' : ''}</p>{item.scheduledAt && <p>计划练习 {date(item.scheduledAt)}</p>}<p>累计复习 {item.card.reps} 次</p></div><div className="study-actions"><button className="button" disabled={Boolean(busy) || frozen || item.suspended} onClick={() => onReview(item)}>开始复习</button><details><summary>安排与记录</summary><div><button className="text-button" disabled={Boolean(busy) || frozen} onClick={() => { void change(item, { scheduledAt: new Date(Date.now() + 86400000).toISOString() }); }}>推迟一天</button>{item.scheduledAt && <button className="text-button" disabled={Boolean(busy) || frozen} onClick={() => { void change(item, { scheduledAt: null }); }}>取消推迟</button>}<button className="text-button" disabled={Boolean(busy) || frozen} onClick={() => { void change(item, { suspended: !item.suspended }); }}>{item.suspended ? '恢复安排' : '暂停'}</button><button className="text-button" onClick={() => setSelected(item.id)}>评分记录</button></div></details></div></li>)}</ol>
      {visible.length > 30 && <div className="pagination"><span>第 {safePage + 1} / {pageCount} 页 · {visible.length} 项</span><button disabled={safePage === 0} onClick={() => setListPage(safePage - 1)}>上一页</button><button disabled={safePage + 1 >= pageCount} onClick={() => setListPage(safePage + 1)}>下一页</button></div>}
      {!visible.length && <div className="empty-state"><h3>{!queue ? '正在读取复习队列…' : filter === 'today' && queue.remainingBudget === 0 ? '今日预算已用完' : '这里暂时没有复习项'}</h3><p>{queue?.dueCount ? '到期项目仍保留，可切换到“全部到期”查看。' : '结束一次练习并确认自评后，复习安排会出现在这里。'}</p></div>}
      {selected && <section className="learning-section" aria-label="复习评分记录"><div className="section-heading"><h3>{items.find(item => item.id === selected) ? title(items.find(item => item.id === selected)!) : '复习'} · 评分记录</h3><button className="text-button" onClick={() => setSelected('')}>收起记录</button></div>{events.filter(event => event.kind === 'review').map(event => {
        const effective = events.filter(candidate => candidate.kind === 'correction' && candidate.correctsEventId === event.id).at(-1) ?? event;
        return <div className="study-row" key={event.id}><div><h4>{date(event.reviewedAt)} · {ratings.find(option => option.value === effective.rating)?.title}</h4><p>{effective.id !== event.id ? `已更正；原评级为 ${ratings.find(option => option.value === event.rating)?.title}` : '原始复习记录'}</p><p>{event.algorithmVersion}</p></div><button className="text-button" disabled={Boolean(busy) || frozen} onClick={() => { setCorrecting(event); setCorrection(effective.rating); correctionRequest.current = null; }}>更正评分</button></div>;
      })}{!events.length && <p className="field-help">还没有已确认的评分。</p>}{correcting && <div className="review-rating"><h3>更正 {date(correcting.reviewedAt)} 的评分</h3><p>记录新的更正事件，并按原来的复习时间重算后续安排。</p><label className="p3-field">正确评级<select aria-label="更正评级" value={correction} disabled={Boolean(busy) || Boolean(correctionRequest.current)} onChange={event => setCorrection(Number(event.target.value) as ReviewRating)}>{ratings.map(option => <option key={option.value} value={option.value}>{option.title} · {option.hint}</option>)}</select></label><div className="button-row"><button className="button primary" disabled={Boolean(busy) || frozen} onClick={() => { void correct(); }}>{busy === 'correction' ? '正在重算…' : '确认更正'}</button><button className="text-button" disabled={Boolean(busy)} onClick={() => { setCorrecting(null); correctionRequest.current = null; }}>取消</button></div></div>}</section>}
    </div><aside className="learning-sidebar"><section className="learning-section"><h3>今日提醒</h3><p>{reminder ? reminderLabels[reminder.phase] : '读取提醒状态…'}</p>{reminder && <p>{reminder.settings.at} 聚合提醒 · 安静时段 {reminder.settings.quietStart}–{reminder.settings.quietEnd}</p>}{reminder?.snoozedUntil && <p>稍后提醒：{date(reminder.snoozedUntil)}</p>}{reminder?.lastError && <p role="alert" className="error-text">{reminder.lastError}</p>}<div className="compact-actions"><button className="button" disabled={!reminder?.dueCount || Boolean(busy) || frozen} onClick={() => { void snooze(); }}>稍后提醒</button><button className="text-button" onClick={onSettings}>调整提醒</button></div><p>窗口关闭后应用继续驻留。完全退出后不投递，重启时在这里补显示。</p></section>
      <section className="learning-section"><h3>还可以开始一道新题</h3>{suggestions.slice(0, 3).map(problem => problem && <div className="study-row" key={problem.id}><div><h4>{problem.content.title}</h4><p>{problem.content.tags.slice(0, 2).join(' / ') || '本机题库'}</p></div><button className="text-button" onClick={() => onOpen(problem.id)}>练习</button></div>)}{!suggestions.length && <p>暂时没有未练习且可运行的新题，可在题库继续选择。</p>}</section>
    </aside></div>
  </section>;
}
