import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { practiceShortcutDirection, sidebarAfterNavigation } from '../../src/renderer/workbench-navigation.ts';

test('entering the workbench collapses once, leaving expands, and same-page actions preserve the choice', () => {
  assert.equal(sidebarAfterNavigation('library', 'workbench', false), true);
  assert.equal(sidebarAfterNavigation('workbench', 'workbench', false), false);
  assert.equal(sidebarAfterNavigation('workbench', 'workbench', true), true);
  assert.equal(sidebarAfterNavigation('workbench', 'reviews', true), false);
  assert.equal(sidebarAfterNavigation('today', 'library', true), true);
});

test('neighbor shortcuts do not steal text, dialog, composing, or repeated keyboard input', () => {
  const event = { key: 'ArrowRight', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, repeat: false, isComposing: false };
  assert.equal(practiceShortcutDirection(event, false, false), 'next');
  assert.equal(practiceShortcutDirection({ ...event, key: 'ArrowLeft' }, false, false), 'previous');
  assert.equal(practiceShortcutDirection(event, true, false), null);
  assert.equal(practiceShortcutDirection(event, false, true), null);
  for (const key of ['ctrlKey', 'metaKey', 'shiftKey', 'defaultPrevented', 'repeat', 'isComposing'] as const) {
    assert.equal(practiceShortcutDirection({ ...event, [key]: true }, false, false), null);
  }
  assert.equal(practiceShortcutDirection({ ...event, altKey: false }, false, false), null);
});
