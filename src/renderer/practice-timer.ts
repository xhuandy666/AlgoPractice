import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';

// The workbench timer shows the current attempt's effective practice time, counted by the same rules as the learning
// statistics (src/desktop/learning-controller.ts pulses): only while the window is in front and was used recently.
// It starts from the stored total and counts locally, so it never waits for the next 10-second pulse.
export const IDLE_AFTER_MS = 300_000;

/** m:ss below an hour, h:mm:ss above. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}
/** One tick of the local count. A long gap between ticks (sleep, a blocked main thread) adds at most two seconds. */
export function tickElapsed(elapsed: number, deltaMs: number, active: boolean): number {
  return active ? elapsed + Math.min(Math.max(deltaMs, 0), 2000) : elapsed;
}

/** Effective time of the attempt in milliseconds; null (hidden) until the stored total is known, without an attempt,
 * or when it cannot be read. */
export function usePracticeTimer(api: Pick<DesktopBridge, 'attemptActiveTime'> | undefined, attemptId: string | null, counting: boolean): number | null {
  const [base, setBase] = useState<number | null>(null), [local, setLocal] = useState(0);
  const lastInput = useRef(performance.now());
  useEffect(() => {
    setBase(null); setLocal(0);
    if (!api || !attemptId) return;
    let alive = true;
    void api.attemptActiveTime(attemptId).then(total => { if (alive) setBase(total); }).catch(() => { /* Stay hidden rather than show a wrong time. */ });
    return () => { alive = false; };
  }, [api, attemptId]);
  useEffect(() => {
    const input = () => { lastInput.current = performance.now(); };
    for (const name of ['keydown', 'pointerdown', 'wheel']) window.addEventListener(name, input, { passive: true });
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now(), delta = now - last; last = now;
      const active = counting && document.visibilityState === 'visible' && document.hasFocus() && now - lastInput.current < IDLE_AFTER_MS;
      if (active) setLocal(value => tickElapsed(value, delta, true));
    }, 1000);
    return () => { clearInterval(timer); for (const name of ['keydown', 'pointerdown', 'wheel']) window.removeEventListener(name, input); };
  }, [counting]);
  return base === null ? null : base + local;
}
