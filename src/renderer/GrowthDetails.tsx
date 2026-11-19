import { useEffect, useId, useRef } from 'react';
import { achievementNextStep, growthDistance, rankLadder, type GrowthAction, type ReviewOpportunity } from './growth-guidance';
import type { RewardProfile } from './rewards';
import { Icon } from './ui';
import './growth-details.css';

/** Which part to bring into view when the dialog opens; an achievement id focuses that badge. */
export type GrowthFocus = { section: 'ranks' | 'xp' | 'achievements'; achievementId?: string };

/** The ladder, today's experience by source and every badge's condition, progress and next step in one place.
 * The home cards show only the current level and badge icons; this is where the rules behind them can be read. */
export function GrowthDetails({ profile, focus, review, onAction, onClose }: {
  profile: RewardProfile; focus: GrowthFocus; review: ReviewOpportunity; onAction: (action: GrowthAction) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const sections = { ranks: useRef<HTMLElement>(null), xp: useRef<HTMLElement>(null), achievements: useRef<HTMLElement>(null) };
  useEffect(() => {
    // The dialog node is already detached when this cleanup runs, so the browser cannot restore focus by itself.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current; if (element && !element.open) element.showModal();
    const target = focus.achievementId ? element?.querySelector<HTMLElement>(`[data-achievement="${CSS.escape(focus.achievementId)}"]`) : sections[focus.section].current;
    target?.scrollIntoView({ block: 'start' }); target?.focus({ preventScroll: true });
    return () => { if (element?.open) element.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  const distance = growthDistance(profile), unlocked = profile.achievements.filter(item => item.unlocked).length;
  const act = (action: GrowthAction) => { onClose(); onAction(action); };
  return <dialog ref={dialog} className="growth-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <header className="growth-heading"><h2 id={titleId}>成长详情</h2><button type="button" className="text-button" onClick={onClose}>关闭</button></header>
    <section ref={sections.ranks} tabIndex={-1} aria-label="段位阶梯" className="growth-section">
      <h3>段位阶梯</h3>
      <p className="growth-summary">当前 <strong>{profile.rank.name} Lv.{profile.level}</strong>，累计 {profile.xp} XP。升到 Lv.{profile.level + 1} 还差 <strong>{distance.nextLevel} XP</strong>{!profile.nextRank || distance.nextRank === null ? '。已经是最高段位。' : profile.nextRank.minLevel === profile.level + 1 ? `，升级后晋升${profile.nextRank.name}。` : <>；晋升{profile.nextRank.name}（Lv.{profile.nextRank.minLevel}）还差 <strong>{distance.nextRank} XP</strong>。</>}</p>
      <ol className="rank-ladder">{rankLadder(profile).map(step => <li key={step.tier.id} data-rank={step.tier.id} data-state={step.state} aria-current={step.state === 'current' ? 'step' : undefined}>
        <strong>{step.tier.name}</strong><span>Lv.{step.tier.minLevel} 起</span><span>累计 {step.xp} XP</span>
        <em>{step.state === 'current' ? '当前' : step.state === 'next' ? '下一段' : step.state === 'reached' ? '已达到' : ''}</em>
      </li>)}</ol>
    </section>
    <section ref={sections.xp} tabIndex={-1} aria-label="今日经验" className="growth-section">
      <h3>今日经验 · {profile.todayXp} XP</h3>
      <table className="xp-sources"><thead><tr><th scope="col">来源</th><th scope="col">今天</th><th scope="col">每次</th><th scope="col">每日上限</th><th scope="col">获得</th></tr></thead>
        <tbody>{profile.todaySources.map(source => <tr key={source.id} data-capped={source.count > source.cap}>
          <th scope="row">{source.label}</th><td>{source.count}{source.count > source.cap ? `（计入 ${source.counted}）` : ''}</td><td>{source.unit} XP</td><td>{source.cap}</td><td>{source.xp} XP</td>
        </tr>)}</tbody></table>
      <p className="field-help">经验由学习记录算出，恢复备份后与记录一致。每个来源都有每日上限，重复运行同一份代码不会一直加分。用自己填写的期望输出跑通，按“其他练习运行”计。</p>
    </section>
    <section ref={sections.achievements} tabIndex={-1} aria-label="成就" className="growth-section">
      <h3>成就 · {unlocked} / {profile.achievements.length}</h3>
      <ul className="growth-achievements">{profile.achievements.map(item => {
        const next = achievementNextStep(item, profile, review);
        return <li key={item.id} tabIndex={-1} data-achievement={item.id} data-unlocked={item.unlocked}>
          <span className="achievement-badge" aria-hidden="true"><Icon name={item.icon} size={22} strokeWidth={2.4} /></span>
          <div><strong>{item.title}</strong><p>{item.description}</p>
            <p className="growth-progress"><span role="progressbar" aria-label={`${item.title}进度`} aria-valuemin={0} aria-valuemax={item.target} aria-valuenow={item.progress}><i style={{ transform: `scaleX(${item.progress / item.target})` }} /></span>{item.progress} / {item.target}</p>
            <p className="growth-next">{next.hint}</p></div>
          {next.action && <button type="button" className="button" onClick={() => act(next.action!)}>{next.label}</button>}
        </li>;
      })}</ul>
    </section>
  </dialog>;
}
