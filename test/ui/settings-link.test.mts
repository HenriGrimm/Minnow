/**
 * "Settings → …" hints in notification text → the Settings page they name.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findSettingsLink } from '../../src/ui/settings-link.ts';

describe('findSettingsLink', () => {
  it('opens the section a message names', () => {
    assert.deepEqual(
      findSettingsLink('Cannot reach providers (Cursor Agent, DeepSeek). Check Settings → Providers.'),
      { section: 'providers', label: 'Settings → Providers' },
    );
  });

  it('prefers the deepest named section', () => {
    assert.equal(findSettingsLink('adjust timeouts in Settings → Agents → Watchdog.')?.section, 'watchdog');
    assert.equal(findSettingsLink('Turn on Two-way mirror in Settings → Issues → GitHub')?.section, 'github');
    assert.equal(findSettingsLink('set its path in Settings → Tools → Browser.')?.section, 'browser');
    assert.equal(findSettingsLink('Settings → General → Filesystem access (dangerous)')?.section, 'access');
  });

  it('ignores trailing prose and falls back to a known parent', () => {
    assert.deepEqual(
      findSettingsLink('Select Tavily in Settings → Tools for headless mode.'),
      { section: 'tools', label: 'Settings → Tools' },
    );
    assert.deepEqual(
      findSettingsLink('Pick one in Settings → Agents → Something new'),
      { section: 'agent-center', label: 'Settings → Agents' },
    );
  });

  it('returns null when no known section is named', () => {
    assert.equal(findSettingsLink('Restore it in Settings → Apps.'), null);
    assert.equal(findSettingsLink('Push rejected'), null);
    assert.equal(findSettingsLink(undefined), null);
  });
});
