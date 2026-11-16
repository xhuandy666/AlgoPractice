import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Confetti } from './confetti';
import { onCelebrate, playChime, readRewardPreferences, type Celebration } from './reward-bus';
import type { RankId } from './rewards';
import { Icon, type IconName } from './ui';
import { Mascot } from './Mascot';
import './rewards.css';

type Tone = 'success' | 'gold' | 'flame' | 'accent';
interface Toast { id: number; tone: Tone; icon: IconName; title: string; detail?: string }
interface Hero { id: number; variant: 'pass' | 'official' | 'level' | 'goal' | 'reviews'; title: string; detail?: string; badge?: string; icon?: IconName; combo?: number; rankId?: RankId; duration: number }
interface Floater { id: number; amount: number; x: number; y: number }

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const palette = (...names: string[]) => names.map(token).filter(Boolean);
const center = (selector: string) => {
  const rect = document.querySelector(selector)?.getBoundingClientRect();
  return rect && rect.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
};
const below = (selector: string) => {
  const rect = document.querySelector(selector)?.getBoundingClientRect();
  return rect && rect.width ? { x: rect.left + rect.width / 2, y: rect.bottom + 4 } : null;
};

/** Pointer-transparent celebration overlay. It never takes focus, never blocks a control, and never opens a dialog. */
export function RewardLayer() {
  const canvas = useRef<HTMLCanvasElement>(null), confetti = useRef<Confetti | null>(null), serial = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]), [floaters, setFloaters] = useState<Floater[]>([]);
  const [hero, setHero] = useState<Hero | null>(null), heroQueue = useRef<Hero[]>([]), heroActive = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = useCallback((action: () => void, ms: number) => { const timer = setTimeout(() => { timers.current.delete(timer); action(); }, ms); timers.current.add(timer); }, []);

  const toast = useCallback((value: Omit<Toast, 'id'>) => {
    const id = ++serial.current;
    setToasts(current => [...current.slice(-2), { ...value, id }]);
    later(() => setToasts(current => current.filter(item => item.id !== id)), 3400);
  }, [later]);
  const showNextHero = useCallback(() => {
    const next = heroQueue.current.shift();
    if (!next) { heroActive.current = false; setHero(null); return; }
    heroActive.current = true; setHero(next);
    later(() => { setHero(null); later(showNextHero, 180); }, next.duration);
  }, [later]);
  const spotlight = useCallback((value: Omit<Hero, 'id'>, fallback: Omit<Toast, 'id'>) => {
    const { effects } = readRewardPreferences();
    if (effects !== 'full' || reducedMotion()) { toast(fallback); return; }
    heroQueue.current.push({ ...value, id: ++serial.current });
    if (!heroActive.current) showNextHero();
  }, [showNextHero, toast]);
  const burst = useCallback((kind: 'small' | 'medium' | 'big', origin?: { x: number; y: number } | null) => {
    if (readRewardPreferences().effects !== 'full' || reducedMotion() || document.visibilityState !== 'visible' || !canvas.current) return;
    confetti.current ??= new Confetti(canvas.current);
    const colors = palette('--color-gold', '--color-flame', '--color-xp', '--color-mint', '--color-blue-bright', '--color-error-bright');
    const width = window.innerWidth, height = window.innerHeight, point = origin ?? { x: width / 2, y: height * 0.42 };
    if (kind === 'small') confetti.current.burst({ ...point, count: 28, spread: 80, power: 9, colors });
    else if (kind === 'medium') confetti.current.burst({ ...point, count: 90, spread: 360, power: 11, colors });
    else {
      confetti.current.burst({ x: 0, y: height * 0.9, count: 110, angle: -60, spread: 40, power: 21, colors });
      confetti.current.burst({ x: width, y: height * 0.9, count: 110, angle: -120, spread: 40, power: 21, colors });
      later(() => confetti.current?.burst({ ...point, count: 70, spread: 360, power: 10, colors }), 260);
    }
  }, [later]);
  const floatXp = useCallback((amount: number) => {
    if (readRewardPreferences().effects === 'off') return;
    const anchor = below('.stat-bar .stat-xp') ?? { x: window.innerWidth - 160, y: 64 };
    const id = ++serial.current;
    setFloaters(current => [...current.slice(-3), { id, amount, ...anchor }]);
    later(() => setFloaters(current => current.filter(item => item.id !== id)), 1500);
  }, [later]);

  const handle = useCallback((event: Celebration) => {
    const { effects } = readRewardPreferences();
    const say = (text: string) => setAnnouncement(text);
    switch (event.kind) {
      case 'local-pass': {
        const comboText = event.combo >= 2 ? ` · 连击 ×${event.combo}` : '';
        say(`本地用例全部通过${comboText}`);
        if (effects === 'off') return;
        if (event.first) {
          playChime('pass');
          spotlight({ variant: 'pass', icon: 'check', title: '全部通过', detail: `${event.cases} 个本地用例全部通过`, combo: event.combo, duration: 1500 }, { tone: 'success', icon: 'check', title: '全部通过', detail: `${event.cases} 个本地用例${comboText}` });
          burst('medium');
        } else {
          playChime('soft');
          toast({ tone: 'success', icon: event.combo >= 2 ? 'bolt' : 'check', title: event.combo >= 2 ? `连击 ×${event.combo}` : '再次通过', detail: '本地用例全部通过' });
          burst('small', center('.run-actions .primary'));
        }
        return;
      }
      case 'official-accepted': {
        const detail = [event.runtime && `用时 ${event.runtime}`, event.memory && `内存 ${event.memory}`].filter(Boolean).join(' · ') || '官方判题通过';
        say(`力扣官方判题通过。${detail}`);
        if (effects === 'off') return;
        playChime('big');
        spotlight({ variant: 'official', badge: 'AC', title: '力扣官方通过', detail, duration: 2200 }, { tone: 'gold', icon: 'trophy', title: '力扣官方通过', detail });
        burst('big');
        return;
      }
      case 'review':
        say('复习已记录');
        if (effects === 'off') return;
        playChime('soft');
        toast({ tone: 'accent', icon: 'calendar', title: '复习已记录', detail: '已安排下次复习' });
        return;
      case 'reviews-cleared':
        say(`今日复习全部完成，共 ${event.count} 题`);
        if (effects === 'off') return;
        playChime('big');
        spotlight({ variant: 'reviews', icon: 'calendar', title: '今日复习完成', detail: `已复习 ${event.count} 题`, duration: 1900 }, { tone: 'success', icon: 'calendar', title: '今日复习完成', detail: `已复习 ${event.count} 题` });
        burst('medium');
        return;
      case 'goal':
        say(`今日目标达成，完成 ${event.target} 题`);
        if (effects === 'off') return;
        playChime('big');
        spotlight({ variant: 'goal', icon: 'target', title: '今日目标达成', detail: `已完成 ${event.target} 道题`, duration: 1900 }, { tone: 'success', icon: 'target', title: '今日目标达成', detail: `已完成 ${event.target} 道题` });
        burst('medium');
        return;
      case 'interview-finished':
        say('模拟面试已完成');
        if (effects === 'off') return;
        toast({ tone: 'accent', icon: 'timer', title: '面试已完成', detail: '面试报告已生成' });
        return;
      case 'xp':
        floatXp(event.amount);
        return;
      case 'level-up': {
        const title = event.rankChanged ? `晋升${event.rankName}` : '等级提升';
        say(`${title}，当前等级 ${event.level}`);
        if (effects === 'off') return;
        playChime('level');
        spotlight({ variant: 'level', badge: `Lv.${event.level}`, title, detail: `当前段位 · ${event.rankName}`, rankId: event.rankId, duration: 2400 }, { tone: 'gold', icon: 'star', title: `${title} · Lv.${event.level}`, detail: `当前段位 · ${event.rankName}` });
        burst('big');
        return;
      }
      case 'achievement':
        say(`解锁成就：${event.title}`);
        if (effects === 'off') return;
        playChime('soft');
        toast({ tone: 'gold', icon: event.icon, title: `解锁成就 · ${event.title}`, detail: event.description });
        return;
      case 'streak':
        say(`连续学习 ${event.days} 天`);
        if (effects === 'off') return;
        toast({ tone: 'flame', icon: 'flame', title: `连续学习 ${event.days} 天`, detail: '连续学习天数已更新' });
        return;
    }
  }, [burst, floatXp, spotlight, toast]);

  useEffect(() => onCelebrate(handle), [handle]);
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); confetti.current?.stop(); }, []);

  return <div className="reward-layer">
    <canvas ref={canvas} className="reward-confetti" aria-hidden="true" />
    {hero && <div key={hero.id} className="reward-hero" data-variant={hero.variant} data-rank={hero.rankId} aria-hidden="true" style={{ '--hero-duration': `${hero.duration}ms` } as CSSProperties}>
      {hero.badge ? <div className="reward-hero-badge"><span className="reward-hero-rays" /><span className="reward-hero-ring" /><strong>{hero.badge}</strong></div>
        : <div className="reward-hero-mascot"><span className="reward-hero-rays" /><Mascot mood="cheer" size={132} />{hero.icon && <span className="reward-hero-chip"><Icon name={hero.icon} size={26} strokeWidth={3} /></span>}</div>}
      <p className="reward-hero-title">{hero.title}</p>
      {hero.detail && <p className="reward-hero-detail">{hero.detail}</p>}
      {hero.combo !== undefined && hero.combo >= 2 && <p className="reward-hero-combo"><Icon name="bolt" size={14} strokeWidth={2.2} />连击 ×{hero.combo}</p>}
    </div>}
    <div className="reward-toasts" aria-hidden="true">{toasts.map(item => <div key={item.id} className="reward-toast" data-tone={item.tone}><span className="reward-toast-icon"><Icon name={item.icon} size={18} strokeWidth={2} /></span><span><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span></div>)}</div>
    {floaters.map(item => <span key={item.id} className="reward-xp-float" aria-hidden="true" style={{ left: item.x, top: item.y }}>+{item.amount} XP</span>)}
    <div className="sr-only" aria-live="polite">{announcement}</div>
  </div>;
}
