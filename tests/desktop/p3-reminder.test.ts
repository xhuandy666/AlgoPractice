import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReminderService, localClock } from '../../src/desktop/reminder-service';
import { REMINDER_STATE_FILE, type ReviewNotification } from '../../src/shared/maintenance';
async function fixture(t: test.TestContext, initial = '2026-09-08T11:59:00Z') {
  const directory = await mkdtemp(join(tmpdir(), 'p3-reminder-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date(initial), timeZone = 'Asia/Shanghai', count = 3, opened = 0;
  const messages: ReviewNotification[] = [], dismissed: string[] = [];
  const options = { directory, timeZone: () => timeZone, dueCount: () => count, now: () => now,
    notifier: { notify: (message: ReviewNotification) => { messages.push(message); }, dismiss: (id: string) => { dismissed.push(id); } }, onNavigateQueue: () => { opened++; } };
  const service = new ReminderService(options); t.after(() => service.stop());
  return { directory, options, service, messages, dismissed, setTime: (value: string) => { now = new Date(value); }, setZone: (value: string) => { timeZone = value; }, setCount: (value: number) => { count = value; }, opened: () => opened };
}
test('20:00 aggregates once, persists its claim across restart and ignores stale clicks', async t => {
  const f = await fixture(t); await f.service.start(false); assert.equal(f.messages.length, 0);
  f.setTime('2026-09-08T12:00:00Z'); await Promise.all([f.service.tick(), f.service.tick()]); assert.equal(f.messages.length, 1); assert.equal(f.messages[0].dueCount, 3);
  f.messages[0].onClick(); assert.equal(f.opened(), 1);
  f.service.stop(); f.messages[0].onClick(); assert.equal(f.opened(), 1);
  const restarted = new ReminderService(f.options); t.after(() => restarted.stop()); await restarted.start(false); await restarted.tick(); assert.equal(f.messages.length, 1);
});
test('fully quit delivers nothing; startup marks a missed reminder overdue without a burst', async t => {
  const f = await fixture(t); await f.service.start(false); f.service.stop(); f.setTime('2026-09-08T12:30:00Z'); await f.service.tick(); assert.equal(f.messages.length, 0);
  const restarted = new ReminderService(f.options); t.after(() => restarted.stop()); assert.equal((await restarted.start(false)).phase, 'overdue'); await restarted.tick(); assert.equal(f.messages.length, 0);
  f.setTime('2026-09-09T12:00:00Z'); await restarted.tick(); assert.equal(f.messages.length, 1);
});
test('resume catches missed scheduled time while running; quiet hours defer to morning once', async t => {
  const f = await fixture(t); await f.service.start(false); f.setTime('2026-09-08T15:00:00Z'); assert.equal((await f.service.tick('resume')).phase, 'quiet'); assert.equal(f.messages.length, 0);
  f.setTime('2026-09-08T23:59:00Z'); await f.service.tick(); assert.equal(f.messages.length, 0);
  f.setTime('2026-09-09T00:00:00Z'); await f.service.tick('resume'); assert.equal(f.messages.length, 1);
  f.setTime('2026-09-09T12:00:00Z'); await f.service.tick(); assert.equal(f.messages.length, 1);
});
test('30-minute snooze survives restart, respects quiet hours, and invalidates empty queues', async t => {
  const f = await fixture(t, '2026-09-08T13:40:00Z'); await f.service.start(false); const state = await f.service.snooze(); assert.equal(state.snoozedUntil, '2026-09-08T14:10:00.000Z');
  f.service.stop(); f.setTime('2026-09-08T13:50:00Z'); const restarted = new ReminderService(f.options); t.after(() => restarted.stop()); await restarted.start(false);
  f.setTime('2026-09-08T14:10:00Z'); assert.equal((await restarted.tick()).phase, 'quiet'); assert.equal(f.messages.length, 0);
  f.setTime('2026-09-09T00:00:00Z'); await restarted.tick(); assert.equal(f.messages.length, 1);
  await restarted.snooze(); f.setCount(0); await restarted.tick(); assert.equal(restarted.status().snoozedUntil, null);
  f.setTime('2026-09-09T00:31:00Z'); await restarted.tick(); assert.equal(f.messages.length, 1); f.messages[0].onClick(); assert.equal(f.opened(), 0);
});
test('snooze delays the regular slot and time-zone changes cannot repeat the same local day', async t => {
  const f = await fixture(t, '2026-09-08T11:50:00Z'); await f.service.start(false); await f.service.snooze();
  f.setTime('2026-09-08T12:00:00Z'); await f.service.tick(); assert.equal(f.messages.length, 0);
  f.setTime('2026-09-08T12:20:00Z'); await f.service.tick(); assert.equal(f.messages.length, 1);
  f.setZone('America/New_York'); f.setTime('2026-09-09T00:00:00Z'); await f.service.tick('settings'); assert.equal(f.messages.length, 1);
  f.setZone('Asia/Shanghai'); f.setTime('2026-09-08T12:30:00Z'); await f.service.tick('settings'); assert.equal(f.messages.length, 1);
});
test('notification errors remain visible with no automatic duplicate attempts', async t => {
  const f = await fixture(t); f.options.notifier.notify = message => { f.messages.push(message); throw new Error('notification permission denied'); };
  await f.service.start(false); f.setTime('2026-09-08T12:00:00Z'); const state = await f.service.tick(); assert.equal(state.phase, 'failed'); assert.match(state.lastError!, /permission denied/);
  await f.service.tick(); assert.equal(f.messages.length, 1);
  const restarted = new ReminderService(f.options); t.after(() => restarted.stop()); await restarted.start(false); assert.match(restarted.status().lastError!, /permission denied/); await restarted.tick(); assert.equal(f.messages.length, 1);
});
test('async OS failure and disabled settings cannot leave actionable stale notifications', async t => {
  const f = await fixture(t); await f.service.start(false); f.setTime('2026-09-08T12:00:00Z'); await f.service.tick(); f.messages[0].onFailure('system rejected delivery'); assert.equal(f.service.status().phase, 'failed');
  await f.service.updateSettings({ enabled: false }); f.messages[0].onClick(); assert.equal(f.opened(), 0); await f.service.tick(); assert.equal(f.messages.length, 1);
  await assert.rejects(f.service.updateSettings({ at: '25:00' }));
});
test('DST is computed from local calendar; malformed persistent ledger fails closed', async t => {
  assert.deepEqual(localClock(new Date('2026-03-08T07:00:00Z'), 'America/New_York'), { day: '2026-03-08', minute: 180 });
  const f = await fixture(t); await writeFile(join(f.directory, REMINDER_STATE_FILE), '{bad'); assert.throws(() => new ReminderService(f.options));
});
