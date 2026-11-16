import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { TopicInsightsCard } from './TopicInsights';
import type { Language } from '../shared/languages';
import type { DesktopBridge, LibraryIndex, Page } from '../shared/bridge';
import type { LearningDashboard, LearningDay } from '../shared/learning';
import { errorText, Icon, type IconName } from './ui';
import type { RewardProfile } from './rewards';
import { LevelRing } from './PlayerStats';
import { Mascot } from './Mascot';
import type { ReviewPlanSummary } from '../shared/review-plan';
import { useEditsFrozen } from './pending-saves';
import { addDays, dateKey, isStudyDay, learningStreak } from './learning-calendar';
import { HelpHint } from './HelpHint';

const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const FOCUS_QUEST_MINUTES = 30, XP_QUEST = 100;
const emptyDay = (date: string): LearningDay => ({ date, activeMs: 0, completedProblems: 0, reviewCount: 0 });
const minutes = (ms: number) => Math.floor(ms / 60000);
function duration(ms: number) { const n = minutes(ms); return n >= 60 ? `${Math.floor(n / 60)} 小时 ${n % 60} 分` : `${n} 分钟`; }
const scale = (value: number) => ({ transform: `scaleX(${Math.max(0, Math.min(1, value))})` });

function ActivityHeatmap({ dashboard, onArchives }: { dashboard: LearningDashboard; onArchives: (date?: string) => void }) {
  const [range, setRange] = useState<26 | 52>(26);
  const days = useMemo(() => new Map(dashboard.days.map(day => [day.date, day])), [dashboard.days]);
  const cells = useMemo(() => {
    const endWeek = (new Date(`${dashboard.date}T12:00:00Z`).getUTCDay() + 6) % 7;
    const start = addDays(dashboard.date, -endWeek - (range - 1) * 7);
    return Array.from({ length: range * 7 }, (_, index) => days.get(addDays(start, index)) ?? emptyDay(addDays(start, index)));
  }, [days, dashboard.date, range]);
  const months = cells.filter((_, index) => index % 7 === 0).map((day, index, weeks) => index === 0 || day.date.slice(0, 7) !== weeks[index - 1].date.slice(0, 7) ? `${Number(day.date.slice(5, 7))}月` : '');
  return <section className="activity-history dash-card" aria-label="学习轨迹">
    <div className="dash-card-heading"><span className="dash-tile" data-tone="green" aria-hidden="true"><Icon name="calendar" size={20} /></span><div><h3>学习轨迹</h3><p>每日完成题数，颜色越深完成越多</p></div><div className="segmented-control" aria-label="学习轨迹时间范围"><button aria-pressed={range === 26} onClick={() => setRange(26)}>半年</button><button aria-pressed={range === 52} onClick={() => setRange(52)}>一年</button></div></div>
    <div className="heatmap-scroll"><div className={`heatmap-chart heatmap-${range}`} style={{ '--heat-columns': range } as CSSProperties}>
      <div className="heatmap-months">{months.map((month, index) => <span key={index}>{month}</span>)}</div>
      <div className="heatmap-weekdays" aria-hidden="true">{weekdays.map((day, index) => <span key={day}>{index % 2 === 0 ? day : ''}</span>)}</div>
      <div className="heatmap-grid" aria-label="每日练习热力图">{cells.map(day => {
        const future = day.date > dashboard.date;
        const level = day.completedProblems === 0 ? 0 : day.completedProblems === 1 ? 1 : day.completedProblems <= 3 ? 2 : day.completedProblems <= 5 ? 3 : 4;
        const label = `${day.date}：完成 ${day.completedProblems} 题，学习 ${duration(day.activeMs)}`;
        return <button key={day.date} className="heatmap-cell" data-level={level} data-today={day.date === dashboard.date} disabled={future} aria-label={label} title={label} onClick={() => onArchives(day.date)} />;
      })}</div>
    </div></div>
    <div className="heatmap-summary"><span><strong>{dashboard.totals.activeDays}</strong> 个学习日 · 近一年</span><span className="heatmap-legend" aria-label="颜色越深，完成题数越多">少{[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} />)}多</span><button className="text-button" onClick={() => onArchives()}>查看练习档案 <Icon name="arrow" size={16} /></button></div>
  </section>;
}

function goalLine(done: number, target: number, profile: RewardProfile | null) {
  if (done >= target) return `今日目标已完成：${done} / ${target} 题。`;
  if (done > 0) return `今日已完成 ${done} 题，距目标还差 ${target - done} 题。`;
  if (profile && profile.streak > 0 && !profile.activeToday) return `已连续学习 ${profile.streak} 天，今日完成学习即可延续。`;
  return `今日目标：${target} 题。`;
}

