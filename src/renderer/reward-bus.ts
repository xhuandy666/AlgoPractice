import { useSyncExternalStore } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import type { AchievementIcon, RankId } from './rewards';

export type Celebration =
  | { kind: 'local-pass'; first: boolean; combo: number; cases: number }
  | { kind: 'official-accepted'; runtime?: string; memory?: string }
  | { kind: 'review' }
  | { kind: 'reviews-cleared'; count: number }
  | { kind: 'goal'; target: number }
  | { kind: 'interview-finished' }
  | { kind: 'xp'; amount: number }
  | { kind: 'level-up'; level: number; rankId: RankId; rankName: string; rankChanged: boolean }
  | { kind: 'achievement'; title: string; description: string; icon: AchievementIcon }
  | { kind: 'streak'; days: number };

export type RewardEffects = 'full' | 'calm' | 'off';
export interface RewardPreferences { effects: RewardEffects; sound: boolean }
const PREFERENCES_KEY = 'algo-reward-preferences-v1';
const DEFAULT_PREFERENCES: RewardPreferences = { effects: 'full', sound: false };

const celebrationListeners = new Set<(celebration: Celebration) => void>();
const activityListeners = new Set<() => void>();
const preferenceListeners = new Set<() => void>();
const celebrated = new Set<string>();
let combo = 0;
let preferences: RewardPreferences | null = null;

export function onCelebrate(listener: (celebration: Celebration) => void) { celebrationListeners.add(listener); return () => { celebrationListeners.delete(listener); }; }
export function celebrate(celebration: Celebration) { for (const listener of [...celebrationListeners]) listener(celebration); }
/** Some sources (official events, reloads) can repeat the same durable fact; celebrate it once per window. */
export function celebrateOnce(key: string, celebration: Celebration) { if (celebrated.has(key)) return; celebrated.add(key); celebrate(celebration); }
/** Durable statistics may have changed; the profile re-reads them and announces the difference. */
export function onRewardActivity(listener: () => void) { activityListeners.add(listener); return () => { activityListeners.delete(listener); }; }
export function rewardActivity() { for (const listener of [...activityListeners]) listener(); }

/** Consecutive fully passing local runs in this window; any other terminal result breaks the chain. */
export function recordRunOutcome(passed: boolean) { combo = passed ? combo + 1 : 0; return combo; }

export function readRewardPreferences(): RewardPreferences {
  if (preferences) return preferences;
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? 'null') as Partial<RewardPreferences> | null;
    preferences = { effects: value?.effects === 'calm' || value?.effects === 'off' ? value.effects : 'full', sound: value?.sound === true };
  } catch { preferences = { ...DEFAULT_PREFERENCES }; }
  return preferences;
}
export function saveRewardPreferences(next: RewardPreferences) {
  preferences = { ...next };
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Preferences stay in memory for this window. */ }
  for (const listener of [...preferenceListeners]) listener();
}
const subscribePreferences = (listener: () => void) => { preferenceListeners.add(listener); return () => { preferenceListeners.delete(listener); }; };
export function useRewardPreferences() { return useSyncExternalStore(subscribePreferences, readRewardPreferences, () => DEFAULT_PREFERENCES); }

const onceToday = (key: string, date: string) => {
  try { if (localStorage.getItem(key) === date) return false; localStorage.setItem(key, date); } catch { /* Fall back to the in-window guard. */ }
  return !celebrated.has(`${key}:${date}`) && Boolean(celebrated.add(`${key}:${date}`));
};
/** The goal counts distinct problems completed today (solved, or ended without a failing verdict), exactly like the learning center. */
export async function checkDailyGoal(api: DesktopBridge) {
  const dashboard = await api.learningDashboard();
  const today = dashboard.days.find(day => day.date === dashboard.date);
  if (today && today.completedProblems >= dashboard.dailyPracticeGoal && onceToday('algo-reward-goal', dashboard.date)) celebrate({ kind: 'goal', target: dashboard.dailyPracticeGoal });
}
export async function checkReviewsCleared(api: DesktopBridge) {
  const { summary } = await api.reviewPlan({ view: 'today', limit: 1 });
  if (summary.plannedCount === 0 && summary.reviewedToday > 0 && onceToday('algo-reward-reviews', summary.date)) celebrate({ kind: 'reviews-cleared', count: summary.reviewedToday });
}

type Chime = 'pass' | 'big' | 'level' | 'soft';
let audio: AudioContext | null = null;
const CHIMES: Record<Chime, { notes: number[]; step: number; type: OscillatorType; gain: number }> = {
  soft: { notes: [659.25, 987.77], step: 0.09, type: 'sine', gain: 0.05 },
  pass: { notes: [523.25, 659.25, 783.99], step: 0.075, type: 'triangle', gain: 0.06 },
  big: { notes: [523.25, 659.25, 783.99, 1046.5], step: 0.085, type: 'triangle', gain: 0.07 },
  level: { notes: [392, 523.25, 659.25, 783.99, 1046.5, 1318.5], step: 0.07, type: 'triangle', gain: 0.065 },
};
/** Synthesized locally; no audio assets or network. Silent unless the user enabled sound. */
export function playChime(kind: Chime) {
  if (!readRewardPreferences().sound) return;
  try {
    audio ??= new AudioContext();
    const { notes, step, type, gain } = CHIMES[kind], start = audio.currentTime + 0.01;
    notes.forEach((frequency, index) => {
      const oscillator = audio!.createOscillator(), envelope = audio!.createGain(), at = start + index * step;
      oscillator.type = type; oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(gain, at + 0.015);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
      oscillator.connect(envelope).connect(audio!.destination);
      oscillator.start(at); oscillator.stop(at + 0.34);
    });
  } catch { /* Audio is optional feedback. */ }
}
