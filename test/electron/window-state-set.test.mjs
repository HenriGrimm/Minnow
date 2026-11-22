import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWindowSet,
  selectRestorableWindows,
} from '../../electron/window-state-schema.ts';

describe('window-state v1 → v2', () => {
  test('reads a v1 blob as one unnamed window, keeping its geometry', () => {
    const set = parseWindowSet({ width: 1600, height: 900, x: 40, y: 20, isMaximized: true });
    assert.equal(set.version, 2);
    assert.equal(set.windows.length, 1);
    assert.deepEqual(set.windows[0], {
      width: 1600,
      height: 900,
      x: 40,
      y: 20,
      isMaximized: true,
      workspacePath: '',
      hidden: false,
    });
  });

  test('round-trips a multi-window v2 set', () => {
    const raw = {
      version: 2,
      windows: [
        { width: 1280, height: 800, x: 0, y: 0, workspacePath: '/repo/a' },
        { width: 1000, height: 700, x: 100, y: 50, workspacePath: '/repo/b', isMaximized: true },
      ],
    };
    const set = parseWindowSet(raw);
    assert.equal(set.windows.length, 2);
    assert.equal(set.windows[0].workspacePath, '/repo/a');
    assert.equal(set.windows[1].workspacePath, '/repo/b');
    assert.equal(set.windows[1].isMaximized, true);
  });

  test('falls back to one default window for junk, empty sets, and nothing at all', () => {
    for (const raw of [null, undefined, 'nope', { version: 2, windows: [] }]) {
      const set = parseWindowSet(raw);
      assert.equal(set.version, 2);
      assert.equal(set.windows.length, 1);
      assert.equal(set.windows[0].width, 1280);
      assert.equal(set.windows[0].height, 800);
    }
  });

  test('repairs a window entry with unusable dimensions', () => {
    const set = parseWindowSet({
      version: 2,
      windows: [{ width: 'wide', height: 0, workspacePath: 42 }],
    });
    assert.equal(set.windows[0].width, 1280);
    assert.equal(set.windows[0].height, 800);
    assert.equal(set.windows[0].workspacePath, '');
  });

  test('restores Source Control only for the workspace window that saved it', () => {
    const { windows } = parseWindowSet({ version: 2, windows: [
      { workspacePath: '/repo/a', route: '#/app/source-control' },
      { workspacePath: '/repo/b', route: '#/app/code/chat' },
      { workspacePath: '', route: '#/app/source-control' },
    ] });
    assert.deepEqual(windows.map(({ route }) => route), ['#/app/source-control', undefined, undefined]);
  });
});

// A window hidden to the tray is deliberately not restored: leaving those in
// made every folder ever opened come back on the next launch.
describe('selectRestorableWindows', () => {
  test('drops windows that were kept in the background', () => {
    const kept = selectRestorableWindows([
      { width: 1, height: 1, workspacePath: '/repo/a' },
      { width: 1, height: 1, workspacePath: '/repo/b', hidden: true },
      { width: 1, height: 1, workspacePath: '/repo/c', hidden: false },
    ]);
    assert.deepEqual(
      kept.map((entry) => entry.workspacePath),
      ['/repo/a', '/repo/c'],
    );
  });

  test('returns nothing when every window was backgrounded', () => {
    const kept = selectRestorableWindows([
      { width: 1, height: 1, workspacePath: '/repo/a', hidden: true },
    ]);
    assert.equal(kept.length, 0);
  });

  test('round-trips the hidden flag through parseWindowSet', () => {
    const set = parseWindowSet({
      version: 2,
      windows: [
        { width: 1, height: 1, workspacePath: '/repo/a', hidden: true },
        { width: 1, height: 1, workspacePath: '/repo/b' },
      ],
    });
    assert.equal(set.windows[0].hidden, true);
    assert.equal(set.windows[1].hidden, false);
    assert.equal(selectRestorableWindows(set.windows).length, 1);
  });
});
