export const PERFORMANCE_RECORDING_MS = 90000;
const pages = new Set(['today', 'library', 'workbench', 'sources', 'notes', 'archives', 'learning-settings', 'environment', 'interview']);
type PerformancePage = 'today' | 'library' | 'workbench' | 'sources' | 'notes' | 'archives' | 'learning-settings' | 'environment' | 'interview' | 'unknown';
type Sample = { elapsedMs: number; durationMs: number; page: PerformancePage; transition: boolean };
type Summary = { frames: number; totalFrameMs: number; longestFrameMs: number; framesOver50Ms: number; transitionFramesOver50Ms: number };
const emptySummary = (): Summary => ({ frames: 0, totalFrameMs: 0, longestFrameMs: 0, framesOver50Ms: 0, transitionFramesOver50Ms: 0 });
const rounded = (value: number) => Math.round(value * 10) / 10;
function ring<T>(limit: number) {
  const values: T[] = []; let next = 0;
  return { push(value: T) { if (values.length < limit) values.push(value); else { values[next] = value; next = (next + 1) % limit; } }, read() { return [...values.slice(next), ...values.slice(0, next)]; } };
}

/** Numeric timings and a fixed page allowlist only; no DOM content or user input. */
export class PerformanceRecorder {
  readonly startedAt: number;
  #page: PerformancePage;
  #foregroundSince: number | null = null;
  #previousFrame: number | null = null;
  #transitionStarted = -Infinity; #transitionUntil = -Infinity;
  #stoppedAt: number | null = null; #reason: 'manual' | 'time-limit' | null = null;
  #summary = emptySummary(); #byPage = new Map<PerformancePage, Summary>();
  #frames = ring<Sample>(300); #slowFrames = ring<Sample>(120); #longTasks = ring<Sample>(120);
  #longTaskCount = 0;
  constructor(startedAt: number, page: string) { this.startedAt = startedAt; this.#page = pages.has(page) ? page as PerformancePage : 'unknown'; }
  get active() { return this.#stoppedAt === null; }
  setPage(page: string, at: number) {
    const next = pages.has(page) ? page as PerformancePage : 'unknown';
    if (next === this.#page) return;
    this.#page = next; this.#transitionStarted = at; this.#transitionUntil = at + 200;
  }
  setForeground(foreground: boolean, at: number) {
    if (foreground === (this.#foregroundSince !== null)) return;
    this.#foregroundSince = foreground ? at : null; this.#previousFrame = null;
  }
  expired(at: number) { return at >= this.startedAt + PERFORMANCE_RECORDING_MS; }
  stop(at: number, reason: 'manual' | 'time-limit' = 'manual') {
    if (!this.active) return;
    this.#stoppedAt = Math.max(this.startedAt, Math.min(at, this.startedAt + PERFORMANCE_RECORDING_MS));
    this.#reason = this.expired(at) ? 'time-limit' : reason;
  }
  frame(at: number) {
    if (!this.active || !Number.isFinite(at) || at < this.startedAt) return;
    if (this.expired(at)) { this.stop(at, 'time-limit'); return; }
    if (this.#foregroundSince === null) { this.#previousFrame = null; return; }
    const previous = this.#previousFrame; this.#previousFrame = at;
    if (previous === null || at <= previous) return;
    const sample = this.#sample(previous, at - previous);
    this.#frames.push(sample);
    if (sample.durationMs > 50) this.#slowFrames.push(sample);
    const pageSummary = this.#byPage.get(this.#page) ?? emptySummary();
    for (const summary of [this.#summary, pageSummary]) {
      summary.frames++; summary.totalFrameMs += sample.durationMs;
      summary.longestFrameMs = Math.max(summary.longestFrameMs, sample.durationMs);
      if (sample.durationMs > 50) { summary.framesOver50Ms++; if (sample.transition) summary.transitionFramesOver50Ms++; }
    }
    this.#byPage.set(this.#page, pageSummary);
  }
  longTask(at: number, duration: number) {
    if (!this.active || this.#foregroundSince === null || !Number.isFinite(at) || !Number.isFinite(duration) || duration < 0 || at < this.#foregroundSince || at + duration > this.startedAt + PERFORMANCE_RECORDING_MS) return;
    this.#longTaskCount++; this.#longTasks.push(this.#sample(at, duration));
  }
  #sample(at: number, duration: number): Sample { return { elapsedMs: rounded(at - this.startedAt), durationMs: rounded(duration), page: this.#page, transition: at <= this.#transitionUntil && at + duration >= this.#transitionStarted }; }
  report(at: number) {
    const summarize = (summary: Summary) => ({ frames: summary.frames, meanFrameMs: rounded(summary.frames ? summary.totalFrameMs / summary.frames : 0), longestFrameMs: summary.longestFrameMs, framesOver50Ms: summary.framesOver50Ms, transitionFramesOver50Ms: summary.transitionFramesOver50Ms });
    return { format: 'tilian-performance-v1', elapsedMs: rounded(Math.max(0, Math.min((this.#stoppedAt ?? at) - this.startedAt, PERFORMANCE_RECORDING_MS))), limitMs: PERFORMANCE_RECORDING_MS,
      stopReason: this.#reason, foregroundOnly: true, summary: summarize(this.#summary), byPage: Object.fromEntries([...this.#byPage].map(([page, summary]) => [page, summarize(summary)])),
      longTaskCount: this.#longTaskCount, recentFrames: this.#frames.read(), slowFrames: this.#slowFrames.read(), longTasks: this.#longTasks.read() };
  }
}
