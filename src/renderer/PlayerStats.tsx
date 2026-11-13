import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { RewardProfile } from './rewards';
import { Icon } from './ui';

export function LevelRing({ profile, size = 44 }: { profile: RewardProfile; size?: number }) {
  const radius = 18, circumference = 2 * Math.PI * radius;
  return <span className="level-ring" data-rank={profile.rank.id} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) } as CSSProperties} aria-hidden="true">
    <svg viewBox="0 0 44 44" width={size} height={size}><circle className="level-ring-track" cx="22" cy="22" r={radius} /><circle className="level-ring-value" cx="22" cy="22" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - profile.levelProgress)} /></svg>
    <strong>{profile.level}</strong>
  </span>;
}

/** Header status chips. Experience grows from durable practice, never from clicks here. */
export function StatBar({ profile, onOpen }: { profile: RewardProfile | null; onOpen: () => void }) {
  const lastXp = useRef<number | null>(null), [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (profile && lastXp.current !== null && profile.xp > lastXp.current) setPulse(value => value + 1);
    lastXp.current = profile?.xp ?? null;
  }, [profile?.xp]);
  if (!profile) return <span className="stat-bar stat-bar-loading" aria-hidden="true"><span className="stat-chip" /><span className="stat-chip" /><span className="stat-chip" /></span>;
  const into = profile.xp - profile.levelStartXp, span = profile.nextLevelXp - profile.levelStartXp;
  const label = `${profile.rank.name} · 等级 ${profile.level}，本级经验 ${into}/${span}，今日 +${profile.todayXp} 经验，连续学习 ${profile.streak} 天`;
  return <button type="button" className="stat-bar" data-rank={profile.rank.id} aria-label={label} title={label} onClick={onOpen}>
    <span className="stat-chip stat-streak" data-active={profile.activeToday}><Icon name="flame" size={22} strokeWidth={2.4} /><strong>{profile.streak}</strong></span>
    <span className="stat-chip stat-xp" data-pulse={pulse ? pulse % 2 : undefined}><Icon name="bolt" size={22} strokeWidth={2.4} /><strong>{profile.todayXp}</strong></span>
    <span className="stat-chip stat-level"><LevelRing profile={profile} size={30} /><strong>{profile.rank.name}</strong></span>
  </button>;
}
