/**
 * Standalone Chat app was removed from the OS registry (workspace-first shell).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { APPS, getAppById } from '../../src/os/app-registry.ts';

describe('app-registry chat copy', () => {
  test('Code is the first launcher app and Dashboard retains its home id', () => {
    assert.deepEqual(APPS.slice(0, 2).map(app => app.id), ['code', 'home']);
    assert.equal(getAppById('home')?.name, 'Dashboard');
  });
  test('chat is not a launcher app entry', () => {
    assert.equal(getAppById('chat'), undefined);
    assert.equal(APPS.some((app) => app.id === 'chat'), false);
  });
});
