import { useSyncExternalStore } from 'react';

/** Per-device editor preferences. `suggestions` turns on the automatic popup; without it suggestions only appear on
 * request (Ctrl+Space), keeping practice close to writing code by hand. */
export interface EditorPreferences { suggestions: boolean }
const KEY = 'algopractice.editor-preferences.v1';
const DEFAULTS: EditorPreferences = { suggestions: false };
let current: EditorPreferences | null = null;
const listeners = new Set<() => void>();

export function readEditorPreferences(): EditorPreferences {
  if (current) return current;
  try { const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<EditorPreferences> | null; current = { suggestions: value?.suggestions === true }; }
  catch { current = { ...DEFAULTS }; }
  return current;
}
export function saveEditorPreferences(next: EditorPreferences) {
  current = { ...next };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* Preferences stay in memory for this window. */ }
  for (const listener of [...listeners]) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useEditorPreferences() { return useSyncExternalStore(subscribe, readEditorPreferences, () => DEFAULTS); }
