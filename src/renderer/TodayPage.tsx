import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DesktopBridge, LibraryIndex } from '../shared/bridge';
import type { LearningDashboard, LearningDay, ReviewItem } from '../shared/learning';
import { errorText, Icon } from './ui';
import type { ReviewPlanSummary } from '../shared/review-plan';
import { useEditsFrozen } from './pending-saves';
import { addDays, dateKey, learningStreak } from './learning-calendar';
import { HelpHint } from './HelpHint';

const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const emptyDay = (date: string): LearningDay => ({ date, activeMs: 0, completedAttempts: 0, completedProblems: 0, reviewCount: 0 });
const minutes = (ms: number) => Math.floor(ms / 60000);
function duration(ms: number) { const n = minutes(ms); return n >= 60 ? `${Math.floor(n / 60)} 小时 ${n % 60} 分` : `${n} 分钟`; }

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
    <div className="section-heading"><div><h3>学习轨迹</h3><p>每日完成题数</p></div><div className="segmented-control" aria-label="学习轨迹时间范围"><button aria-pressed={range === 26} onClick={() => setRange(26)}>半年</button><button aria-pressed={range === 52} onClick={() => setRange(52)}>一年</button></div></div>
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

export function TodayPage({ api, onReviewPlan, onSettings, onArchives, onBrowse, onError }: {
  api: DesktopBridge | undefined; library: LibraryIndex; onReview?: (item: ReviewItem) => void;
  onReviewPlan?: () => void; onSettings: () => void; onArchives: (date?: string) => void;
  onBrowse: () => void; onError: (message: string) => void;
}) {
  const [dashboard, setDashboard] = useState<LearningDashboard | null>(null);
  const [review, setReview] = useState<ReviewPlanSummary | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(''), [failure, setFailure] = useState('');
  const [goalOpen, setGoalOpen] = useState(false), [goal, setGoal] = useState('3');
  const working = useRef(false), generation = useRef(0); const frozen = useEditsFrozen();
  const load = useCallback(async () => {
    if (!api) { setLoading(false); return; } const current = ++generation.current;
    try {
      const [result, plan] = await Promise.all([api.learningDashboard(), api.reviewPlan({ view: 'today', limit: 1 })]);
      if (current === generation.current) { setDashboard(result); setReview(plan.summary); setFailure(''); setLoading(false); }
    } catch (error) { if (current === generation.current) { setFailure(errorText(error)); setLoading(false); onError(errorText(error)); } }
  }, [api]);
  useEffect(() => {
    setLoading(true); void load(); let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = api?.onLibraryChanged(() => { if (!timer) timer = setTimeout(() => { timer = undefined; void load(); }, 250); });
    const refresh = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60000);
    return () => { generation.current++; remove?.(); clearTimeout(timer); clearInterval(refresh); };
  }, [api, load]);
  const today = dashboard?.date ?? dateKey(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  const day = dashboard?.days.find(row => row.date === today) ?? emptyDay(today);
  const target = dashboard?.dailyPracticeGoal ?? 3, progress = Math.min(1, day.completedProblems / target);
  async function saveGoal() {
    if (!api || working.current || frozen) return;
    const value = Number(goal); if (!Number.isInteger(value) || value < 1 || value > 1000) { setFailure('每日目标请填写 1–1000 之间的整数。'); return; }
    working.current = true; setBusy(true);
    try { await api.saveLearningSettings({ dailyPracticeGoal: value }); await load(); setGoalOpen(false); setMessage('每日目标已更新'); }
    catch (error) { setFailure(errorText(error)); onError(errorText(error)); } finally { working.current = false; setBusy(false); }
  }
  return <section className="learning-center scroll-page" aria-busy={loading}>
    <div className="center-heading"><div><h2>今日进度</h2><p className="center-date">{new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${today}T12:00:00Z`))}</p></div><button className="button browse-practice" onClick={onBrowse}><Icon name="play" />去题库练习</button></div>
    <section className="activity-panel" aria-label="学习进度">
      <div className="daily-focus"><div className="section-heading"><div className="heading-with-help"><h3>今日目标</h3><HelpHint label="完成题数说明">按当天已结束的练习去重计数，不代表力扣官方 AC。</HelpHint></div><button className="text-button" aria-expanded={goalOpen} disabled={!api || !dashboard || busy || frozen} onClick={() => { setGoal(String(target)); setGoalOpen(!goalOpen); }}>调整目标</button></div>
        {goalOpen ? <form className="goal-form" onSubmit={event => { event.preventDefault(); void saveGoal(); }}><label>每天完成<input aria-label="每日练习目标" type="number" min="1" max="1000" value={goal} disabled={busy || frozen} onChange={event => setGoal(event.target.value)} autoFocus />题</label><div className="compact-actions"><button className="button primary" disabled={busy || frozen}>保存</button><button type="button" className="text-button" disabled={busy} onClick={() => setGoalOpen(false)}>取消</button></div></form> : <>
          <div className="goal-count"><strong>{dashboard ? day.completedProblems : '—'}</strong><span>/ {target} 题</span></div>
          <div className="goal-progress-row"><div className="goal-progress" role="progressbar" aria-label="今日练习目标" aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.min(day.completedProblems, target)} aria-valuetext={`今日完成 ${day.completedProblems} 题，目标 ${target} 题`}><span style={{ transform: `scaleX(${progress})` }} /></div><p className={`goal-caption ${progress === 1 ? 'goal-achieved' : ''}`}>{progress === 1 ? '目标已达成' : `还差 ${Math.max(0, target - day.completedProblems)} 题`}</p></div>
        </>}
      </div>
      <button className="daily-metric daily-study" onClick={() => onArchives(today)}><span className="daily-metric-label">今日学习</span><span className="daily-metric-value"><strong>{dashboard ? minutes(day.activeMs) : '—'}</strong><span>分钟</span></span><span className="daily-metric-caption">查看学习记录 <span aria-hidden="true">↗</span></span></button>
      <div className="daily-metric" title="有学习活动、结束练习或完成复习的连续日期；今天尚未开始时延续至昨天"><span className="daily-metric-label">连续学习</span><span className="daily-metric-value"><strong>{dashboard ? learningStreak(dashboard.days, today) : '—'}</strong><span>天</span></span></div>
    </section>
    {message && <p role="status" className="center-message">{message}</p>}
    {failure && <div className="center-load-error" role="alert"><p>学习记录读取失败：{failure}</p><button className="button" onClick={() => { setLoading(true); void load(); }}>重试读取</button></div>}
    <section className="center-review-summary" aria-label="复习计划摘要"><div><p className="center-review-eyebrow">复习计划</p><h3>{review ? review.plannedCount > 0 ? `今天推荐复习 ${review.plannedCount} 题` : '今天暂无推荐复习' : failure ? '复习摘要暂不可用' : '正在读取复习摘要…'}</h3>{review && <p>已复习 {review.reviewedToday} 题 · {review.budget === null ? '不限量' : `每日量 ${review.budget} 题`}{review.extraDueCount > 0 && ` · 另有 ${review.extraDueCount} 题到期`}{review.pendingAssessmentCount > 0 && ` · ${review.pendingAssessmentCount} 题待补自评`}</p>}</div><button className="button" disabled={!api || frozen} onClick={onReviewPlan ?? onSettings}>查看复习计划 <span aria-hidden="true">→</span></button></section>
    {dashboard ? <ActivityHeatmap dashboard={dashboard} onArchives={onArchives} /> : <section className="activity-history dashboard-skeleton" aria-label={api ? '正在读取学习记录' : '暂无学习记录'}><h3>学习轨迹</h3><div /><p>{failure ? '学习记录读取失败，请重试。' : api ? '正在读取学习记录…' : '请在桌面应用中查看学习记录。'}</p></section>}
    <footer className="center-footer"><span>近一年完成 {dashboard?.totals.completedProblems ?? '—'} 道不同题目</span></footer>
  </section>;
}
