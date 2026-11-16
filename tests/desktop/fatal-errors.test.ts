import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFatalErrorHandlers, errorCategory, FATAL_EXIT_DEADLINE_MS } from '../../src/desktop/fatal-errors.ts';
import { createLogger } from '../../src/desktop/logger.ts';

function harness(overrides: { quit?: () => void; log?: (event: string) => void } = {}) {
  const events: { event: string; fields: Record<string, unknown> }[] = [], calls: string[] = [], timers: { callback: () => void; ms: number }[] = [];
  const handlers = createFatalErrorHandlers({
    log: (event, fields) => { overrides.log?.(event); events.push({ event, fields }); },
    quit: () => { calls.push('quit'); overrides.quit?.(); },
    exit: code => { calls.push(`exit:${code}`); },
    setTimer: (callback, ms) => { timers.push({ callback, ms }); },
  });
  return { handlers, events, calls, timers };
}

test('categories keep the class and code but never the message', () => {
  assert.equal(errorCategory(new TypeError('secret code: print(password)')), 'TypeError');
  assert.equal(errorCategory(Object.assign(new Error('/home/me/secret'), { code: 'ENOENT' })), 'Error:ENOENT');
  assert.equal(errorCategory(Object.assign(new Error('x'), { name: 'Bad name with spaces' })), 'Error');
  assert.equal(errorCategory('sk-secret string'), 'string');
  assert.equal(errorCategory(null), 'null'); assert.equal(errorCategory(undefined), 'undefined');
});

test('an uncaught exception arms the watchdog before starting the normal quit, exactly once', () => {
  const { handlers, events, calls, timers } = harness();
  assert.equal(handlers.fatal, false);
  handlers.uncaughtException(new RangeError('private detail'), 'uncaughtException');
  assert.equal(handlers.fatal, true); assert.deepEqual(calls, ['quit']);
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, FATAL_EXIT_DEADLINE_MS);
  assert.deepEqual(events, [{ event: 'main.uncaught', fields: { category: 'RangeError', operation: 'uncaughtException' } }]);
  handlers.uncaughtException(new Error('during shutdown'));
  assert.deepEqual(calls, ['quit'], 'a second error during the shutdown does not restart it');
  assert.equal(timers.length, 1);
  assert.equal(events.at(-1)!.event, 'main.uncaught-again');
  timers[0].callback();
  assert.deepEqual(calls, ['quit', 'exit:1'], 'the watchdog ends a quit that never finishes');
  assert.equal(events.at(-1)!.event, 'main.exit-forced');
  assert.ok(!JSON.stringify(events).includes('private'));
});

test('once the normal quit finished, the watchdog no longer ends the process', () => {
  const { handlers, calls, timers, events } = harness();
  handlers.uncaughtException(new Error('boom'));
  handlers.settled();
  timers[0].callback();
  assert.deepEqual(calls, ['quit'], 'the reopen dialog and a relaunch are not cut short');
  assert.ok(!events.some(entry => entry.event === 'main.exit-forced'));
});

test('a quit that cannot start ends the process at once', () => {
  const { handlers, calls, events } = harness({ quit: () => { throw new Error('app not ready'); } });
  handlers.uncaughtException(new Error('early'));
  assert.deepEqual(calls, ['quit', 'exit:1']); assert.deepEqual(events.map(entry => entry.event), ['main.uncaught', 'main.quit-failed']);
});

test('a failing logger never stops the shutdown', () => {
  const { handlers, calls } = harness({ log: () => { throw new Error('disk full'); } });
  handlers.uncaughtException(new Error('boom'));
  assert.deepEqual(calls, ['quit']);
});

test('an unhandled rejection is logged only', () => {
  const { handlers, calls, timers, events } = harness();
  handlers.unhandledRejection(new TypeError('fire-and-forget task failed'));
  handlers.unhandledRejection('plain reason');
  assert.equal(handlers.fatal, false); assert.deepEqual(calls, []); assert.equal(timers.length, 0);
  assert.deepEqual(events.map(entry => entry.fields.category), ['TypeError', 'string']);
});

test('the operational logger keeps the fields these events use', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fatal-log-'));
  try {
    const handlers = createFatalErrorHandlers({ log: createLogger(directory), quit: () => {}, exit: () => {}, setTimer: () => {} });
    handlers.uncaughtException(Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR' }), 'uncaughtException');
    handlers.unhandledRejection(new TypeError('y'));
    const entries = readFileSync(join(directory, 'application.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(entries.map(({ event, category, operation }) => ({ event, category, operation })), [
      { event: 'main.uncaught', category: 'Error:ERR_SQLITE_ERROR', operation: 'uncaughtException' },
      { event: 'main.unhandled-rejection', category: 'TypeError', operation: undefined },
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
