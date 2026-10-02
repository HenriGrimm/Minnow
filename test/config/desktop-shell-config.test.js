import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_META } from '../../server/config/home.js';
import { mergeConfigMeta } from '../../server/config/validators.js';

describe('desktopShell config', () => {
  test('defaults closeToTray to true when missing', () => {
    const merged = mergeConfigMeta({}, {});
    assert.equal(merged.desktopShell?.closeToTray, undefined);
    const patched = mergeConfigMeta(merged, { desktopShell: {} });
    assert.equal(patched.desktopShell.closeToTray, true);
  });

  test('persists explicit closeToTray false', () => {
    const merged = mergeConfigMeta({}, { desktopShell: { closeToTray: false } });
    assert.equal(merged.desktopShell.closeToTray, false);
  });

  test('rejects non-boolean closeToTray values', () => {
    const merged = mergeConfigMeta({ desktopShell: { closeToTray: true } }, {
      desktopShell: { closeToTray: 'no' },
    });
    assert.equal(merged.desktopShell.closeToTray, true);
  });

  // The merge whitelists keys, so a value it does not know is silently dropped
  // and the setting never persists.
  test('round-trips windowCloseAction and rejects unknown answers', () => {
    for (const action of ['close', 'background', 'ask']) {
      const merged = mergeConfigMeta({}, { desktopShell: { windowCloseAction: action } });
      assert.equal(merged.desktopShell.windowCloseAction, action);
    }

    const kept = mergeConfigMeta(
      { desktopShell: { windowCloseAction: 'close' } },
      { desktopShell: { windowCloseAction: 'sometimes' } },
    );
    assert.equal(kept.desktopShell.windowCloseAction, 'close');

    // Survives an unrelated later write.
    const rewritten = mergeConfigMeta(kept, { desktopShell: { closeToTray: true } });
    assert.equal(rewritten.desktopShell.windowCloseAction, 'close');
  });

  test('defaults hardwareAcceleration to true when missing', () => {
    const merged = mergeConfigMeta({}, {});
    assert.equal(merged.desktopShell?.hardwareAcceleration, undefined);
    const patched = mergeConfigMeta(merged, { desktopShell: {} });
    assert.equal(patched.desktopShell.hardwareAcceleration, true);
  });

  test('round-trips explicit hardwareAcceleration false', () => {
    const merged = mergeConfigMeta({}, { desktopShell: { hardwareAcceleration: false } });
    assert.equal(merged.desktopShell.hardwareAcceleration, false);
    // Survives an unrelated later write (the whitelist drops unknown keys).
    const rewritten = mergeConfigMeta(merged, { desktopShell: { closeToTray: true } });
    assert.equal(rewritten.desktopShell.hardwareAcceleration, false);
    const reread = JSON.parse(JSON.stringify(rewritten));
    assert.equal(reread.desktopShell.hardwareAcceleration, false);
  });

  test('rejects non-boolean hardwareAcceleration values', () => {
    const merged = mergeConfigMeta({ desktopShell: { hardwareAcceleration: false } }, {
      desktopShell: { hardwareAcceleration: 'off' },
    });
    assert.equal(merged.desktopShell.hardwareAcceleration, false);
  });

  test('persists shell zoom percent within bounds', () => {
    const merged = mergeConfigMeta({}, { desktopShell: { zoomPercent: 80 } });
    assert.equal(merged.desktopShell.zoomPercent, 80);
  });

  test('defaults shell zoom percent to 100 for new homes', () => {
    assert.equal(DEFAULT_META.desktopShell?.zoomPercent, 100);
    const merged = mergeConfigMeta({}, { desktopShell: {} });
    assert.equal(merged.desktopShell.zoomPercent, 100);
  });

  test('rejects out-of-range shell zoom percent', () => {
    const merged = mergeConfigMeta({ desktopShell: { zoomPercent: 80 } }, {
      desktopShell: { zoomPercent: 25 },
    });
    assert.equal(merged.desktopShell.zoomPercent, 80);
  });
});
