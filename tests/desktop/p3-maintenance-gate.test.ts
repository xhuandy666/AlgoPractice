import test from 'node:test';
import assert from 'node:assert/strict';
import { MaintenanceGate } from '../../src/desktop/maintenance-gate.ts';

test('restore preparation permits pending drafts, blocks new work and waits for already accepted writes', async () => {
  const gate = new MaintenanceGate(); let complete!: () => void, committed = false;
  const previous = gate.run('import:finish', () => new Promise<void>(resolve => { complete = () => { committed = true; resolve(); }; }));
  await Promise.resolve();
  gate.beginFlush();
  await assert.rejects(gate.run('runner:run', () => {}), /正在恢复/);
  await gate.run('draft:save', () => {});
  await gate.run('note:save', () => {});
  await gate.run('interview:save', () => {});
  let drained = false; const drain = gate.lockAndDrain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  await assert.rejects(gate.run('draft:save', () => {}), /正在恢复/);
  await assert.rejects(gate.run('interview:save', () => {}), /正在恢复/);
  complete(); await previous; await drain; assert.equal(committed, true); assert.equal(drained, true);
  gate.release(); assert.equal(await gate.run('runner:run', () => 1), 1);
});

test('failed accepted operations do not block rollback and the restore IPC does not wait on itself', async () => {
  const gate = new MaintenanceGate();
  await assert.rejects(gate.run('note:save', () => { throw new Error('disk full'); }), /disk full/);
  await gate.run('backup:restore', async () => {
    gate.beginFlush(); assert.throws(() => gate.beginFlush(), /已有/);
    await gate.lockAndDrain(); gate.release();
  });
  assert.equal(gate.phase, 'idle');
});
