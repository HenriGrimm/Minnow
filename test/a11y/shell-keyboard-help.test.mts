/**
 * Global keyboard help catalog and typing-target guard.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  getVisibleKeyboardShortcuts,
  GLOBAL_KEYBOARD_SHORTCUTS,
} from '../../src/ui/shell-keyboard-help.ts';

describe('shell keyboard help', () => {
  test('visible catalog includes shell and chat shortcuts', () => {
    const sections = new Set(
      getVisibleKeyboardShortcuts().map((row) => row.section).filter(Boolean),
    );
    assert.ok(sections.has('Shell'));
    assert.ok(sections.has('Chat'));
    assert.ok(!sections.has('Orchestrate board'));
    assert.ok(sections.has('Issues'));
  });

  test('catalog omits cancelled Email and Calendar apps', () => {
    const visibleSections = new Set(
      getVisibleKeyboardShortcuts().map((row) => row.section).filter(Boolean),
    );
    const allSections = new Set(
      GLOBAL_KEYBOARD_SHORTCUTS.map((row) => row.section).filter(Boolean),
    );
    // Email/Calendar were removed, not gated — no leftover help rows.
    assert.ok(!visibleSections.has('Email'));
    assert.ok(!visibleSections.has('Calendar'));
    assert.ok(!allSections.has('Email'));
    assert.ok(!allSections.has('Calendar'));
  });

  test('catalog documents question mark shortcut', () => {
    const helpRow = GLOBAL_KEYBOARD_SHORTCUTS.find((row) => row.keys === '?');
    assert.ok(helpRow);
    assert.match(helpRow?.label ?? '', /shortcut/i);
  });
});
