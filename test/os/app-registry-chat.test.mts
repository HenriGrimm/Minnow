/**
 * Standalone Chat app was removed from the OS registry (workspace-first shell).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { APPS, isAppId } from '../../src/os/app-registry.ts';

describe('app-registry chat copy', () => {
  test('Code is the first launcher app and Dashboard is retired', () => {
    assert.equal(APPS[0].id, 'code');
    assert.equal(isAppId('home'), false);
  });
  test('chat is not a launcher app entry', () => {
    assert.equal(isAppId('chat'), false);
    assert.equal(APPS.some((app) => app.id === 'chat'), false);
  });
});
