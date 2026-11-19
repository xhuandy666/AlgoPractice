import { useSyncExternalStore } from 'react';

/** Per-device editor preferences. `suggestions` turns on the automatic popup; without it suggestions only appear on
 * request (Ctrl+Space), keeping practice close to writing code by hand. */
export interface EditorPreferences { suggestions: boolean; fontSize: number }
/** Code font sizes offered in settings, in pixels. */
export const EDITOR_FONT_SIZES: readonly number[] = [12, 13, 14, 15, 16, 18, 20];
export const DEFAULT_EDITOR_FONT_SIZE = 14;
/** Line height that keeps the default's proportions (14 px text on 26 px lines). */
export const editorLineHeight = (fontSize: number) => Math.round(fontSize * 26 / 14);
const KEY = 'algopractice.editor-preferences.v1';
const DEFAULTS: EditorPreferences = { suggestions: false, fontSize: DEFAULT_EDITOR_FONT_SIZE };
export function parseEditorPreferences(stored: string | null): EditorPreferences {
  try {
    const value = JSON.parse(stored ?? 'null') as Partial<EditorPreferences> | null;
    return { suggestions: value?.suggestions === true, fontSize: EDITOR_FONT_SIZES.includes(value?.fontSize as number) ? value!.fontSize as number : DEFAULT_EDITOR_FONT_SIZE };
  } catch { return { ...DEFAULTS }; }
}
let current: EditorPreferences | null = null;
const listeners = new Set<() => void>();

export function readEditorPreferences(): EditorPreferences {
  if (current) return current;
  try { current = parseEditorPreferences(localStorage.getItem(KEY)); } catch { current = { ...DEFAULTS }; }
  return current;
}
export function saveEditorPreferences(next: EditorPreferences) {
  current = { ...next };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* Preferences stay in memory for this window. */ }
  for (const listener of [...listeners]) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useEditorPreferences() { return useSyncExternalStore(subscribe, readEditorPreferences, () => DEFAULTS); }
