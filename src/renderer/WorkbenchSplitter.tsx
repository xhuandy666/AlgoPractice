import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { clampPaneSize, splitterDragEngaged, splitterDragSize, splitterKeySize, type WorkbenchPane } from './workbench-layout';

const labels: Record<WorkbenchPane, { label: string; panel: string }> = {
  statement: { label: '调整题面宽度', panel: '题面' }, history: { label: '调整记录宽度', panel: '记录与 AI' }, results: { label: '调整测试结果高度', panel: '测试结果' },
};
// One press on the divider line or on its grip. It becomes a resize only after the pointer travels past the drag threshold.
type Gesture = { pointerId: number; origin: number; value: number; target: HTMLElement; fromGrip: boolean; engaged: boolean };

export function WorkbenchSplitter({ side, value, min, max, defaultValue, onChange }: {
  side: WorkbenchPane; value: number; min: number; max: number; defaultValue: number; onChange: (value: number) => void;
}) {
  const controlsId = useId();
  const [dragging, setDragging] = useState(false), [controls, setControls] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  // The browser still sends a click to the grip when a drag that started on it ends; that click must not open the size menu.
  const swallowGripClick = useRef(false);
  const latest = useRef({ value, min, max, defaultValue, onChange }); latest.current = { value, min, max, defaultValue, onChange };
  const horizontal = side === 'results', text = labels[side];
  const finish = useCallback(() => {
    const current = gesture.current; gesture.current = null;
    if (!current) return;
    if (current.target.hasPointerCapture(current.pointerId)) { try { current.target.releasePointerCapture(current.pointerId); } catch { /* Already released by the browser. */ } }
    if (!current.engaged) return;
    if (current.fromGrip) { swallowGripClick.current = true; setTimeout(() => { swallowGripClick.current = false; }, 0); }
    if (document.documentElement.getAttribute('data-workbench-resizing-owner') === controlsId) {
      document.documentElement.removeAttribute('data-workbench-resizing'); document.documentElement.removeAttribute('data-workbench-resizing-owner');
    }
    setDragging(false);
  }, [controlsId]);
  useEffect(() => {
    const end = (event: PointerEvent) => { if (gesture.current?.pointerId === event.pointerId) finish(); };
    window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', finish);
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', finish); finish(); };
  }, [finish]);
  const update = (next: number) => latest.current.onChange(clampPaneSize(next, { min: latest.current.min, max: latest.current.max }));
  const begin = (event: ReactPointerEvent<HTMLElement>, fromGrip: boolean) => {
    if (event.button !== 0 || gesture.current) return;
    swallowGripClick.current = false;
    // The line has no click action, so it takes focus for the keyboard at once. The grip keeps its native press so a still click opens the menu.
    if (!fromGrip) { event.preventDefault(); event.currentTarget.focus(); setControls(false); }
    gesture.current = { pointerId: event.pointerId, origin: horizontal ? event.clientY : event.clientX, value: latest.current.value, target: event.currentTarget, fromGrip, engaged: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window end listeners still clear the gesture if capture is unsupported. */ }
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current; if (!current || current.pointerId !== event.pointerId) return;
    const position = horizontal ? event.clientY : event.clientX;
    if (!current.engaged) {
      if (!splitterDragEngaged(current.origin, position)) return;
      current.engaged = true; setControls(false); setDragging(true);
      document.documentElement.setAttribute('data-workbench-resizing', horizontal ? 'row' : 'column'); document.documentElement.setAttribute('data-workbench-resizing-owner', controlsId);
    }
    latest.current.onChange(splitterDragSize(side, current.value, current.origin, position, { min: latest.current.min, max: latest.current.max }));
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => { if (gesture.current?.pointerId === event.pointerId) finish(); };
  const pointer = { onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end };
  return <div className={`workbench-splitter-track ${side}-splitter`} data-orientation={horizontal ? 'horizontal' : 'vertical'} data-dragging={dragging} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setControls(false); }} onKeyDown={event => {
    if (event.key === 'Escape' && controls) { event.preventDefault(); event.stopPropagation(); setControls(false); event.currentTarget.querySelector<HTMLButtonElement>('.splitter-options')?.focus(); }
  }}>
    <div role="separator" tabIndex={0} aria-label={text.label} aria-orientation={horizontal ? 'horizontal' : 'vertical'} aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} aria-valuetext={`${text.panel} ${Math.round(value)} 像素`}
      className={`pane-splitter ${side}-splitter`} title="拖动调整；方向键微调，Home / End 最小 / 最大，Enter 或双击恢复默认"
      onPointerDown={event => begin(event, false)} {...pointer}
      onDoubleClick={() => update(defaultValue)} onKeyDown={event => {
        const next = splitterKeySize(side, event.key, value, { min, max }, defaultValue, event.shiftKey);
        if (next !== null) { event.preventDefault(); update(next); }
      }} />
    <button type="button" className="splitter-options" aria-label={`${text.label}选项`} aria-expanded={controls} aria-controls={controls ? controlsId : undefined} title="拖动调整；点击打开大小选项"
      onPointerDown={event => begin(event, true)} {...pointer}
      onClick={() => { if (swallowGripClick.current) { swallowGripClick.current = false; return; } setControls(!controls); }}>
      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M5 4h6M5 8h6M5 12h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
    </button>
    {controls && <div id={controlsId} className="splitter-controls" role="group" aria-label={`${text.label}操作`}>
      <button type="button" disabled={value <= min} onClick={() => update(value - 48)}>缩小{text.panel}</button>
      <button type="button" disabled={value >= max} onClick={() => update(value + 48)}>扩大{text.panel}</button>
      <button type="button" onClick={() => update(defaultValue)}>恢复默认</button>
    </div>}
  </div>;
}
