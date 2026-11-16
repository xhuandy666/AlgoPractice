// Errors that nothing caught in the main process.
//
// An uncaught exception leaves the main process in an unknown state. Electron's default handler shows the stack in a
// dialog and keeps running; instead the app leaves through the normal quit path, which lets the page save its drafts
// and stops runs, imports and AI requests, and a watchdog ends the process if that path cannot finish. Ending abruptly
// is safe: user code dies with its process-group guard, SQLite runs WAL with synchronous=FULL, and startup recovers
// interrupted runs, imports and restores.
//
// A rejected promise that nobody handled is only logged. Many tasks are fire-and-forget and report their own failures;
// exiting on them would turn a failed background task into lost work.
export const FATAL_EXIT_DEADLINE_MS = 15_000;

/** The error's class (and code) only. Messages can carry code, paths or credentials and are never logged. */
export function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return error === null ? 'null' : typeof error;
  const code = (error as NodeJS.ErrnoException).code, value = typeof code === 'string' && code ? `${error.name}:${code}` : error.name;
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : 'Error';
}

type LogFields = Record<string, string | number | boolean | null>;
export interface FatalErrorOptions {
  log(event: string, fields: LogFields): void;
  /** Starts the normal quit, which saves drafts and stops services. May throw (e.g. before the app is ready). */
  quit(): void;
  /** Ends the process at once. */
  exit(code: number): void;
  deadlineMs?: number;
  setTimer?(callback: () => void, ms: number): unknown;
}

export function createFatalErrorHandlers(options: FatalErrorOptions) {
  let fatal = false, settled = false;
  const log = (event: string, fields: LogFields) => { try { options.log(event, fields); } catch { /* Never throw from an error handler. */ } };
  const exit = (code: number) => { try { options.exit(code); } catch { process.exit(code); } };
  return {
    /** True once an uncaught exception started the shutdown. */
    get fatal() { return fatal; },
    /** The normal quit path finished: the watchdog must not end what comes after (the reopen dialog, a relaunch). */
    settled() { settled = true; },
    uncaughtException(error: unknown, origin?: string) {
      log(fatal ? 'main.uncaught-again' : 'main.uncaught', { category: errorCategory(error), operation: origin ?? null });
      if (fatal) return;
      fatal = true;
      // Armed first: whatever the quit path ends up waiting on, the process ends.
      (options.setTimer ?? setTimeout)(() => { if (settled) return; log('main.exit-forced', {}); exit(1); }, options.deadlineMs ?? FATAL_EXIT_DEADLINE_MS);
      try { options.quit(); } catch (quitError) { log('main.quit-failed', { category: errorCategory(quitError) }); exit(1); }
    },
    unhandledRejection(reason: unknown) { log('main.unhandled-rejection', { category: errorCategory(reason) }); },
  };
}
