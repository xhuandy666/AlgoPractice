import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceRecorder, PERFORMANCE_RECORDING_MS } from '../../src/renderer/performance-recorder.ts';

test('performance recording ignores unfocused periods and distinguishes navigation frames', () => {
  const recorder = new PerformanceRecorder(0, 'workbench');
  recorder.setForeground(true, 0); recorder.frame(0); recorder.frame(16);
  recorder.setPage('library', 20); recorder.frame(110);
  recorder.setForeground(false, 120); recorder.frame(10000); recorder.longTask(120, 700);
  recorder.setForeground(true, 11000); recorder.frame(11000); recorder.frame(11016);
  recorder.longTask(10990, 100); recorder.longTask(11020, 80);
  const report = recorder.report(11100);
  assert.equal(report.summary.frames, 3);
  assert.equal(report.summary.longestFrameMs, 94);
  assert.equal(report.summary.framesOver50Ms, 1);
  assert.equal(report.summary.transitionFramesOver50Ms, 1);
  assert.equal(report.longTaskCount, 1);
  assert.equal(report.longTasks[0].durationMs, 80);
  assert.equal(report.byPage.library.frames, 2);
});

test('performance recording stops at 90 seconds, has bounded history and only exports allowed page names', () => {
  const recorder = new PerformanceRecorder(100, 'private-problem-title');
  recorder.setForeground(true, 100);
  for (let index = 0; index < 1300; index++) { recorder.frame(100 + index * 60); recorder.longTask(100 + index * 60, 55); }
  const before = recorder.report(79000);
  assert.equal(before.recentFrames.length, 300);
  assert.equal(before.slowFrames.length, 120);
  assert.equal(before.longTasks.length, 120);
  assert.equal(before.summary.frames, 1299);
  assert.equal(before.longTaskCount, 1300);
  assert.equal(before.recentFrames[0].elapsedMs, 999 * 60);
  assert.ok(!JSON.stringify(before).includes('private-problem-title'));
  recorder.frame(100 + PERFORMANCE_RECORDING_MS);
  assert.equal(recorder.active, false);
  recorder.frame(100 + PERFORMANCE_RECORDING_MS + 1000); recorder.longTask(100 + PERFORMANCE_RECORDING_MS, 500);
  const final = recorder.report(200000);
  assert.equal(final.elapsedMs, PERFORMANCE_RECORDING_MS);
  assert.equal(final.stopReason, 'time-limit');
  assert.equal(final.summary.frames, before.summary.frames);
  assert.equal(final.longTaskCount, before.longTaskCount);
});
