import { onDisplayPreferences, readDisplayPreferences, type ThemePreference } from './display-preferences';

export type Theme = 'light' | 'dark';
/** 'system' resolves to the operating system's current appearance. */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  return preference === 'system' ? systemDark ? 'dark' : 'light' : preference;
}
const listeners = new Set<(theme: Theme) => void>();
let applied: Theme | null = null;
function apply() {
  const theme = resolveTheme(readDisplayPreferences().theme, typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (theme === applied) return;
  applied = theme; document.documentElement.dataset.theme = theme;
  for (const listener of [...listeners]) listener(theme);
}
/** Applies the chosen theme to the document now and keeps it current when the preference or the system changes. */
export function startTheme() {
  apply(); onDisplayPreferences(apply);
  if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
}
/** For canvases that copy the palette (the code editor): called after the document's theme has changed. */
export function onThemeChange(listener: (theme: Theme) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const currentTheme = (): Theme => applied ?? 'light';
