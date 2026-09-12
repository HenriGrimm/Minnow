import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appWindowDenialReason,
  isAppWindowAllowed,
} from '../../electron/app-window-allowlist.ts';
import { APPS } from '../../src/os/app-registry.ts';
import { isAppWindowEligible } from '../../src/os/app-window.ts';

describe('isAppWindowAllowed', () => {
  test('main allows every app the rail offers a window for', () => {
    const offered = APPS.map((app) => app.id).filter((id) => isAppWindowEligible(id));
    assert.ok(offered.length > 0);
    for (const id of offered) {
      assert.equal(isAppWindowAllowed(id), true, `rail offers a window for "${id}" but main rejects it`);
    }
  });

  test('allows released apps except Code', () => {
    assert.equal(isAppWindowAllowed('source-control'), true);
    assert.equal(isAppWindowAllowed('issues'), true);
    assert.equal(isAppWindowAllowed('research'), true);
    assert.equal(isAppWindowAllowed('settings'), true);
    assert.equal(isAppWindowAllowed('code'), false);
    assert.equal(isAppWindowAllowed('experts'), false);
    assert.equal(isAppWindowAllowed(''), false);
    assert.equal(isAppWindowAllowed(null), false);
  });

  test('denial reasons name the problem', () => {
    assert.equal(appWindowDenialReason('code'), 'Code cannot open in a separate window');
    assert.match(appWindowDenialReason('experts'), /Unknown or hidden/);
    assert.equal(appWindowDenialReason(''), 'appId is required');
  });
});
