/**
 * The component barrel exposes every factory from one import path.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as components from '../../../src/ui/components/index';

describe('component barrel', () => {
  test('exports every component factory and the re-exported shared primitives', () => {
    const expected = [
      'createButton',
      'createIconButton',
      'setButtonBusy',
      'setButtonLabel',
      'setButtonPressed',
      'attachTooltip',
      'setTooltip',
      'hideTooltip',
      'createSwitch',
      'createTextInput',
      'createTextarea',
      'createSelect',
      'createCheckbox',
      'createField',
      'createSegmentedControl',
      'createTabs',
      'createBadge',
      'createChip',
      'setChipSelected',
      'openPopover',
      'togglePopover',
      'closeAllPopovers',
      'openDialog',
      'closeAllDialogs',
      'computeFloatingPosition',
      'placeFloating',
      'openContextMenu',
      'closeContextMenu',
      'notify',
      'showToast',
      'createIcon',
    ];
    const exports = components as Record<string, unknown>;
    const missing = expected.filter((name) => typeof exports[name] !== 'function');
    assert.deepEqual(missing, []);
  });
});
