import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { calculateResultLayout, calculateWorkbenchLayout, preferenceFromSize, readWorkbenchPreferences, saveWorkbenchPreferences, type WorkbenchPane } from './workbench-layout';

function localLayoutStorage() { try { return window.localStorage; } catch { return null; } }

export function useWorkbenchLayout({ active, showStatement, showHistory }: { active: boolean; showStatement: boolean; showHistory: boolean }) {
  const [preferences, setPreferences] = useState(() => readWorkbenchPreferences(localLayoutStorage()));
  const [workbenchElement, workbenchRef] = useState<HTMLDivElement | null>(null);
  const [codingElement, codingRef] = useState<HTMLElement | null>(null);
  const [measurements, setMeasurements] = useState({ width: 1000, height: 640, toolbar: 54 });
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  useLayoutEffect(() => {
    if (!active || !workbenchElement || !codingElement) return;
    const toolbar = codingElement.querySelector<HTMLElement>('.editor-toolbar');
    let frame = 0;
    const measure = () => {
      const workbenchStyles = getComputedStyle(workbenchElement), codingStyles = getComputedStyle(codingElement);
      const width = workbenchElement.clientWidth - parseFloat(workbenchStyles.paddingLeft || '0') - parseFloat(workbenchStyles.paddingRight || '0');
      const height = codingElement.clientHeight - parseFloat(codingStyles.paddingTop || '0') - parseFloat(codingStyles.paddingBottom || '0');
      const toolbarHeight = toolbar?.getBoundingClientRect().height ?? 54;
      if (width <= 0 || height <= 0) return;
      setMeasurements(current => Math.abs(current.width - width) < .5 && Math.abs(current.height - height) < .5 && Math.abs(current.toolbar - toolbarHeight) < .5
        ? current : { width, height, toolbar: toolbarHeight });
    };
    const queueMeasure = () => { if (frame) return; frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(queueMeasure) : null;
    observer?.observe(workbenchElement); observer?.observe(codingElement); if (toolbar) observer?.observe(toolbar);
    window.addEventListener('resize', queueMeasure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', queueMeasure); if (frame) cancelAnimationFrame(frame); };
  }, [active, workbenchElement, codingElement, showStatement, showHistory]);
  const horizontal = calculateWorkbenchLayout(measurements.width, showStatement, showHistory, preferences);
  const results = calculateResultLayout(measurements.height, measurements.toolbar, preferences.results);
  const spansRef = useRef({ width: horizontal.width, results: results.span }); spansRef.current = { width: horizontal.width, results: results.span };
  const changeSize = useCallback((side: WorkbenchPane, size: number) => {
    const next = { ...preferencesRef.current, [side]: preferenceFromSize(side, size, side === 'results' ? spansRef.current.results : spansRef.current.width) };
    preferencesRef.current = next; setPreferences(next); saveWorkbenchPreferences(localLayoutStorage(), next);
  }, []);
  const style: CSSProperties = { gridTemplateColumns: horizontal.columns, '--statement-size': `${horizontal.sizes.statement}px`, '--history-size': `${horizontal.sizes.history}px` } as CSSProperties;
  const codingStyle = { '--results-size': `${results.size}px` } as CSSProperties;
  return { workbenchRef, codingRef, style, codingStyle, mode: horizontal.mode, changeSize,
    sizes: { ...horizontal.sizes, results: results.size }, ranges: { ...horizontal.ranges, results: results.range }, defaults: { ...horizontal.defaults, results: results.defaultValue } };
}
