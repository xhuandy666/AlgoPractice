// What the main process does when the workbench page (the renderer process) is gone. Pure policy; main.ts applies it.
//
// The page holds nothing that is not on disk except edits from the last few seconds: every editor saves on a short
// debounce (at most about two seconds). So a crashed page is reloaded instead of leaving a dead window until the whole
// app restarts. A page that keeps crashing is not reloaded in a loop; the user decides.
export const CRASH_WINDOW_MS = 120_000;
export const MAX_RELOADS_IN_WINDOW = 3;

export type RendererGoneDecision =
  /** The app is quitting anyway: finish quitting without waiting for the page. */
  | { action: 'quit' }
  /** The window itself is gone; nothing to reload. */
  | { action: 'ignore' }
  /** Reload now. `notice`: tell the user once the page is back (not after a reload they asked for). */
  | { action: 'reload'; notice: boolean }
  /** A backup restore holds the maintenance gate: reload as soon as it is released. */
  | { action: 'wait'; notice: boolean }
  /** Crashed again and again in a short time: stop reloading and let the user choose. */
  | { action: 'ask' };

export interface RendererState { quitting: boolean; windowDestroyed: boolean; maintenance: boolean; }

export class RendererRecovery {
  readonly #now: () => number; readonly #windowMs: number; readonly #maxReloads: number;
  #crashes: number[] = []; #expected = false;
  constructor(options: { now?: () => number; windowMs?: number; maxReloads?: number } = {}) {
    this.#now = options.now ?? Date.now; this.#windowMs = options.windowMs ?? CRASH_WINDOW_MS; this.#maxReloads = options.maxReloads ?? MAX_RELOADS_IN_WINDOW;
  }
  /** The user chose to reload a page that stopped responding; the coming 'gone' event is theirs, not a crash. */
  expectReload(): void { this.#expected = true; }
  gone(state: RendererState): RendererGoneDecision {
    const expected = this.#expected; this.#expected = false;
    if (state.quitting) return { action: 'quit' };
    if (state.windowDestroyed) return { action: 'ignore' };
    if (!expected) {
      const now = this.#now();
      this.#crashes = [...this.#crashes.filter(at => now - at < this.#windowMs), now];
      if (this.#crashes.length > this.#maxReloads) return { action: 'ask' };
    }
    return state.maintenance ? { action: 'wait', notice: !expected } : { action: 'reload', notice: !expected };
  }
}
