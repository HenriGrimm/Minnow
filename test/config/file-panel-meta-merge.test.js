/**
 * mergeConfigMeta filePanel block — preview browser + viewer tab persistence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfigMeta } from '../../server/config/validators.js';

test('mergeConfigMeta persists preview browser fields', () => {
  const merged = mergeConfigMeta(
    { filePanel: { viewerOpen: false, splitRatio: 0.55 } },
    {
      filePanel: {
        viewerOpen: true,
        splitRatio: 0.08,
        rightPaneMode: 'preview',
        previewSource: { kind: 'url', url: 'https://example.com' },
        previewAutoReload: false,
        openViewerTabs: [],
        activeViewerTab: null,
      },
    },
  );
  const panel = /** @type {Record<string, unknown>} */ (merged.filePanel);
  assert.equal(panel.viewerOpen, true);
  assert.equal(panel.splitRatio, 0.08);
  assert.equal(panel.rightPaneMode, 'preview');
  assert.deepEqual(panel.previewSource, { kind: 'url', url: 'https://example.com' });
  assert.equal(panel.previewAutoReload, false);
  assert.deepEqual(panel.openViewerTabs, []);
  assert.equal(panel.activeViewerTab, null);
});

test('mergeConfigMeta persists preview DevTools dock position', () => {
  const merged = mergeConfigMeta(
    {},
    {
      filePanel: {
        previewDevToolsDock: 'side',
      },
    },
  );
  const panel = /** @type {Record<string, unknown>} */ (merged.filePanel);
  assert.equal(panel.previewDevToolsDock, 'side');
});

test('mergeConfigMeta persists preview DevTools popout dock position', () => {
  const merged = mergeConfigMeta(
    {},
    {
      filePanel: {
        previewDevToolsDock: 'popout',
      },
    },
  );
  const panel = /** @type {Record<string, unknown>} */ (merged.filePanel);
  assert.equal(panel.previewDevToolsDock, 'popout');
});

test('mergeConfigMeta persists workspace viewer tabs', () => {
  const merged = mergeConfigMeta(
    {},
    {
      filePanel: {
        viewerOpen: true,
        rightPaneMode: 'viewer',
        openViewerTabs: ['src/a.ts', 'src/b.ts'],
        activeViewerTab: 'src/a.ts',
      },
    },
  );
  const panel = /** @type {Record<string, unknown>} */ (merged.filePanel);
  assert.equal(panel.rightPaneMode, 'viewer');
  assert.deepEqual(panel.openViewerTabs, ['src/a.ts', 'src/b.ts']);
  assert.equal(panel.activeViewerTab, 'src/a.ts');
});

test('mergeConfigMeta filters attachment paths from openViewerTabs', () => {
  const merged = mergeConfigMeta(
    {},
    {
      filePanel: {
        openViewerTabs: ['src/index.ts', '.minnow/attachments/img.png'],
      },
    },
  );
  const panel = /** @type {Record<string, unknown>} */ (merged.filePanel);
  assert.deepEqual(panel.openViewerTabs, ['src/index.ts']);
});
