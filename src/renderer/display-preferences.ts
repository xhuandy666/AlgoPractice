import { useSyncExternalStore } from 'react';

/** Per-device display preferences. `topicTags` shows a problem's topic tags (双指针, 动态规划…) in lists and in the
 * workbench header; they are off by default because a topic names the technique before the problem is attempted.
 * The statement always keeps them one click away under “相关专题”. */
export type ThemePreference = 'light' | 'dark' | 'system';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];
/** `theme` picks the appearance; 'system' follows the operating system and changes with it. */
export interface DisplayPreferences { topicTags: boolean; theme: ThemePreference }
const KEY = 'algopractice.display-preferences.v1';
const DEFAULTS: DisplayPreferences = { topicTags: false, theme: 'light' };
let current: DisplayPreferences | null = null;
const listeners = new Set<() => void>();

export function parseDisplayPreferences(stored: string | null): DisplayPreferences {
  try { const value = JSON.parse(stored ?? 'null') as Partial<DisplayPreferences> | null; return { topicTags: value?.topicTags === true, theme: THEME_PREFERENCES.includes(value?.theme as ThemePreference) ? value!.theme as ThemePreference : 'light' }; }
  catch { return { ...DEFAULTS }; }
}
export function readDisplayPreferences(): DisplayPreferences {
  if (current) return current;
  try { current = parseDisplayPreferences(localStorage.getItem(KEY)); } catch { current = { ...DEFAULTS }; }
  return current;
}
export function saveDisplayPreferences(next: DisplayPreferences) {
  current = { ...next };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* Preferences stay in memory for this window. */ }
  for (const listener of [...listeners]) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Runs `listener` after every saved change; returns the unsubscribe function. */
export const onDisplayPreferences = subscribe;
export function useDisplayPreferences() { return useSyncExternalStore(subscribe, readDisplayPreferences, () => DEFAULTS); }
