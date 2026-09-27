import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeBytes, runtimeTransferPercent } from '../../src/renderer/runtime-presentation';

test('runtime space displays measured zero and unknown distinctly without invented estimates', () => {
  assert.equal(runtimeBytes(0), '0 B');
  assert.equal(runtimeBytes(1024 ** 2 * 25.3), '25.3 MiB');
  assert.equal(runtimeBytes(null), '尚未测量');
  assert.equal(runtimeBytes(undefined), '尚未测量');
  assert.equal(runtimeBytes(Number.NaN), '尚未测量');
  assert.equal(runtimeBytes(-1), '尚未测量');
});

test('runtime percentage describes only a known transfer, never overall installation completion', () => {
  const base = { language: 'python' as const, receivedBytes: 25, totalBytes: 100 };
  assert.equal(runtimeTransferPercent({ ...base, phase: 'download' }), 25);
  assert.equal(runtimeTransferPercent({ ...base, phase: 'copy', receivedBytes: 125 }), 100);
  assert.equal(runtimeTransferPercent({ ...base, phase: 'verify' }), undefined);
  assert.equal(runtimeTransferPercent({ ...base, phase: 'commit' }), undefined);
  assert.equal(runtimeTransferPercent({ ...base, phase: 'download', totalBytes: 0 }), undefined);
  assert.equal(runtimeTransferPercent({ ...base, phase: 'download', receivedBytes: Number.NaN }), undefined);
  assert.equal(runtimeTransferPercent({ ...base, phase: 'download', receivedBytes: -1 }), undefined);
  assert.equal(runtimeTransferPercent(null), undefined);
});