function Quest({ icon, tone, title, value, max, caption, children }: { icon: IconName; tone: string; title: ReactNode; value: number; max: number; caption: string; children?: ReactNode }) {
  const done = value >= max;
  return <li className="quest" data-done={done}>
    <span className="dash-tile" data-tone={tone} aria-hidden="true"><Icon name={icon} size={22} /></span>
    <div className="quest-body"><strong>{title}</strong>{children ?? <div className="quest-bar" aria-hidden="true"><span style={scale(value / max)} /><em>{caption}</em></div>}</div>
    <span className="quest-chest" aria-hidden="true">{done ? <Icon name="check" size={20} strokeWidth={3} /> : <Icon name="trophy" size={20} />}</span>
  </li>;
}

function Starter({ profile, library, onBrowse, onNavigate }: { profile: RewardProfile; library: LibraryIndex; onBrowse: () => void; onNavigate?: (page: Page) => void }) {
  const steps = [
    { done: library.totalProblems > 0, title: '准备题目', detail: '导入 Hot100 或自己的题单', action: '导入题单', go: () => onNavigate?.('sources') },
    { done: profile.totals.runs > 0, title: '运行一次代码', detail: '在练习工作台按 ⌘ / Ctrl + Enter', action: '打开题库', go: onBrowse },
    { done: profile.totals.solvedProblems > 0, title: '解出第一道题', detail: '题目自带的用例全部通过或力扣官方 AC，解锁成就「初露锋芒」', action: '开始练习', go: onBrowse },
  ];
  return <section className="starter-card dash-card" aria-label="新手任务">
    <div className="dash-card-heading"><span className="dash-tile" data-tone="purple" aria-hidden="true"><Icon name="sparkle" size={20} /></span><div><h3>新手任务</h3><p>完成 {steps.filter(step => step.done).length} / {steps.length} · 三步拿到第一枚成就</p></div><button className="text-button" onClick={() => onNavigate?.('environment')}>检查运行环境</button></div>
    <ol className="starter-path">{steps.map((step, index) => <li key={step.title} data-done={step.done}><span className="starter-node" aria-hidden="true">{step.done ? <Icon name="check" size={18} strokeWidth={3} /> : index + 1}</span><div><strong>{step.title}</strong><span>{step.detail}</span></div>{!step.done && <button className="button" onClick={step.go}>{step.action}</button>}</li>)}</ol>
  </section>;
}

function RankCard({ profile }: { profile: RewardProfile }) {
  const into = profile.xp - profile.levelStartXp, span = profile.nextLevelXp - profile.levelStartXp;
  return <section className="rank-card dash-card" data-rank={profile.rank.id} aria-label="等级与段位">
    <div className="rank-top"><LevelRing profile={profile} size={76} /><div><p className="rank-eyebrow">当前段位</p><p className="rank-name">{profile.rank.name}<span>Lv.{profile.level}</span></p></div><Icon name="crown" size={28} /></div>
    <div className="rank-bar" role="progressbar" aria-label="本级经验" aria-valuemin={0} aria-valuemax={span} aria-valuenow={into}><span style={scale(Math.max(0.03, profile.levelProgress))} /><em>{into} / {span} XP</em></div>
    <p className="rank-caption">还差 <strong>{span - into} XP</strong> 升到 Lv.{profile.level + 1}{profile.nextRank && profile.nextRank.minLevel === profile.level + 1 ? `，晋升${profile.nextRank.name}` : ''}</p>
  </section>;
}

function StreakCard({ today, days, streak, profile }: { today: string; days: Map<string, LearningDay>; streak: number | null; profile: RewardProfile | null }) {
  const start = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const week = weekdays.map((label, index) => { const date = addDays(start, index); return { label, date, done: Boolean(days.get(date) && isStudyDay(days.get(date)!)), future: date > today }; });
  const active = profile?.activeToday ?? week.find(item => item.date === today)?.done ?? false;
  return <section className="streak-card dash-card" data-active={active} aria-label="连续学习" title="有学习活动、完成题目或完成复习的连续日期；今天尚未开始时延续至昨天">
    <div className="streak-top"><span className="streak-flame" aria-hidden="true"><Icon name="flame" size={34} strokeWidth={2.2} /></span><div><p className="streak-count"><strong>{streak ?? '—'}</strong> 天</p><p>{active ? '今日已计入连续学习' : '今日完成学习即可延续'}{profile ? ` · 最长 ${profile.bestStreak} 天` : ''}</p></div></div>
    <ol className="streak-week">{week.map(item => <li key={item.date} data-done={item.done} data-today={item.date === today} data-future={item.future}><span>{item.label}</span><i aria-hidden="true">{item.done && <Icon name="check" size={14} strokeWidth={3.2} />}</i><span className="sr-only">{item.done ? '已学习' : item.future ? '未到' : '未学习'}</span></li>)}</ol>
  </section>;
}

