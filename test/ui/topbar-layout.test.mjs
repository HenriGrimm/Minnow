import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const fixture = JSON.parse(
  readFileSync(join(root, 'test/fixtures/feature01/topbar-zones.json'), 'utf8'),
);

/** Slice of index.html between two markers (exclusive of closing tag of first marker). */
function sliceBetween(htmlText, startMarker, endMarker) {
  const start = htmlText.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const from = start + startMarker.length;
  const end = htmlText.indexOf(endMarker, from);
  assert.ok(end >= 0, `missing ${endMarker} after ${startMarker}`);
  return htmlText.slice(from, end);
}

describe('topbar layout (feature-01)', () => {
  for (const zone of fixture.zones) {
    test(`T1: zone class ${zone}`, () => {
      assert.match(html, new RegExp(`class="${zone}"`));
    });
  }

  test(`T2: spacer class ${fixture.spacer}`, () => {
    assert.match(html, new RegExp(`class="${fixture.spacer}"`));
  });

  test('T3: topbar DOM order is brand, end, spacer, actions', () => {
    const header = sliceBetween(html, '<header class="topbar">', '</header>');
    const brandIdx = header.indexOf('class="topbar-brand"');
    const endIdx = header.indexOf('class="topbar-end"');
    const spacerIdx = header.indexOf(`class="${fixture.spacer}"`);
    const actionsIdx = header.indexOf('class="topbar-actions"');
    assert.ok(brandIdx >= 0 && endIdx > brandIdx && spacerIdx > endIdx && actionsIdx > spacerIdx);
  });

  test('T3b: action buttons live in topbar-actions after spacer', () => {
    const actionsBlock = sliceBetween(html, 'class="topbar-actions"', '</header>');
    for (const id of fixture.actionButtonIds) {
      assert.match(actionsBlock, new RegExp(`id="${id}"`));
    }
    assert.match(actionsBlock, new RegExp(`id="${fixture.workspacePathLabelId}"`));
    assert.match(actionsBlock, /class="workspace-control"/);
    const pathIdx = actionsBlock.indexOf(`id="${fixture.workspacePathLabelId}"`);
    const btnIdx = actionsBlock.indexOf('id="btnWorkspace"');
    assert.ok(pathIdx >= 0 && btnIdx >= 0 && pathIdx > btnIdx, 'workspace button precedes folder name');
    assert.doesNotMatch(actionsBlock, /class="model-wrap"/);
    assert.doesNotMatch(actionsBlock, /id="modelSelect"/);
  });

  test('T4–T5: model controls without a status pill inside topbar-end before spacer', () => {
    const endBlock = sliceBetween(html, 'class="topbar-end"', `class="${fixture.spacer}"`);
    for (const id of fixture.endIds) {
      assert.match(endBlock, new RegExp(`id="${id}"`));
    }
    assert.doesNotMatch(endBlock, /status-pill|id="sDot"|id="sText"/);
    assert.match(endBlock, /class="model-wrap"/);
    const refreshIdx = endBlock.indexOf('id="btnRefreshModels"');
    const selectIdx = endBlock.indexOf('id="modelSelectRoot"');
    assert.ok(refreshIdx >= 0 && selectIdx > refreshIdx, 'refresh precedes model select');
    assert.match(endBlock, /data-model-state/);
    assert.match(endBlock, /class="model-state-dot model-load-dot"/);
    assert.match(endBlock, /id="modelSelectTrigger"/);
    assert.match(endBlock, /id="modelSelectMenu"/);
  });

  for (const pattern of fixture.forbiddenPatterns) {
    test(`T6: forbidden pattern ${pattern}`, () => {
      assert.doesNotMatch(html, new RegExp(pattern));
    });
  }

  test('T7: btnNewChatTop removed', () => {
    assert.doesNotMatch(html, /id="btnNewChatTop"/);
  });

  test('T8: btnSidebarToggle has topbar-sidebar-toggle', () => {
    const tag = html.match(/<button[^>]*id="btnSidebarToggle"[^>]*>/);
    assert.ok(tag, 'btnSidebarToggle button');
    assert.match(tag[0], /topbar-sidebar-toggle/);
  });
});
