import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { clampPaneSize, splitterKeySize, type WorkbenchPane } from './workbench-layout';

const labels: Record<WorkbenchPane, { label: string; panel: string }> = {
  statement: { label: '调整题面宽度', panel: '题面' }, history: { label: '调整记录宽度', panel: '记录与 AI' }, results: { label: '调整测试结果高度', panel: '测试结果' },
};
export function WorkbenchSplitter({ side, value, min, max, defaultValue, onChange }: {
  side: WorkbenchPane; value: number; min: number; max: number; defaultValue: number; onChange: (value: number) => void;
}) {
  const separatorRef = useRef<HTMLDivElement>(null);
  const controlsId = useId();
  const [dragging, setDragging] = useState(false), [controls, setControls] = useState(false);
  const drag = useRef<{ pointerId: number; origin: number; value: number } | null>(null);
  const latest = useRef({ value, min, max, defaultValue, onChange }); latest.current = { value, min, max, defaultValue, onChange };
  const finish = useCallback(() => {
    const current = drag.current; drag.current = null;
    if (!current) return;
    if (current && separatorRef.current?.hasPointerCapture(current.pointerId)) { try { separatorRef.current.releasePointerCapture(current.pointerId); } catch { /* Already released by the browser. */ } }
    if (document.documentElement.getAttribute('data-workbench-resizing-owner') === controlsId) {
      document.documentElement.removeAttribute('data-workbench-resizing'); document.documentElement.removeAttribute('data-workbench-resizing-owner');
    }
    setDragging(false);
  }, [controlsId]);
  useEffect(() => {
    const end = (event: PointerEvent) => { if (drag.current?.pointerId === event.pointerId) finish(); };
    window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', finish);
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', finish); finish(); };
  }, [finish]);
  const update = (next: number) => latest.current.onChange(clampPaneSize(next, { min: latest.current.min, max: latest.current.max }));
  const horizontal = side === 'results', text = labels[side];
  return <div className={`workbench-splitter-track ${side}-splitter`} data-orientation={horizontal ? 'horizontal' : 'vertical'} data-dragging={dragging} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setControls(false); }} onKeyDown={event => {
    if (event.key === 'Escape' && controls) { event.preventDefault(); event.stopPropagation(); setControls(false); event.currentTarget.querySelector<HTMLButtonElement>('.splitter-options')?.focus(); }
  }}>
    <div ref={separatorRef} role="separator" tabIndex={0} aria-label={text.label} aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} aria-valuetext={`${text.panel} ${Math.round(value)} 像素`}
      className={`pane-splitter ${side}-splitter`} title="拖动调整；方向键微调，Home / End 最小 / 最大，Enter 或双击恢复默认"
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault(); event.currentTarget.focus(); setControls(false);
        drag.current = { pointerId: event.pointerId, origin: horizontal ? event.clientY : event.clientX, value: latest.current.value };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window end listeners still clear the gesture if capture is unsupported. */ }
        document.documentElement.setAttribute('data-workbench-resizing', horizontal ? 'row' : 'column'); document.documentElement.setAttribute('data-workbench-resizing-owner', controlsId); setDragging(true);
      }} onPointerMove={event => {
        const current = drag.current; if (!current || current.pointerId !== event.pointerId) return;
        const delta = (horizontal ? event.clientY : event.clientX) - current.origin;
        update(current.value + delta * (side === 'statement' ? 1 : -1));
      }} onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finish(); }} onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finish(); }} onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finish(); }}
      onDoubleClick={() => update(defaultValue)} onKeyDown={event => {
        const next = splitterKeySize(side, event.key, value, { min, max }, defaultValue, event.shiftKey);
        if (next !== null) { event.preventDefault(); update(next); }
      }} />
    <button type="button" className="splitter-options" aria-label={`${text.label}选项`} aria-expanded={controls} aria-controls={controls ? controlsId : undefined} title="点击调整面板大小" onClick={() => setControls(!controls)}>
      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M5 4h6M5 8h6M5 12h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
    </button>
    {controls && <div id={controlsId} className="splitter-controls" role="group" aria-label={`${text.label}操作`}>
      <button type="button" disabled={value <= min} onClick={() => update(value - 48)}>缩小{text.panel}</button>
      <button type="button" disabled={value >= max} onClick={() => update(value + 48)}>扩大{text.panel}</button>
      <button type="button" onClick={() => update(defaultValue)}>恢复默认</button>
    </div>}
  </div>;
}
