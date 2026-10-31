import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildShellEditMenu } from '../../electron/shell-context-menu.ts';

const editFlags = {
  canUndo: true, canRedo: false, canCut: true, canCopy: true,
  canPaste: true, canSelectAll: true, canDelete: true, canEditRichly: false,
};

test('native editing actions follow Chromium capabilities', () => {
  const items = buildShellEditMenu({ isEditable: true, editFlags });
  assert.deepEqual(items.filter(item => item.role).map(item => [item.role, item.enabled]), [
    ['undo', true], ['redo', false], ['cut', true], ['copy', true], ['paste', true], ['selectAll', true],
  ]);
  const emptySelection = buildShellEditMenu({ isEditable: true, editFlags: {
    ...editFlags, canCut: false, canCopy: false, canPaste: false,
  } });
  for (const role of ['cut', 'copy', 'paste']) {
    assert.equal(emptySelection.find(item => item.role === role).enabled, false);
  }
});

test('read-only chat messages keep their renderer menu', () => {
  assert.deepEqual(buildShellEditMenu({ isEditable: false, editFlags }), []);
});
