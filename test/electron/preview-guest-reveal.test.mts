/**
 * Main-process paint policy: navigate/activate must not restore lastBounds onto a hidden guest.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  resolvePreviewGuestAttachMode,
  showPreviewGuestIfHidden,
  shouldKeepPreviewGuestVisibleAfterCapture,
} from '../../electron/preview-guest-reveal.ts';

describe('resolvePreviewGuestAttachMode', () => {
  test('explicit show(bounds) paints even when the instance was hidden', () => {
    assert.equal(
      resolvePreviewGuestAttachMode({
        explicitBoundsValid: true,
        instanceAlreadyVisible: false,
      }),
      'paint',
    );
  });

  test('navigate/activate without bounds stays hidden when previously hidden', () => {
    assert.equal(
      resolvePreviewGuestAttachMode({
        explicitBoundsValid: false,
        instanceAlreadyVisible: false,
      }),
      'navigate-hidden',
    );
  });

  test('tab switch while already visible keeps painting (reuse lastBounds)', () => {
    assert.equal(
      resolvePreviewGuestAttachMode({
        explicitBoundsValid: false,
        instanceAlreadyVisible: true,
      }),
      'paint',
    );
  });
});

describe('shouldKeepPreviewGuestVisibleAfterCapture', () => {
  test('re-hides after capture when the instance was not previously visible', () => {
    assert.equal(shouldKeepPreviewGuestVisibleAfterCapture(false), false);
  });

  test('leaves the guest painted after capture when it was already visible', () => {
    assert.equal(shouldKeepPreviewGuestVisibleAfterCapture(true), true);
  });
});

test('layout sync and reload completion do not show an already visible guest again', () => {
  const calls: boolean[] = [];
  const entry = { visible: false, view: { setVisible: (visible: boolean) => calls.push(visible) } };
  showPreviewGuestIfHidden(entry);
  showPreviewGuestIfHidden(entry);
  showPreviewGuestIfHidden(entry);
  assert.deepEqual(calls, [true]);
  entry.view.setVisible(false);
  entry.visible = false;
  showPreviewGuestIfHidden(entry);
  assert.deepEqual(calls, [true, false, true], 'hidden guests must still be revealed');
});
