import { PerformanceRecorder, PERFORMANCE_RECORDING_MS } from './performance-recorder';

let page = 'environment';
let recording: PerformanceRecorder | null = null;
let cleanup: (() => void) | null = null;
let state = { recording: false, hasReport: false };
const listeners = new Set<() => void>();
const publish = () => { state = { recording: Boolean(recording?.active), hasReport: Boolean(recording) }; for (const listener of listeners) listener(); };
export const subscribePerformance = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getPerformanceState = () => state;
export function setPerformancePage(next: string) { page = next; recording?.setPage(next, performance.now()); }
export function stopPerformanceRecording() {
  recording?.stop(performance.now()); cleanup?.(); cleanup = null; publish();
}
export function performanceReport() { return recording ? JSON.stringify(recording.report(performance.now()), null, 2) : ''; }
export function startPerformanceRecording() {
  cleanup?.();
  const next = new PerformanceRecorder(performance.now(), page); recording = next;
  let frame = 0;
  const foreground = () => next.setForeground(document.visibilityState === 'visible' && document.hasFocus(), performance.now());
  foreground();
  const sample = () => {
    foreground(); next.frame(performance.now());
    if (!next.active) { stopPerformanceRecording(); return; }
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    observer = new PerformanceObserver(list => { foreground(); for (const entry of list.getEntries()) next.longTask(entry.startTime, entry.duration); });
    observer.observe({ type: 'longtask', buffered: false });
  }
  document.addEventListener('visibilitychange', foreground); window.addEventListener('focus', foreground); window.addEventListener('blur', foreground);
  const timeout = setTimeout(stopPerformanceRecording, PERFORMANCE_RECORDING_MS);
  cleanup = () => { cancelAnimationFrame(frame); clearTimeout(timeout); observer?.disconnect(); document.removeEventListener('visibilitychange', foreground); window.removeEventListener('focus', foreground); window.removeEventListener('blur', foreground); };
  publish();
}
