import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  clampShellZoomPercent,
  macTrafficLightPosition,
  nextShellZoomPercent,
  shellZoomFactorFromPercent,
  shellZoomPercentFromFactor,
} from '../../electron/shell-zoom.ts';

describe('shell zoom helpers', () => {
  test('clampShellZoomPercent defaults invalid input to 100', () => {
    assert.equal(clampShellZoomPercent(undefined), 100);
    assert.equal(clampShellZoomPercent('80'), 100);
  });

  test('clampShellZoomPercent enforces 50–300', () => {
    assert.equal(clampShellZoomPercent(40), 50);
    assert.equal(clampShellZoomPercent(400), 300);
    assert.equal(clampShellZoomPercent(67), 67);
  });

  test('factor and percent round-trip', () => {
    assert.equal(shellZoomFactorFromPercent(80), 0.8);
    assert.equal(shellZoomPercentFromFactor(0.8), 80);
  });
});

describe('nextShellZoomPercent', () => {
  test('zooming in snaps to the next preset', () => {
    assert.equal(nextShellZoomPercent(80, 'in'), 90);
    assert.equal(nextShellZoomPercent(90, 'in'), 100);
  });

  test('zooming in from a non-preset value snaps to the next preset', () => {
    assert.equal(nextShellZoomPercent(72, 'in'), 75);
  });

  test('zooming in clamps at the max', () => {
    assert.equal(nextShellZoomPercent(200, 'in'), 300);
    assert.equal(nextShellZoomPercent(300, 'in'), 300);
  });

  test('zooming out snaps to the previous preset', () => {
    assert.equal(nextShellZoomPercent(80, 'out'), 75);
    assert.equal(nextShellZoomPercent(90, 'out'), 80);
    assert.equal(nextShellZoomPercent(67, 'out'), 50);
  });

  test('zooming out from a non-preset value snaps to the previous preset', () => {
    assert.equal(nextShellZoomPercent(72, 'out'), 67);
  });

  test('zooming out clamps at the min', () => {
    assert.equal(nextShellZoomPercent(50, 'out'), 50);
    assert.equal(nextShellZoomPercent(300, 'out'), 200);
  });
});

describe('macTrafficLightPosition', () => {
  test('centers the native buttons on the 46px menubar at 100%', () => {
    assert.deepEqual(macTrafficLightPosition(1), { x: 17, y: 15 });
  });

  test('follows the zoomed menubar center', () => {
    assert.equal(macTrafficLightPosition(0.9).y, 13);
    assert.equal(macTrafficLightPosition(1.25).y, 21);
    assert.equal(macTrafficLightPosition(0.5).y, 4);
  });

  test('invalid zoom falls back to 100%', () => {
    assert.deepEqual(macTrafficLightPosition(Number.NaN), { x: 17, y: 15 });
    assert.deepEqual(macTrafficLightPosition(0), { x: 17, y: 15 });
  });
});
