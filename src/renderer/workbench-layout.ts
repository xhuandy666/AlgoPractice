export type WorkbenchPane = 'statement' | 'history' | 'results';
export type WorkbenchLayoutMode = 'columns' | 'history-stacked' | 'stacked';
export interface PaneRange { min: number; max: number }
export interface WorkbenchLayoutPreferences { statement: number; history: number; results: number }
export const WORKBENCH_LAYOUT_KEY = 'algo-workbench-layout-v1';
export const SPLITTER_SIZE = 12;
export const WORKBENCH_DEFAULTS: Readonly<WorkbenchLayoutPreferences> = Object.freeze({ statement: 27, history: 32, results: 32 });
const preferenceRanges: Record<WorkbenchPane, PaneRange> = { statement: { min: 15, max: 55 }, history: { min: 18, max: 60 }, results: { min: 12, max: 80 } };

export function clampPaneSize(value: number, range: PaneRange) {
  return Math.max(range.min, Math.min(range.max, Number.isFinite(value) ? value : range.min));
}

export function readWorkbenchPreferences(storage?: Pick<Storage, 'getItem'> | null): WorkbenchLayoutPreferences {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(WORKBENCH_LAYOUT_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...WORKBENCH_DEFAULTS };
    const record = parsed as Record<string, unknown>;
    return Object.fromEntries((Object.keys(WORKBENCH_DEFAULTS) as WorkbenchPane[]).map(side => [side,
      typeof record[side] === 'number' && Number.isFinite(record[side]) ? clampPaneSize(record[side], preferenceRanges[side]) : WORKBENCH_DEFAULTS[side],
    ])) as unknown as WorkbenchLayoutPreferences;
  } catch { return { ...WORKBENCH_DEFAULTS }; }
}

export function saveWorkbenchPreferences(storage: Pick<Storage, 'setItem'> | null | undefined, preferences: WorkbenchLayoutPreferences) {
  try { storage?.setItem(WORKBENCH_LAYOUT_KEY, JSON.stringify(preferences)); } catch { /* Layout remains usable if local storage is unavailable or full. */ }
}

export function preferenceFromSize(side: WorkbenchPane, size: number, span: number) {
  if (!Number.isFinite(size) || !Number.isFinite(span) || span <= 0) return WORKBENCH_DEFAULTS[side];
  return clampPaneSize(Math.round(size / span * 100000) / 1000, preferenceRanges[side]);
}

/** Work with measured content-box widths, not window width: expanding the main navigation must reflow too. */
export function calculateWorkbenchLayout(width: number, showStatement: boolean, showHistory: boolean, preferences: WorkbenchLayoutPreferences) {
  const usable = Number.isFinite(width) && width > 0 ? width : 1000;
  const minimum = { statement: 220, editor: 320, history: 280 };
  const splitterCount = Number(showStatement) + Number(showHistory);
  const fullMinimum = minimum.editor + (showStatement ? minimum.statement : 0) + (showHistory ? minimum.history : 0) + splitterCount * SPLITTER_SIZE;
  const twoColumnMinimum = minimum.editor + (showStatement ? minimum.statement + SPLITTER_SIZE : 0);
  const mode: WorkbenchLayoutMode = usable < Math.max(580, twoColumnMinimum) ? 'stacked' : showHistory && usable < fullMinimum ? 'history-stacked' : 'columns';
  const historyInColumns = showHistory && mode === 'columns';
  const historyRange = historyInColumns ? { min: minimum.history, max: Math.max(minimum.history, Math.min(usable * .6,
    usable - minimum.editor - (showStatement ? minimum.statement + SPLITTER_SIZE : 0) - SPLITTER_SIZE)) } : { min: minimum.history, max: Math.max(minimum.history, usable * .6) };
  const history = historyInColumns ? clampPaneSize(usable * preferences.history / 100, historyRange) : usable;
  const statementRange = showStatement && mode !== 'stacked' ? { min: minimum.statement, max: Math.max(minimum.statement, Math.min(usable * .55,
    usable - minimum.editor - SPLITTER_SIZE - (historyInColumns ? history + SPLITTER_SIZE : 0))) } : { min: minimum.statement, max: Math.max(minimum.statement, usable * .55) };
  const statement = showStatement && mode !== 'stacked' ? clampPaneSize(usable * preferences.statement / 100, statementRange) : usable;
  const columns = [showStatement ? `${statement}px ${SPLITTER_SIZE}px` : '', 'minmax(0, 1fr)', historyInColumns ? `${SPLITTER_SIZE}px ${history}px` : ''].filter(Boolean).join(' ');
  return { mode, columns, sizes: { statement, history }, ranges: { statement: statementRange, history: historyRange },
    defaults: { statement: clampPaneSize(usable * WORKBENCH_DEFAULTS.statement / 100, statementRange), history: clampPaneSize(usable * WORKBENCH_DEFAULTS.history / 100, historyRange) }, width: usable };
}

/** Toolbar and borders are measured separately so wrapping controls cannot steal the editor's minimum height. */
export function calculateResultLayout(height: number, toolbarHeight: number, preference: number) {
  const measuredHeight = Number.isFinite(height) && height > 0 ? height : 640;
  const measuredToolbar = Number.isFinite(toolbarHeight) && toolbarHeight >= 0 ? toolbarHeight : 54;
  const span = Math.max(1, measuredHeight - measuredToolbar - SPLITTER_SIZE);
  const minEditor = Math.min(180, span * .6), minResults = Math.min(120, span * .4);
  const range = { min: minResults, max: Math.max(minResults, Math.min(span * .8, span - minEditor)) };
  return { span, range, size: clampPaneSize(span * preference / 100, range), defaultValue: clampPaneSize(span * WORKBENCH_DEFAULTS.results / 100, range) };
}

export function splitterKeySize(side: WorkbenchPane, key: string, value: number, range: PaneRange, defaultValue: number, largeStep = false): number | null {
  if (key === 'Home') return range.min;
  if (key === 'End') return range.max;
  if (key === 'Enter') return clampPaneSize(defaultValue, range);
  const direction = side === 'results' ? key === 'ArrowUp' ? 1 : key === 'ArrowDown' ? -1 : 0
    : key === 'ArrowRight' ? (side === 'history' ? -1 : 1) : key === 'ArrowLeft' ? (side === 'history' ? 1 : -1) : 0;
  return direction ? clampPaneSize(value + direction * (largeStep ? 64 : 24), range) : null;
}
