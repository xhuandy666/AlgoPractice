import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DesktopBridge, LibraryIndex } from '../shared/bridge';
import type { LearningDashboard, LearningDay, ProblemListItem, ReviewEvent, ReviewItem, ReviewRating, TodayQueue } from '../shared/learning';
import { errorText, Icon } from './ui';
import { ratings, reviewLabel } from './ReviewRating';
import { useEditsFrozen } from './pending-saves';
import { addDays, dateKey, learningStreak, monthGrid, reviewPlan, shiftMonth } from './learning-calendar';

const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const emptyDay = (date: string): LearningDay => ({ date, activeMs: 0, completedAttempts: 0, completedProblems: 0, reviewCount: 0 });
const minutes = (ms: number) => Math.floor(ms / 60000);
function duration(ms: number) { const n = minutes(ms); return n >= 60 ? `${Math.floor(n / 60)} 小时 ${n % 60} 分` : `${n} 分钟`; }
const effectiveTime = (item: ReviewItem) => Math.max(Date.parse(item.dueAt), item.scheduledAt ? Date.parse(item.scheduledAt) : 0);
function monthName(month: string) { return `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`; }

function ActivityHeatmap({ dashboard, onArchives }: { dashboard: LearningDashboard; onArchives: (date?: string) => void }) {
  const [range, setRange] = useState<26 | 52>(26);
  const days = useMemo(() => new Map(dashboard.days.map(day => [day.date, day])), [dashboard.days]);
  const cells = useMemo(() => {
    const endWeek = (new Date(`${dashboard.date}T12:00:00Z`).getUTCDay() + 6) % 7;
    const start = addDays(dashboard.date, -endWeek - (range - 1) * 7);
    return Array.from({ length: range * 7 }, (_, index) => days.get(addDays(start, index)) ?? emptyDay(addDays(start, index)));
  }, [days, dashboard.date, range]);
  const months = cells.filter((_, index) => index % 7 === 0).map((day, index, weeks) => index === 0 || day.date.slice(0, 7) !== weeks[index - 1].date.slice(0, 7) ? `${Number(day.date.slice(5, 7))}月` : '');
  return <section className="activity-history" aria-label="学习轨迹">
    <div className="section-heading"><div><h3>学习轨迹</h3><p>每天完成的题数，记录持续的进步</p></div><div className="segmented-control" aria-label="学习轨迹时间范围"><button aria-pressed={range === 26} onClick={() => setRange(26)}>半年</button><button aria-pressed={range === 52} onClick={() => setRange(52)}>一年</button></div></div>
    <div className="activity-history-body"><div className="heatmap-main"><div className="heatmap-scroll"><div className={`heatmap-chart heatmap-${range}`} style={{ '--heat-columns': range } as CSSProperties}>
      <div className="heatmap-months">{months.map((month, index) => <span key={index}>{month}</span>)}</div>
      <div className="heatmap-weekdays" aria-hidden="true">{weekdays.map((day, index) => <span key={day}>{index % 2 === 0 ? day : ''}</span>)}</div>
      <div className="heatmap-grid" aria-label="每日练习热力图">{cells.map(day => {
        const future = day.date > dashboard.date;
        const level = day.completedProblems === 0 ? 0 : day.completedProblems === 1 ? 1 : day.completedProblems <= 3 ? 2 : day.completedProblems <= 5 ? 3 : 4;
        const label = `${day.date}：完成 ${day.completedProblems} 题，学习 ${duration(day.activeMs)}`;
        return <button key={day.date} className="heatmap-cell" data-level={level} data-today={day.date === dashboard.date} disabled={future} aria-label={label} title={label} onClick={() => onArchives(day.date)} />;
      })}</div>
    </div></div><div className="heatmap-legend" aria-label="颜色越深，完成题数越多"><span>少</span>{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} />)}<span>多</span></div></div>
    <div className="heatmap-summary"><div><strong>{dashboard.totals.activeDays}</strong><span>个学习日 <small>· 近一年</small></span></div><button className="text-button" onClick={() => onArchives()}>查看练习档案 <span aria-hidden="true">↗</span></button></div></div>
  </section>;
}

