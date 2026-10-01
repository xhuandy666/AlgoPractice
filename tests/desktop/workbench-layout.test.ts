import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateResultLayout, calculateWorkbenchLayout, clampPaneSize, preferenceFromSize, readWorkbenchPreferences, saveWorkbenchPreferences, splitterKeySize, SPLITTER_SIZE, WORKBENCH_DEFAULTS, WORKBENCH_LAYOUT_KEY } from '../../src/renderer/workbench-layout.ts';

test('wide workbench permits the AI/history pane to grow far beyond the old 320 px limit while preserving usable editor and statement', () => {
  const layout = calculateWorkbenchLayout(1600, true, true, { ...WORKBENCH_DEFAULTS, history: 60 });
  assert.equal(layout.mode, 'columns'); assert.equal(layout.sizes.history, 960);
  assert.ok(1600 - layout.sizes.statement - layout.sizes.history - SPLITTER_SIZE * 2 >= 320);
  assert.ok(layout.sizes.statement >= 220);
  const noStatement = calculateWorkbenchLayout(1000, false, true, { ...WORKBENCH_DEFAULTS, history: 60 });
  assert.equal(noStatement.sizes.history, 600); assert.ok(noStatement.columns.includes('600px'));
});

test('shrinking the window or expanding navigation clamps physical sizes without overwriting preferred proportions', () => {
  const preferences = { statement: 55, history: 60, results: 80 };
  for (const width of [1200, 1100, 900, 844]) {
    const layout = calculateWorkbenchLayout(width, true, true, preferences);
    assert.equal(layout.mode, 'columns');
    assert.ok(layout.sizes.history + layout.sizes.statement + SPLITTER_SIZE * 2 + 320 <= width + .01);
    assert.ok(layout.ranges.statement.min <= layout.ranges.statement.max);
  }
  assert.equal(calculateWorkbenchLayout(800, true, true, preferences).mode, 'history-stacked');
  assert.equal(calculateWorkbenchLayout(570, true, true, preferences).mode, 'stacked');
  assert.equal(calculateWorkbenchLayout(800, true, false, preferences).mode, 'columns');
  assert.equal(calculateWorkbenchLayout(640, false, true, preferences).mode, 'columns');
  assert.deepEqual(preferences, { statement: 55, history: 60, results: 80 });
});

test('result split accounts for wrapping toolbar and always reserves physical editor and result minima', () => {
  for (const toolbar of [54, 108, 162]) {
    const layout = calculateResultLayout(700, toolbar, 80);
    assert.equal(layout.span, 700 - toolbar - SPLITTER_SIZE);
    assert.ok(layout.size >= 120); assert.ok(layout.span - layout.size >= 180);
    assert.ok(layout.range.max > 300);
  }
  const small = calculateResultLayout(200, 100, 80);
  assert.ok(small.size > 0 && small.size < small.span); assert.ok(small.range.min <= small.range.max);
  for (const value of [NaN, Infinity, -100]) assert.ok(Number.isFinite(calculateResultLayout(value, value, 32).size));
});

test('all column visibility combinations stay within the measured content box throughout the resize range', () => {
  for (const statement of [true, false]) for (const history of [true, false]) for (let width = 400; width <= 2000; width += 8) {
    const layout = calculateWorkbenchLayout(width, statement, history, { statement: 55, history: 60, results: 80 });
    if (layout.mode === 'columns') {
      const occupied = (statement ? layout.sizes.statement + SPLITTER_SIZE : 0) + (history ? layout.sizes.history + SPLITTER_SIZE : 0);
      assert.ok(occupied <= width - 320, `${width}: statement=${statement} history=${history}`);
    }
  }
});

test('layout storage tolerates corrupt data, unavailable storage and newer or partial shapes', () => {
  for (const input of ['not json', 'null', '[]', '3', '"text"']) assert.deepEqual(readWorkbenchPreferences({ getItem: () => input }), WORKBENCH_DEFAULTS);
  assert.deepEqual(readWorkbenchPreferences({ getItem: () => { throw new Error('unavailable'); } }), WORKBENCH_DEFAULTS);
  assert.deepEqual(readWorkbenchPreferences({ getItem: () => '{"statement":-1,"history":999,"results":"72","extra":42}' }), { statement: 15, history: 60, results: 32 });
  assert.deepEqual(readWorkbenchPreferences({ getItem: () => '{"history":45}' }), { ...WORKBENCH_DEFAULTS, history: 45 });
  let stored = ''; saveWorkbenchPreferences({ setItem: (key, value) => { assert.equal(key, WORKBENCH_LAYOUT_KEY); stored = value; } }, { statement: 27, history: 55, results: 65 });
  assert.deepEqual(JSON.parse(stored), { statement: 27, history: 55, results: 65 });
  assert.doesNotThrow(() => saveWorkbenchPreferences({ setItem: () => { throw new Error('full'); } }, { ...WORKBENCH_DEFAULTS }));
});

test('saved layout uses proportions and does not carry obsolete absolute sizes to a different window', () => {
  assert.equal(preferenceFromSize('history', 550, 1000), 55);
  assert.equal(preferenceFromSize('results', 240, 600), 40);
  assert.equal(preferenceFromSize('history', 1000, 1000), 60);
  assert.equal(preferenceFromSize('statement', NaN, 0), 27);
  assert.equal(clampPaneSize(Infinity, { min: 100, max: 500 }), 100);
});

test('separator keys follow physical handle movement, honor bounds and offer Home, End and default reset', () => {
  const range = { min: 120, max: 800 };
  assert.equal(splitterKeySize('statement', 'ArrowRight', 300, range, 270), 324);
  assert.equal(splitterKeySize('history', 'ArrowRight', 300, range, 270), 276);
  assert.equal(splitterKeySize('history', 'ArrowLeft', 790, range, 270), 800);
  assert.equal(splitterKeySize('results', 'ArrowUp', 300, range, 270), 324);
  assert.equal(splitterKeySize('results', 'ArrowDown', 125, range, 270), 120);
  assert.equal(splitterKeySize('results', 'ArrowUp', 300, range, 270, true), 364);
  for (const side of ['statement', 'history', 'results'] as const) {
    assert.equal(splitterKeySize(side, 'Home', 300, range, 270), 120);
    assert.equal(splitterKeySize(side, 'End', 300, range, 270), 800);
    assert.equal(splitterKeySize(side, 'Enter', 300, range, 270), 270);
    assert.equal(splitterKeySize(side, 'Tab', 300, range, 270), null);
  }
});