function AchievementWall({ profile }: { profile: RewardProfile }) {
  const unlocked = profile.achievements.filter(item => item.unlocked).length;
  return <section className="achievement-wall dash-card" aria-label="成就徽章">
    <div className="achievement-heading"><h3>成就</h3><span>{unlocked} / {profile.achievements.length}</span></div>
    <ul>{profile.achievements.map((item, index) => <li key={item.id} data-unlocked={item.unlocked} data-hue={index % 5} title={`${item.title}：${item.description}${item.unlocked ? '' : `（${item.progress} / ${item.target}）`}`}>
      <span className="achievement-badge" aria-hidden="true"><Icon name={item.icon} size={24} strokeWidth={2.4} /></span>
      <strong>{item.title}</strong>
      {item.unlocked ? <span className="achievement-state">已解锁</span> : <span className="achievement-progress" role="progressbar" aria-label={`${item.title}进度`} aria-valuemin={0} aria-valuemax={item.target} aria-valuenow={item.progress}><i style={scale(item.progress / item.target)} /></span>}
    </li>)}</ul>
  </section>;
}

export function TodayPage({ api, library, profile = null, language, onOpenProblems, onRedoProblems, onReviewPlan, onSettings, onArchives, onBrowse, onNavigate, onError }: {
  api: DesktopBridge | undefined; library: LibraryIndex; profile?: RewardProfile | null;
  language?: Language; onOpenProblems?: (problemIds: string[], label: string) => void;
  /** Reopens problems for a from-scratch rewrite in a separate draft scope; falls back to onOpenProblems. */
  onRedoProblems?: (problemIds: string[], label: string) => void;
  onReviewPlan?: () => void; onSettings: () => void; onArchives: (date?: string) => void;
  onBrowse: () => void; onNavigate?: (page: Page) => void; onError: (message: string) => void;
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
  const dayMap = useMemo(() => new Map((dashboard?.days ?? []).map(row => [row.date, row])), [dashboard?.days]);
  const day = dayMap.get(today) ?? emptyDay(today);
  const target = dashboard?.dailyPracticeGoal ?? 3, progress = Math.min(1, day.completedProblems / target);
  async function saveGoal() {
    if (!api || working.current || frozen) return;
    const value = Number(goal); if (!Number.isInteger(value) || value < 1 || value > 1000) { setFailure('每日目标请填写 1–1000 之间的整数。'); return; }
    working.current = true; setBusy(true);
    try { await api.saveLearningSettings({ dailyPracticeGoal: value }); await load(); setGoalOpen(false); setMessage('每日目标已更新'); }
    catch (error) { setFailure(errorText(error)); onError(errorText(error)); } finally { working.current = false; setBusy(false); }
  }
  const streak = profile?.streak ?? (dashboard ? learningStreak(dashboard.days, today) : null);
  const focus = minutes(day.activeMs);
  return <section className="learning-center scroll-page" aria-busy={loading}>
    <div className="dash-grid">
      <div className="dash-main">
        <section className="dash-hello" aria-label="今日概览">
          <Mascot mood={dashboard && progress === 1 ? 'cheer' : 'happy'} size={112} />
          <div className="speech-bubble">
            <p className="center-greeting">今日概览</p>
            <p className="speech-line">{dashboard ? goalLine(day.completedProblems, target, profile) : '正在读取今日学习记录…'}</p>
            <p className="center-date">{new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${today}T12:00:00Z`))}</p>
          </div>
          <button className="button primary browse-practice" onClick={onBrowse}>开始练习<Icon name="arrow" size={20} /></button>
        </section>
        <section className="quest-board dash-card" aria-label="学习进度">
          <div className="dash-card-heading"><div><p className="dash-eyebrow">每日任务</p><div className="heading-with-help"><h2>今日进度</h2><HelpHint label="完成题数说明">解出即计入（题目自带的用例全部通过，或力扣官方 AC）。本地无法判定对错的题，最终代码运行或提交后结束练习方可计入；最后一次运行或官方提交未通过、或最终代码未运行即结束的，不计入。同一道题当天只计一次。专注时长与经验任务仅作展示，不额外加分。</HelpHint></div></div><button className="text-button" aria-expanded={goalOpen} disabled={!api || !dashboard || busy || frozen} onClick={() => { setGoal(String(target)); setGoalOpen(!goalOpen); }}>调整目标</button></div>
          <ol className="quest-list">
            <Quest icon="target" tone="green" title={`完成 ${target} 道题`} value={day.completedProblems} max={target} caption="">
              {goalOpen ? <form className="goal-form" onSubmit={event => { event.preventDefault(); void saveGoal(); }}><label>每天完成<input aria-label="每日练习目标" type="number" min="1" max="1000" value={goal} disabled={busy || frozen} onChange={event => setGoal(event.target.value)} autoFocus />题</label><div className="compact-actions"><button className="button primary" disabled={busy || frozen}>保存</button><button type="button" className="text-button" disabled={busy} onClick={() => setGoalOpen(false)}>取消</button></div></form>
                : <div className="quest-bar goal-progress" role="progressbar" aria-label="今日练习目标" aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.min(day.completedProblems, target)} aria-valuetext={`今日完成 ${day.completedProblems} 题，目标 ${target} 题`}><span style={scale(progress)} /><em>{dashboard ? day.completedProblems : '—'} / {target}</em></div>}
            </Quest>
            <Quest icon="timer" tone="blue" title={<>专注学习 {FOCUS_QUEST_MINUTES} 分钟<button className="text-button quest-link" onClick={() => onArchives(today)}>学习记录</button></>} value={focus} max={FOCUS_QUEST_MINUTES} caption={`${dashboard ? Math.min(focus, FOCUS_QUEST_MINUTES) : '—'} / ${FOCUS_QUEST_MINUTES}`} />
            {profile && <Quest icon="bolt" tone="gold" title={`获得 ${XP_QUEST} 经验`} value={profile.todayXp} max={XP_QUEST} caption={`${Math.min(profile.todayXp, XP_QUEST)} / ${XP_QUEST}`} />}
          </ol>
        </section>
        {profile && profile.totals.solvedProblems === 0 && profile.level <= 2 && <Starter profile={profile} library={library} onBrowse={onBrowse} onNavigate={onNavigate} />}
        {message && <p role="status" className="center-message">{message}</p>}
        {failure && <div className="center-load-error" role="alert"><p>学习记录读取失败：{failure}</p><button className="button" onClick={() => { setLoading(true); void load(); }}>重试读取</button></div>}
        <section className="center-review-summary dash-card" aria-label="复习计划摘要"><span className="dash-tile" data-tone="orange" aria-hidden="true"><Icon name="calendar" size={22} /></span><div><p className="dash-eyebrow">复习计划</p><h3>{review ? review.plannedCount > 0 ? `今天推荐复习 ${review.plannedCount} 题` : '今天暂无推荐复习' : failure ? '复习摘要暂不可用' : '正在读取复习摘要…'}</h3>{review && <p>已复习 {review.reviewedToday} 题 · {review.budget === null ? '不限量' : `每日量 ${review.budget} 题`}{review.extraDueCount > 0 && ` · 另有 ${review.extraDueCount} 题到期`}{review.pendingAssessmentCount > 0 && ` · ${review.pendingAssessmentCount} 题待补自评`}</p>}</div><button className="button" disabled={!api || frozen} onClick={onReviewPlan ?? onSettings}>查看复习计划</button></section>
        {language && onOpenProblems && <TopicInsightsCard api={api} language={language} library={library} onOpen={onOpenProblems} onRedo={onRedoProblems ?? onOpenProblems} />}
        {dashboard ? <ActivityHeatmap dashboard={dashboard} onArchives={onArchives} /> : <section className="activity-history dash-card dashboard-skeleton" aria-label={api ? '正在读取学习记录' : '暂无学习记录'}><h3>学习轨迹</h3><div /><p>{failure ? '学习记录读取失败，请重试。' : api ? '正在读取学习记录…' : '请在桌面应用中查看学习记录。'}</p></section>}
      </div>
      <aside className="dash-rail" aria-label="成长">
        {profile && <RankCard profile={profile} />}
        <StreakCard today={today} days={dayMap} streak={streak} profile={profile} />
        {profile && <AchievementWall profile={profile} />}
      </aside>
    </div>
    <footer className="center-footer"><span>近一年完成 {dashboard?.totals.completedProblems ?? '—'} 道不同题目</span><span>题炼</span></footer>
  </section>;
}