export function TodayPage({ api, library, onReview, onSettings, onArchives, onBrowse, onError }: {
  api: DesktopBridge | undefined; library: LibraryIndex;
  onReview: (item: ReviewItem) => void; onSettings: () => void; onArchives: (date?: string) => void;
  onBrowse: () => void; onError: (message: string) => void;
}) {
  const [dashboard, setDashboard] = useState<LearningDashboard | null>(null);
  const [queue, setQueue] = useState<TodayQueue | null>(null);
  const [viewMonth, setViewMonth] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [scope, setScope] = useState<'day' | 'due' | 'all' | 'paused'>('day');
  const [tab, setTab] = useState<'pending' | 'done'>('pending');
  const [busy, setBusy] = useState(''); const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(''); const [page, setPage] = useState(0);
  const [goalOpen, setGoalOpen] = useState(false); const [goal, setGoal] = useState('3');
  const [recordItem, setRecordItem] = useState(''); const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [correcting, setCorrecting] = useState<ReviewEvent | null>(null); const [correction, setCorrection] = useState<ReviewRating>(3);
  const working = useRef(false); const requestId = useRef<string | null>(null); const generation = useRef(0);
  const frozen = useEditsFrozen();
  const load = useCallback(async () => {
    if (!api) { setLoading(false); return; }
    const current = ++generation.current;
    const [result, todayQueue] = await Promise.all([api.learningDashboard(viewMonth ?? undefined), api.todayQueue()]);
    if (current === generation.current) { setDashboard(result); setQueue(todayQueue); setLoading(false); }
  }, [api, viewMonth]);
  useEffect(() => {
    setLoading(true); void load().catch(error => { setLoading(false); onError(errorText(error)); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = api?.onLibraryChanged(() => { if (!timer) timer = setTimeout(() => { timer = undefined; void load().catch(error => onError(errorText(error))); }, 250); });
    const refresh = setInterval(() => { if (document.visibilityState === 'visible') void load().catch(error => onError(errorText(error))); }, 60000);
    return () => { generation.current++; remove?.(); clearTimeout(timer); clearInterval(refresh); };
  }, [api, load]);
  const today = dashboard?.date ?? dateKey(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  const month = viewMonth ?? today.slice(0, 7); const selected = selectedDate ?? today;
  const timeZone = dashboard?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = dashboard?.days.find(row => row.date === today) ?? emptyDay(today);
  const items = dashboard?.reviewItems ?? [];
  const plans = useMemo(() => reviewPlan(items, today, timeZone), [items, today, timeZone]);
  const doneByDate = useMemo(() => {
    const map = new Map<string, ReviewEvent[]>();
    for (const event of dashboard?.reviewEvents ?? []) { const key = dateKey(event.reviewedAt, timeZone); const list = map.get(key) ?? []; list.push(event); map.set(key, list); }
    return map;
  }, [dashboard?.reviewEvents, timeZone]);
  const due = items.filter(item => !item.suspended && effectiveTime(item) <= Date.now());
  const pending = scope === 'day' ? selected === today ? queue?.items ?? [] : plans.get(selected) ?? [] : scope === 'due' ? due : items.filter(item => scope === 'paused' ? item.suspended : !item.suspended);
  const beyondPlan = Math.max(0, due.length - (queue?.items.length ?? 0));
  const completed = doneByDate.get(selected) ?? [];
  const rows = tab === 'done' && scope === 'day' ? completed.map(event => ({ item: items.find(item => item.id === event.itemId), event })) : pending.map(item => ({ item, event: undefined as ReviewEvent | undefined }));
  const safePage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1)); const visible = rows.slice(safePage * 20, safePage * 20 + 20);
  const [problemRows, setProblemRows] = useState<ProblemListItem[]>([]);
  const wantedIds = [...new Set(visible.flatMap(row => row.item ? [row.item.problemId] : []))].sort().join('\n');
  useEffect(() => { let alive = true; if (api && wantedIds) void api.problemPage({ ids: wantedIds.split('\n'), limit: 100 }).then(value => { if (alive) setProblemRows(value.items); }).catch(error => { if (alive) onError(errorText(error)); }); return () => { alive = false; }; }, [api, wantedIds, library]);
  const problems = new Map([...library.problems, ...problemRows].map(problem => [problem.id, problem]));
  const title = (item: ReviewItem) => problems.get(item.problemId)?.content.title ?? '复习题目';
  useEffect(() => { setEvents([]); setCorrecting(null); requestId.current = null; }, [recordItem]);
  useEffect(() => { let alive = true; if (api && recordItem) void api.reviewEvents(recordItem).then(value => { if (alive) setEvents(value); }).catch(error => onError(errorText(error))); return () => { alive = false; }; }, [api, recordItem, dashboard]);
  const displayTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  function pickDate(date: string) { setSelectedDate(date); setScope('day'); setTab('pending'); setPage(0); setRecordItem(''); }
  function changeMonth(delta: number) { const next = shiftMonth(month, delta); setViewMonth(next); pickDate(next === today.slice(0, 7) ? today : `${next}-01`); }
  async function change(item: ReviewItem, patch: { suspended?: boolean; scheduledAt?: string | null }) {
    if (!api || working.current || frozen) return; working.current = true; setBusy(item.id); setMessage('');
    try { await api.updateReviewItem(item.id, patch); await load(); setMessage('复习安排已更新'); }
    catch (error) { onError(errorText(error)); } finally { working.current = false; setBusy(''); }
  }
  async function saveGoal() {
    if (!api || working.current || frozen) return;
    const value = Number(goal); if (!Number.isInteger(value) || value < 1 || value > 1000) { onError('每日目标请填写 1–1000 之间的整数。'); return; }
    working.current = true; setBusy('goal');
    try { await api.saveLearningSettings({ dailyPracticeGoal: value }); await load(); setGoalOpen(false); setMessage('每日目标已更新'); }
    catch (error) { onError(errorText(error)); } finally { working.current = false; setBusy(''); }
  }
  async function correct() {
    if (!api || !correcting || working.current || frozen) return; working.current = true; setBusy('correction'); requestId.current ??= crypto.randomUUID();
    try { await api.correctReview({ requestId: requestId.current, eventId: correcting.id, rating: correction }); setCorrecting(null); requestId.current = null; await load(); setMessage('评分已更正'); }
    catch (error) { onError(errorText(error)); } finally { working.current = false; setBusy(''); }
  }
  const target = dashboard?.dailyPracticeGoal ?? 3; const progress = Math.min(1, day.completedProblems / target);
  return <section className="learning-center scroll-page" aria-busy={loading}>
    <div className="center-heading"><div><h2>今日进度</h2><p className="center-date">{new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${today}T12:00:00Z`))}</p></div><button className="button browse-practice" onClick={onBrowse}><Icon name="play" />去题库练习</button></div>
    <section className="activity-panel" aria-label="学习进度">
      <div className="daily-focus"><div className="section-heading"><h3>今日目标</h3><button className="text-button" aria-expanded={goalOpen} disabled={!api || !dashboard || !!busy || frozen} onClick={() => { setGoal(String(target)); setGoalOpen(!goalOpen); }}>调整目标</button></div>
        {goalOpen ? <form className="goal-form" onSubmit={event => { event.preventDefault(); void saveGoal(); }}><label>每天完成<input aria-label="每日练习目标" type="number" min="1" max="1000" value={goal} onChange={event => setGoal(event.target.value)} autoFocus />题</label><div className="compact-actions"><button className="button primary" disabled={!!busy}>保存</button><button type="button" className="text-button" onClick={() => setGoalOpen(false)}>取消</button></div></form> : <>
          <div className="goal-count"><strong>{dashboard ? day.completedProblems : '—'}</strong><span>/ {target} 题</span></div>
          <div className="goal-progress-row"><div className="goal-progress" role="progressbar" aria-label="今日练习目标" aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.min(day.completedProblems, target)} aria-valuetext={`今日完成 ${day.completedProblems} 题，目标 ${target} 题`}><span style={{ transform: `scaleX(${progress})` }} /></div><p className={`goal-caption ${progress === 1 ? 'goal-achieved' : ''}`} title="完成题数按已结束的练习去重统计，不代表力扣官方 AC">{progress === 1 ? '目标已达成' : `还差 ${Math.max(0, target - day.completedProblems)} 题`}</p></div>
        </>}
      </div>
      <button className="daily-metric daily-study" onClick={() => onArchives(today)}><span className="daily-metric-label">今日学习</span><span className="daily-metric-value"><strong>{dashboard ? minutes(day.activeMs) : '—'}</strong><span>分钟</span></span><span className="daily-metric-caption">查看今天的学习记录 <span aria-hidden="true">↗</span></span></button>
      <div className="daily-metric" title="有学习活动、结束练习或完成复习的连续日期；今天尚未开始时延续至昨天"><span className="daily-metric-label">连续学习</span><span className="daily-metric-value"><strong>{dashboard ? learningStreak(dashboard.days, today) : '—'}</strong><span>天</span></span><span className="daily-metric-caption">每一点积累，都有迹可循</span></div>
    </section>
    {message && <p role="status" className="center-message">{message}</p>}
    <div className="review-planner">
      <section className="review-todos" aria-label="复习任务"><div className="section-heading"><div><h3>{scope === 'day' ? selected === today ? '今天的复习' : `${Number(selected.slice(5, 7))} 月 ${Number(selected.slice(-2))} 日` : scope === 'paused' ? '已暂停' : scope === 'due' ? '全部到期' : '全部复习'}</h3><p>{scope === 'day' ? `${pending.length} 项待复习 · ${completed.length} 项已完成` : `${pending.length} 个复习任务`}</p></div><select aria-label="复习列表范围" value={scope} onChange={event => { setScope(event.target.value as typeof scope); setTab('pending'); setPage(0); }}><option value="day">当天</option><option value="due">全部到期</option><option value="all">全部计划</option><option value="paused">已暂停</option></select></div>
        {scope === 'day' && <div className="todo-tabs"><button aria-pressed={tab === 'pending'} onClick={() => { setTab('pending'); setPage(0); }}>待复习 <span>{pending.length}</span></button><button aria-pressed={tab === 'done'} onClick={() => { setTab('done'); setPage(0); }}>已完成 <span>{completed.length}</span></button></div>}
        {scope === 'day' && selected === today && queue && <div className="todo-budget">{queue.budget !== null && <span>每日计划 {queue.budget} 项 · 已复习 {queue.reviewedToday} 项</span>}{beyondPlan > 0 && <button className="text-button" onClick={() => { setScope('due'); setTab('pending'); setPage(0); }}>另有 {beyondPlan} 项到期，查看全部 →</button>}</div>}
        <ul className="todo-list">{visible.map(({ item, event }) => item && <li className={`todo-row ${event ? 'is-complete' : ''}`} key={event?.id ?? item.id}>
          <div className="todo-content"><button className="todo-title" disabled={Boolean(busy) || frozen || item.suspended} onClick={() => event ? setRecordItem(item.id) : onReview(item)}>{title(item)}</button><div className="todo-meta"><span className={`review-kind kind-${item.language}`}>{reviewLabel(item)}</span>{event ? <span>{ratings.find(rating => rating.value === event.rating)?.title}</span> : item.suspended ? <span>已暂停</span> : dateKey(new Date(effectiveTime(item)).toISOString(), timeZone) < today ? <span className="overdue-label">逾期</span> : <span>{displayTime(new Date(effectiveTime(item)).toISOString())}</span>}</div>
          </div><button className={`button ${event ? '' : 'primary'} todo-start`} aria-label={event ? `${title(item)}，已完成，查看评分` : `开始复习：${title(item)}`} disabled={Boolean(busy) || frozen || item.suspended} onClick={() => event ? setRecordItem(item.id) : onReview(item)}>{event ? '查看评分' : '开始复习'}<span aria-hidden="true">→</span></button>
          {!event && <details className="todo-more"><summary>安排</summary><div className="compact-actions"><button className="text-button" disabled={!!busy || frozen} onClick={() => { void change(item, { scheduledAt: new Date(Math.max(Date.now(), effectiveTime(item)) + 86400000).toISOString() }); }}>推迟一天</button>{item.scheduledAt && <button className="text-button" disabled={!!busy || frozen} onClick={() => { void change(item, { scheduledAt: null }); }}>取消推迟</button>}<button className="text-button" disabled={!!busy || frozen} onClick={() => { void change(item, { suspended: !item.suspended }); }}>{item.suspended ? '恢复复习' : '暂停复习'}</button><button className="text-button" onClick={() => setRecordItem(item.id)}>评分记录</button></div></details>}
          </li>)}</ul>
        {rows.length > 0 && tab === 'pending' && <p className="todo-note">完成后记录掌握程度，安排下一次复习。</p>}
        {!rows.length && <div className="todo-empty"><span className="todo-empty-symbol" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{tab === 'done' ? <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></> : <path d="m6 12 4 4 8-9" />}</svg></span><h4>{loading ? '正在读取复习…' : tab === 'done' ? '这一天还没有完成记录' : scope === 'paused' ? '没有暂停的复习' : scope === 'due' ? '暂无到期的复习' : scope === 'all' ? '还没有复习计划' : selected === today ? queue?.remainingBudget === 0 && queue.reviewedToday > 0 ? '今日计划已完成' : '今天暂无复习安排' : '这一天没有复习安排'}</h4><p>{tab === 'done' ? '完成复习并评分后，就会记在这里。' : '可以练一道新题，也可以回看学习记录。'}</p>{tab === 'pending' && <button className="text-button" onClick={onBrowse}>去题库看看 →</button>}</div>}
        {rows.length > 20 && <div className="pagination"><span>{safePage * 20 + 1}–{Math.min((safePage + 1) * 20, rows.length)} / {rows.length}</span><button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>上一页</button><button disabled={(safePage + 1) * 20 >= rows.length} onClick={() => setPage(safePage + 1)}>下一页</button></div>}
        {recordItem && <section className="review-records" aria-label="复习评分记录"><div className="section-heading"><h4>评分记录</h4><button className="text-button" onClick={() => setRecordItem('')}>收起</button></div>{events.filter(event => event.kind === 'review').map(event => { const effective = events.filter(candidate => candidate.kind === 'correction' && candidate.correctsEventId === event.id).at(-1) ?? event; return <div className="review-record" key={event.id}><span>{displayTime(event.reviewedAt)}<strong>{ratings.find(rating => rating.value === effective.rating)?.title}{effective.id !== event.id ? ' · 已更正' : ''}</strong></span><button className="text-button" disabled={!!busy || frozen} onClick={() => { setCorrecting(event); setCorrection(effective.rating); requestId.current = null; }}>更正</button></div>; })}{!events.length && <p className="field-help">还没有评分记录</p>}
          {correcting && <form className="correction-form" onSubmit={event => { event.preventDefault(); void correct(); }}><label>更正评级<select aria-label="更正评级" value={correction} disabled={!!busy || !!requestId.current} onChange={event => setCorrection(Number(event.target.value) as ReviewRating)}>{ratings.map(rating => <option key={rating.value} value={rating.value}>{rating.title}</option>)}</select></label><div className="compact-actions"><button className="button primary" disabled={!!busy || frozen}>确认更正</button><button type="button" className="text-button" disabled={!!busy} onClick={() => { setCorrecting(null); requestId.current = null; }}>取消</button></div></form>}
        </section>}
      </section>
      <section className="review-calendar" aria-label="复习日历"><div className="section-heading"><div><h3>复习日历</h3></div><button className="text-button" onClick={onSettings}><Icon name="settings" />复习设置</button></div>
        <div className="calendar-toolbar"><h4>{monthName(month)}</h4><div><button aria-label="上个月" disabled={!dashboard} onClick={() => changeMonth(-1)}>‹</button><button className="calendar-today" disabled={!dashboard} onClick={() => { setViewMonth(null); pickDate(today); }}>今天</button><button aria-label="下个月" disabled={!dashboard} onClick={() => changeMonth(1)}>›</button></div></div>
        <div className="calendar-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
        <div className="calendar-grid">{monthGrid(month).map(cell => { const count = plans.get(cell.date)?.length ?? 0; const done = doneByDate.get(cell.date)?.length ?? 0; const label = `${cell.date}，${count} 项待复习，${done} 项已完成`; return <button key={cell.date} className="calendar-day" data-outside={!cell.inMonth} data-today={cell.date === today} aria-pressed={cell.date === selected} aria-current={cell.date === today ? 'date' : undefined} disabled={!cell.inMonth || !dashboard} aria-label={label} title={label} onClick={() => pickDate(cell.date)}><span className="calendar-day-number">{Number(cell.date.slice(-2))}</span>{cell.inMonth && <span className="calendar-marks" aria-hidden="true">{count > 0 && <span className="calendar-pending" />}{done > 0 && <span className="calendar-completed" />}</span>}</button>; })}</div>
        <div className="calendar-legend"><span><i />待复习</span><span><i />已完成</span><button className="text-button" onClick={() => onArchives(selected)}>当天记录 <span aria-hidden="true">↗</span></button></div>
      </section>
    </div>
    {dashboard ? <ActivityHeatmap dashboard={dashboard} onArchives={onArchives} /> : <section className="activity-history dashboard-skeleton" aria-label={api ? '正在读取学习记录' : '暂无学习记录'}><h3>学习轨迹</h3><div /><p>{api ? '正在读取学习记录…' : '从第一道题开始，记录你的进步。'}</p></section>}
    <footer className="center-footer"><span>近一年完成 {dashboard?.totals.completedProblems ?? 0} 道不同题目</span><span>完成记录不等同于力扣官方 AC</span></footer>
  </section>;
}
