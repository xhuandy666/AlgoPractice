import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CRASH_WINDOW_MS, MAX_RELOADS_IN_WINDOW, RendererRecovery } from '../../src/desktop/renderer-recovery.ts';

const running = { quitting: false, windowDestroyed: false, maintenance: false };

test('a crashed page is reloaded with a notice; quitting or a destroyed window never reloads', () => {
  const recovery = new RendererRecovery();
  assert.deepEqual(recovery.gone(running), { action: 'reload', notice: true });
  assert.deepEqual(recovery.gone({ ...running, quitting: true }), { action: 'quit' });
  assert.deepEqual(recovery.gone({ ...running, windowDestroyed: true }), { action: 'ignore' });
  assert.deepEqual(recovery.gone({ ...running, quitting: true, windowDestroyed: true }), { action: 'quit' }, 'quitting wins: finish the quit');
});

test('during a restore the reload waits for the maintenance gate', () => {
  assert.deepEqual(new RendererRecovery().gone({ ...running, maintenance: true }), { action: 'wait', notice: true });
});

test('repeated crashes in a short time stop reloading until the user decides; old crashes age out', () => {
  let now = 1_000_000; const recovery = new RendererRecovery({ now: () => now });
  for (let i = 0; i < MAX_RELOADS_IN_WINDOW; i++) { assert.equal(recovery.gone(running).action, 'reload', `crash ${i + 1}`); now += 1000; }
  assert.deepEqual(recovery.gone(running), { action: 'ask' });
  assert.deepEqual(recovery.gone(running), { action: 'ask' }, 'still asking while the crashes are recent');
  now += CRASH_WINDOW_MS;
  assert.deepEqual(recovery.gone(running), { action: 'reload', notice: true }, 'a crash long after the burst is reloaded again');
});

test('a reload the user asked for (unresponsive page) needs no notice and does not count as a crash', () => {
  const recovery = new RendererRecovery({ now: () => 5 });
  for (let i = 0; i < MAX_RELOADS_IN_WINDOW * 2; i++) { recovery.expectReload(); assert.deepEqual(recovery.gone(running), { action: 'reload', notice: false }); }
  assert.deepEqual(recovery.gone(running), { action: 'reload', notice: true }, 'the expectation is used up by one event');
  recovery.expectReload(); assert.deepEqual(recovery.gone({ ...running, maintenance: true }), { action: 'wait', notice: false });
  recovery.expectReload(); assert.deepEqual(recovery.gone({ ...running, quitting: true }), { action: 'quit' });
  assert.deepEqual(recovery.gone(running), { action: 'reload', notice: true }, 'a quit consumed the expectation');
});
