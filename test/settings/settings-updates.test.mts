/**
 * Settings → General → App updates render states (MIN-384).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import type { MinnowUpdaterStatus } from '../../src/electron.d.ts';
import { renderAppUpdatesSettings } from '../../src/ui/settings-updates.ts';

type StatusListener = (status: MinnowUpdaterStatus) => void;

function baseStatus(overrides: Partial<MinnowUpdaterStatus> = {}): MinnowUpdaterStatus {
  return {
    state: 'idle',
    supported: true,
    unsupportedReason: null,
    installedVersion: '1.2.3',
    channel: 'stable',
    pendingVersion: null,
    releaseNotes: null,
    progressPercent: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    errorMessage: null,
    ...overrides,
  };
}

function makeFakeApi(initial: MinnowUpdaterStatus) {
  const listeners = new Set<StatusListener>();
  const calls: { method: string; arg?: unknown }[] = [];
  const api = {
    getStatus: () => {
      calls.push({ method: 'getStatus' });
      return Promise.resolve(initial);
    },
    checkNow: () => {
      calls.push({ method: 'checkNow' });
      return Promise.resolve(initial);
    },
    restart: () => {
      calls.push({ method: 'restart' });
      return Promise.resolve(true);
    },
    setChannel: (channel: 'stable' | 'beta') => {
      calls.push({ method: 'setChannel', arg: channel });
      return Promise.resolve(initial);
    },
    onStatusChanged: (cb: StatusListener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const emit = (status: MinnowUpdaterStatus) => {
    for (const cb of listeners) cb(status);
  };
  return { api, calls, emit };
}

let win: Window | null = null;

function setupDom(): HTMLElement {
  win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.window = win;
  // Node ≥21 exposes globalThis.navigator as getter-only; defineProperty overrides it.
  Object.defineProperty(globalThis, 'navigator', {
    value: win.navigator,
    configurable: true,
  });
  const mount = win.document.createElement('div');
  win.document.body.appendChild(mount);
  return mount as unknown as HTMLElement;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  win?.close();
  win = null;
});

describe('renderAppUpdatesSettings', () => {
  test('without the bridge, shows dev session strip and callout', () => {
    const mount = setupDom();
    renderAppUpdatesSettings(mount);
    const strip = mount.querySelector('.settings-updates-strip');
    assert.ok(strip);
    assert.ok(strip?.textContent?.includes('Dev session'));
    const callout = mount.querySelector('.settings-updates__callout');
    assert.ok(callout?.textContent?.includes('installed Minnow app'));
    assert.equal(mount.querySelector('.settings-updates__controls'), null);
  });

  test('idle status renders up-to-date strip, version, and hidden restart', async () => {
    const mount = setupDom();
    const { api } = makeFakeApi(baseStatus({ lastCheckedAt: Date.now() }));
    (window as unknown as { minnow: unknown }).minnow = { updater: api };

    renderAppUpdatesSettings(mount);
    await flush();

    const strip = mount.querySelector<HTMLElement>('.settings-updates-strip');
    assert.ok(strip);
    assert.equal(strip.dataset.tone, 'ok');
    assert.ok(strip.textContent?.includes('Up to date — version 1.2.3'));
    assert.equal(mount.querySelector('.settings-updates-version')?.textContent, '1.2.3');
    assert.ok(mount.textContent?.includes('Just now'));

    const restart = mount.querySelector<HTMLButtonElement>('#settingsUpdatesRestartBtn');
    assert.equal(restart?.hidden, true);
    const check = mount.querySelector<HTMLButtonElement>('#settingsUpdatesCheckBtn');
    assert.equal(check?.disabled, false);
  });

  test('downloading → ready transitions drive progress and restart affordance', async () => {
    const mount = setupDom();
    const { api, emit } = makeFakeApi(baseStatus());
    (window as unknown as { minnow: unknown }).minnow = { updater: api };

    renderAppUpdatesSettings(mount);
    await flush();

    emit(
      baseStatus({
        state: 'downloading',
        pendingVersion: '1.2.4',
        progressPercent: 40,
      }),
    );
    const strip = mount.querySelector<HTMLElement>('.settings-updates-strip');
    assert.ok(strip?.textContent?.includes('Downloading 1.2.4 · 40%'));
    const progress = mount.querySelector<HTMLElement>('.settings-updates-progress');
    assert.equal(progress?.hidden, false);
    assert.equal(progress?.getAttribute('aria-valuenow'), '40');
    assert.equal(
      mount.querySelector<HTMLButtonElement>('#settingsUpdatesCheckBtn')?.disabled,
      true,
    );

    emit(
      baseStatus({
        state: 'ready',
        pendingVersion: '1.2.4',
        progressPercent: 100,
        releaseNotes: '## What\'s Changed\n### Models & providers\n- Security fix for tool server\n- Preview pane stability\n\n[Full notes](https://example.com)',
      }),
    );
    assert.ok(strip?.textContent?.includes('Restart to update — 1.2.4 is ready'));
    assert.equal(
      mount.querySelector<HTMLButtonElement>('#settingsUpdatesRestartBtn')?.hidden,
      false,
    );
    const notes = mount.querySelector<HTMLElement>('.settings-updates-notes');
    assert.equal(notes?.hidden, false);
    assert.ok(notes?.textContent?.includes("What's new in 1.2.4"));
    assert.ok(notes?.textContent?.includes("What's Changed"));
    assert.equal(notes?.querySelector('h3')?.textContent, 'Models & providers');
    assert.equal(notes?.querySelectorAll('li').length, 2);
    assert.equal(notes?.querySelector('a')?.getAttribute('target'), '_blank');
    assert.equal(notes?.querySelector('a')?.getAttribute('rel'), 'noopener noreferrer');
  });

  test('manual check button calls checkNow; restart calls restart', async () => {
    const mount = setupDom();
    const { api, calls, emit } = makeFakeApi(baseStatus());
    (window as unknown as { minnow: unknown }).minnow = { updater: api };

    renderAppUpdatesSettings(mount);
    await flush();

    mount.querySelector<HTMLButtonElement>('#settingsUpdatesCheckBtn')?.click();
    assert.ok(calls.some((c) => c.method === 'checkNow'));

    emit(baseStatus({ state: 'ready', pendingVersion: '1.2.4', progressPercent: 100 }));
    mount.querySelector<HTMLButtonElement>('#settingsUpdatesRestartBtn')?.click();
    assert.ok(calls.some((c) => c.method === 'restart'));
  });

  test('channel switch calls setChannel without echo loops', async () => {
    const mount = setupDom();
    const { api, calls, emit } = makeFakeApi(baseStatus());
    (window as unknown as { minnow: unknown }).minnow = { updater: api };

    renderAppUpdatesSettings(mount);
    await flush();

    const beta = mount.querySelector<HTMLInputElement>(
      'input[name="settings-update-channel"][value="beta"]',
    );
    assert.ok(beta);
    beta.checked = true;
    beta.dispatchEvent(new win!.window.Event('change', { bubbles: true }));
    assert.deepEqual(
      calls.filter((c) => c.method === 'setChannel'),
      [{ method: 'setChannel', arg: 'beta' }],
    );

    // Status echo from the main process must not re-trigger setChannel.
    emit(baseStatus({ channel: 'beta' }));
    assert.equal(calls.filter((c) => c.method === 'setChannel').length, 1);
    const betaHint = mount.querySelector<HTMLElement>('.settings-updates-beta-hint');
    assert.equal(betaHint?.hidden, false);
  });

  test('unsupported macOS install hides controls and shows signing callout', async () => {
    const mount = setupDom();
    const { api } = makeFakeApi(
      baseStatus({
        state: 'unsupported',
        supported: false,
        unsupportedReason: 'macos-signing',
      }),
    );
    (window as unknown as { minnow: unknown }).minnow = { updater: api };

    renderAppUpdatesSettings(mount);
    await flush();

    assert.equal(mount.querySelector('.settings-updates__controls')?.hidden, true);
    const callout = mount.querySelector('.settings-updates__callout');
    assert.ok(callout?.textContent?.includes('macOS auto-update requires code signing'));
    const checkBtn = mount.querySelector<HTMLButtonElement>('#settingsUpdatesCheckBtn');
    assert.equal(checkBtn?.disabled, true);
    const channelInputs = mount.querySelectorAll<HTMLInputElement>(
      'input[name="settings-update-channel"]',
    );
    assert.equal(channelInputs.length, 2);
    assert.equal(channelInputs[0]?.disabled, true);
    assert.equal(channelInputs[1]?.disabled, true);
  });

  test('unsupported dev install hides channel and check controls', async () => {
    const mount = setupDom();
    const { api } = makeFakeApi(
      baseStatus({
        state: 'unsupported',
        supported: false,
        unsupportedReason: 'dev',
      }),
    );
    (window as unknown as { minnow: unknown }).minnow = { updater: api };

    renderAppUpdatesSettings(mount);
    await flush();

    assert.equal(mount.querySelector('.settings-updates__controls')?.hidden, true);
    assert.ok(mount.querySelector('.settings-updates__callout')?.textContent?.includes('dev session'));
    const checkBtn = mount.querySelector<HTMLButtonElement>('#settingsUpdatesCheckBtn');
    assert.equal(checkBtn?.disabled, true);
  });
});
