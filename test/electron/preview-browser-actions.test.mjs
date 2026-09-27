import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  clampPreviewZoomPercent,
  previewZoomPercentFromFactor,
  nextPreviewZoomPercent,
  getPreviewZoomPercent,
  setPreviewZoomPercent,
  clearPreviewCookies,
  clearPreviewCache,
} = await import('../../electron/dist/preview-browser-actions.js');

describe('preview browser actions', () => {
  test('clamps and steps page zoom through browser-style presets', () => {
    assert.equal(clampPreviewZoomPercent(5), 25);
    assert.equal(clampPreviewZoomPercent(700), 500);
    assert.equal(previewZoomPercentFromFactor(1.25), 125);
    assert.equal(nextPreviewZoomPercent(100, 'in'), 110);
    assert.equal(nextPreviewZoomPercent(100, 'out'), 90);
  });

  test('reads and writes zoom on the selected preview guest', () => {
    let factor = 1.1;
    const contents = {
      isDestroyed: () => false,
      getZoomFactor: () => factor,
      setZoomFactor: (next) => {
        factor = next;
      },
    };
    assert.equal(getPreviewZoomPercent(contents), 110);
    assert.equal(setPreviewZoomPercent(contents, 150), 150);
    assert.equal(factor, 1.5);
  });

  test('clears only the supplied preview session cookie and cache stores', async () => {
    const calls = [];
    const previewSession = {
      clearStorageData: async (options) => calls.push(['storage', options]),
      clearCache: async () => calls.push(['cache']),
    };
    await clearPreviewCookies(previewSession);
    await clearPreviewCache(previewSession);
    assert.deepEqual(calls, [
      ['storage', { storages: ['cookies'] }],
      ['cache'],
    ]);
  });
});
