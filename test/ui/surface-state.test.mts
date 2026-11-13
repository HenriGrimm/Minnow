import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activateSurfaceTab, closeSurfaceTab, getPanelTabs, getSurfacePanel, isPanelVisible,
  launcherPanelForKey, mergeSurfaceTabs, normalizeSurfaceState, openSurfaceTab, setPanelShown, splitSurfaceTabs, surfaceSize,
  toggleMaximizedPanel,
} from '../../src/ui/surfaces/surface-state';

test('a new thread starts closed and can show Browser beside Terminal', () => {
  const state = normalizeSurfaceState();
  assert.equal(isPanelVisible(state, 'side'), false);
  assert.equal(isPanelVisible(state, 'bottom'), false);

  openSurfaceTab(state, 'preview');
  openSurfaceTab(state, 'terminal');
  assert.equal(state.side.active, 'preview');
  assert.equal(state.bottom.active, 'terminal');
  assert.equal(isPanelVisible(state, 'side'), true);
  assert.equal(isPanelVisible(state, 'bottom'), true);
});

test('an explicit launcher moves an existing tab without duplicating it', () => {
  const state = normalizeSurfaceState();
  openSurfaceTab(state, 'preview');
  openSurfaceTab(state, 'files');
  openSurfaceTab(state, 'files', 'bottom');
  assert.deepEqual(getPanelTabs(state, 'side'), ['preview']);
  assert.deepEqual(getPanelTabs(state, 'bottom'), ['files']);
  assert.equal(state.side.active, 'preview');
  assert.equal(state.bottom.active, 'files');

  openSurfaceTab(state, 'preview', 'bottom');
  assert.equal(isPanelVisible(state, 'side'), false);
  assert.deepEqual(getPanelTabs(state, 'bottom'), ['preview', 'files']);
  closeSurfaceTab(state, 'preview');
  assert.equal(state.bottom.active, 'files');
  closeSurfaceTab(state, 'files');
  assert.equal(state.bottom.active, 'launch');
  assert.equal(isPanelVisible(state, 'bottom'), true);

  openSurfaceTab(state, 'preview');
  assert.equal(getSurfacePanel(state, 'preview'), 'bottom');
});

test('maximizing hides other visible panels without closing their tabs', () => {
  const state = normalizeSurfaceState();
  openSurfaceTab(state, 'preview');
  openSurfaceTab(state, 'terminal');
  toggleMaximizedPanel(state, 'bottom');
  assert.equal(isPanelVisible(state, 'side'), false);
  assert.equal(state.side.shown, true);
  assert.equal(isPanelVisible(state, 'bottom'), true);

  openSurfaceTab(state, 'preview');
  assert.equal(state.maximized, null);
  assert.equal(isPanelVisible(state, 'bottom'), true);
  toggleMaximizedPanel(state, 'side');
  setPanelShown(state, 'side', false);
  assert.equal(state.maximized, null);
});

test('letter keys target the most recent visible launcher', () => {
  const state = normalizeSurfaceState();
  assert.equal(launcherPanelForKey(state), undefined);
  activateSurfaceTab(state, 'side', 'launch');
  activateSurfaceTab(state, 'bottom', 'launch');
  assert.equal(launcherPanelForKey(state), 'bottom');
  openSurfaceTab(state, 'files', 'bottom');
  assert.equal(launcherPanelForKey(state), 'side');
  setPanelShown(state, 'side', false);
  assert.equal(launcherPanelForKey(state), undefined);
});

test('saved preferences normalize legacy, corrupt and duplicate values', () => {
  const state = normalizeSurfaceState({
    open: ['preview', 'terminal', 'terminal', 'future', null],
    panelOf: { preview: 'bottom', terminal: 'unknown', future: 'side' },
    side: { shown: false, active: 'terminal' },
    bottom: { shown: true, active: 'missing' },
    maximized: 'side',
  });
  assert.deepEqual(state.open, ['preview', 'terminal']);
  assert.equal(state.side.active, 'launch');
  assert.equal(state.bottom.active, 'launch');
  assert.equal(state.maximized, null);
  assert.equal(getSurfacePanel(state, 'preview'), 'bottom');
  assert.deepEqual(normalizeSurfaceState(JSON.parse(JSON.stringify(state))), state);
  assert.notDeepEqual(normalizeSurfaceState(), state);
});

test('panel sizing preserves defaults and fits the visible thread', () => {
  assert.equal(surfaceSize('side', undefined), 440);
  assert.equal(surfaceSize('bottom', Infinity), 320);
  assert.equal(surfaceSize('bottom', 300, 120), 120);
  assert.equal(surfaceSize('side', 1000), 1000);
  assert.equal(surfaceSize('side', 1200, 1080), 1080);
  assert.equal(surfaceSize('side', 339), 340);
});

test('splitting and merging a dock retains its tabs and the other dock', () => {
  const state = normalizeSurfaceState();
  openSurfaceTab(state, 'terminal');
  splitSurfaceTabs(state, 'bottom', 'terminal');
  assert.equal(state.bottom.active, 'terminal');
  assert.equal(launcherPanelForKey(state), 'split');
  openSurfaceTab(state, 'file:notes.md', 'split');
  openSurfaceTab(state, 'changes');
  toggleMaximizedPanel(state, 'bottom');
  assert.equal(isPanelVisible(state, 'split'), true);
  assert.equal(isPanelVisible(state, 'side'), false);
  setPanelShown(state, 'bottom', false);
  assert.equal(isPanelVisible(state, 'split'), false);
  setPanelShown(state, 'bottom', true);
  activateSurfaceTab(state, 'split', 'file:notes.md');

  const restored = normalizeSurfaceState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored, state);
  assert.equal(mergeSurfaceTabs(restored), 'bottom');
  assert.deepEqual(getPanelTabs(restored, 'bottom'), ['terminal', 'file:notes.md']);
  assert.equal(restored.bottom.active, 'file:notes.md');
  assert.equal(restored.side.active, 'changes');
  assert.equal(isPanelVisible(restored, 'split'), false);
});

test('retired Brain and Phone tabs restore a remaining tab or close their panel', () => {
  const state = normalizeSurfaceState({
    open: ['brain', 'phone', 'side'],
    panelOf: { phone: 'bottom', side: 'side' },
    side: { shown: true, active: 'brain' },
    bottom: { shown: true, active: 'phone' },
    maximized: 'bottom',
  });
  assert.deepEqual(state.open, ['side']);
  assert.equal(state.side.active, 'side');
  assert.equal(isPanelVisible(state, 'side'), true);
  assert.equal(isPanelVisible(state, 'bottom'), false);
  assert.equal(state.maximized, null);
});
