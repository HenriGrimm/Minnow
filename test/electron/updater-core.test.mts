/**
 * Updater state machine (MIN-384): manual vs background failures, downloaded
 * updates never lost, channel/notes normalization.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createInitialUpdaterStatus,
  normalizeUpdaterChannel,
  reduceUpdaterStatus,
  releaseNotesToText,
  type UpdaterStatus,
} from '../../electron/updater-core.ts';

const NOW = 1_700_000_000_000;

function supportedStatus(): UpdaterStatus {
  return createInitialUpdaterStatus({
    supported: true,
    installedVersion: '1.0.0',
    channel: 'stable',
  });
}

describe('createInitialUpdaterStatus', () => {
  test('supported installs start idle', () => {
    const status = supportedStatus();
    assert.equal(status.state, 'idle');
    assert.equal(status.supported, true);
    assert.equal(status.unsupportedReason, null);
    assert.equal(status.lastCheckedAt, null);
  });

  test('unsupported installs carry a reason', () => {
    const status = createInitialUpdaterStatus({
      supported: false,
      unsupportedReason: 'macos-signing',
      installedVersion: '1.0.0',
      channel: 'beta',
    });
    assert.equal(status.state, 'unsupported');
    assert.equal(status.unsupportedReason, 'macos-signing');
    assert.equal(status.channel, 'beta');
  });
});

describe('reduceUpdaterStatus', () => {
  test('happy path: check → available → progress → downloaded', () => {
    let status = supportedStatus();
    status = reduceUpdaterStatus(status, { kind: 'check-started', manual: false, at: NOW });
    assert.equal(status.state, 'checking');

    status = reduceUpdaterStatus(status, {
      kind: 'update-available',
      version: '1.1.0',
      notes: '- Security fix',
      at: NOW,
    });
    assert.equal(status.state, 'downloading');
    assert.equal(status.pendingVersion, '1.1.0');
    assert.equal(status.progressPercent, 0);
    assert.equal(status.lastCheckedAt, NOW);

    status = reduceUpdaterStatus(status, { kind: 'download-progress', percent: 67.4 });
    assert.equal(status.progressPercent, 67);

    status = reduceUpdaterStatus(status, {
      kind: 'update-downloaded',
      version: '1.1.0',
      notes: '- Security fix',
      at: NOW + 1000,
    });
    assert.equal(status.state, 'ready');
    assert.equal(status.progressPercent, 100);
  });

  test('up-to-date check returns to idle and records the time', () => {
    let status = supportedStatus();
    status = reduceUpdaterStatus(status, { kind: 'check-started', manual: true, at: NOW });
    status = reduceUpdaterStatus(status, { kind: 'update-not-available', at: NOW });
    assert.equal(status.state, 'idle');
    assert.equal(status.lastCheckedAt, NOW);
    assert.equal(status.errorMessage, null);
  });

  test('background failure is silent: idle, no error message', () => {
    let status = supportedStatus();
    status = reduceUpdaterStatus(status, { kind: 'check-started', manual: false, at: NOW });
    status = reduceUpdaterStatus(status, {
      kind: 'check-error',
      message: 'net::ERR_INTERNET_DISCONNECTED',
      manual: false,
      at: NOW,
    });
    assert.equal(status.state, 'idle');
    assert.equal(status.errorMessage, null);
    assert.equal(status.lastCheckedAt, NOW);
  });

  test('manual failure surfaces inline', () => {
    let status = supportedStatus();
    status = reduceUpdaterStatus(status, { kind: 'check-started', manual: true, at: NOW });
    status = reduceUpdaterStatus(status, {
      kind: 'check-error',
      message: 'GitHub unreachable',
      manual: true,
      at: NOW,
    });
    assert.equal(status.state, 'error');
    assert.equal(status.errorMessage, 'GitHub unreachable');
  });

  test('a downloaded update survives later failed and empty checks', () => {
    let status = supportedStatus();
    status = reduceUpdaterStatus(status, {
      kind: 'update-downloaded',
      version: '1.1.0',
      notes: null,
      at: NOW,
    });
    status = reduceUpdaterStatus(status, {
      kind: 'check-error',
      message: 'boom',
      manual: true,
      at: NOW + 1,
    });
    assert.equal(status.state, 'ready');
    status = reduceUpdaterStatus(status, { kind: 'update-not-available', at: NOW + 2 });
    assert.equal(status.state, 'ready');
    assert.equal(status.pendingVersion, '1.1.0');
  });

  test('progress clamps to 0–100', () => {
    let status = supportedStatus();
    status = reduceUpdaterStatus(status, { kind: 'download-progress', percent: 132 });
    assert.equal(status.progressPercent, 100);
    status = reduceUpdaterStatus(status, { kind: 'download-progress', percent: -3 });
    assert.equal(status.progressPercent, 0);
  });

  test('unsupported installs ignore everything but channel changes', () => {
    let status = createInitialUpdaterStatus({
      supported: false,
      unsupportedReason: 'dev',
      installedVersion: '1.0.0',
      channel: 'stable',
    });
    const afterCheck = reduceUpdaterStatus(status, {
      kind: 'check-started',
      manual: true,
      at: NOW,
    });
    assert.equal(afterCheck, status);
    status = reduceUpdaterStatus(status, { kind: 'channel-changed', channel: 'beta' });
    assert.equal(status.channel, 'beta');
    assert.equal(status.state, 'unsupported');
  });

  test('scheduling updates nextCheckAt only', () => {
    let status = supportedStatus();
    status = reduceUpdaterStatus(status, { kind: 'next-check-scheduled', at: NOW + 60_000 });
    assert.equal(status.nextCheckAt, NOW + 60_000);
    assert.equal(status.state, 'idle');
  });
});

describe('normalizeUpdaterChannel', () => {
  test('beta passes through, everything else is stable', () => {
    assert.equal(normalizeUpdaterChannel('beta'), 'beta');
    assert.equal(normalizeUpdaterChannel('stable'), 'stable');
    assert.equal(normalizeUpdaterChannel('nightly'), 'stable');
    assert.equal(normalizeUpdaterChannel(undefined), 'stable');
    assert.equal(normalizeUpdaterChannel(42), 'stable');
  });
});

describe('releaseNotesToText', () => {
  test('normalizes strings, arrays, HTML structure, and entities', () => {
    assert.equal(releaseNotesToText('Plain notes'), 'Plain notes');
    assert.equal(
      releaseNotesToText([
        { version: '1.1.0', note: '<h3>Tools &amp; agents</h3><ul><li>Fix A</li></ul>' },
        { version: '1.0.9', note: 'Fix B' },
      ]),
      '### Tools & agents\n- Fix A\n\nFix B',
    );
    assert.equal(releaseNotesToText(null), null);
    assert.equal(releaseNotesToText('<p> </p>'), null);
  });
});
