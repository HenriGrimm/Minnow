/**
 * Menubar update pill states + popover (MIN-384).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import type { MinnowUpdaterStatus } from '../../src/electron.d.ts';
import { initUpdateMenubarPill } from '../../src/os/update-menubar.ts';

type StatusListener = (status: MinnowUpdaterStatus) => void;

function baseStatus(overrides: Partial<MinnowUpdaterStatus> = {}): MinnowUpdaterStatus {
  return {
    state: 'idle',
    supported: true,
    unsupportedReason: null,
    installedVersion: '1.0.0',
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

let win: Window | null = null;

function setup(initial: MinnowUpdaterStatus) {
  win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.document = win.document;
  g.window = win;
  g.HTMLElement = win.HTMLElement;
  // registerChromePopover schedules a preview layout sync via bare rAF globals.
  g.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number;
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);

  const listeners = new Set<StatusListener>();
  const calls: string[] = [];
  (win as unknown as { minnow: unknown }).minnow = {
    updater: {
      getStatus: () => Promise.resolve(initial),
      checkNow: () => Promise.resolve(initial),
      restart: () => {
        calls.push('restart');
        return Promise.resolve(true);
      },
      setChannel: () => Promise.resolve(initial),
      onStatusChanged: (cb: StatusListener) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  };

  const slot = win.document.createElement('div') as unknown as HTMLElement;
  win.document.body.appendChild(slot as unknown as Node);
  const cleanup = initUpdateMenubarPill(slot);
  const emit = (status: MinnowUpdaterStatus) => {
    for (const cb of listeners) cb(status);
  };
  return { slot, cleanup, emit, calls };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  win?.close();
  win = null;
});

describe('initUpdateMenubarPill', () => {
  test('stays hidden while idle and when checking', async () => {
    const { slot, emit } = setup(baseStatus());
    await flush();
    assert.equal(slot.hidden, true);
    emit(baseStatus({ state: 'checking' }));
    assert.equal(slot.hidden, true);
  });

  test('shows mono progress while downloading', async () => {
    const { slot, emit } = setup(baseStatus());
    await flush();
    emit(baseStatus({ state: 'downloading', pendingVersion: '1.1.0', progressPercent: 67 }));
    assert.equal(slot.hidden, false);
    const pill = slot.querySelector<HTMLButtonElement>('.mn-os-mb-update-pill');
    assert.equal(pill?.textContent, '↓ 67%');
    assert.ok(pill?.classList.contains('is-downloading'));
  });

  test('accent restart pill when ready; popover restarts', async () => {
    const { slot, emit, calls } = setup(baseStatus());
    await flush();
    emit(
      baseStatus({
        state: 'ready',
        pendingVersion: '1.1.0',
        progressPercent: 100,
        releaseNotes: "## What's Changed\nA broad reliability update.\n### Models & providers\n- Security fix\n- Stability",
      }),
    );
    const pill = slot.querySelector<HTMLButtonElement>('.mn-os-mb-update-pill');
    assert.equal(pill?.textContent, 'Restart · 1.1.0');
    assert.ok(pill?.classList.contains('is-ready'));
    assert.equal(
      pill?.getAttribute('aria-label'),
      'Restart to update Minnow to version 1.1.0',
    );

    pill?.click();
    const menu = document.querySelector<HTMLElement>('.mn-os-update-menu');
    assert.ok(menu);
    assert.ok(menu.textContent?.includes('Minnow 1.1.0 is downloaded.'));
    assert.ok(menu.textContent?.includes('Highlights'));
    assert.ok(menu.textContent?.includes('A broad reliability update.'));
    assert.ok(menu.textContent?.includes('Security fix'));
    assert.equal(menu.textContent?.includes("What's Changed"), false);
    assert.equal(menu.textContent?.includes('Models & providers'), false);

    menu.querySelector<HTMLButtonElement>('.mn-os-update-menu__restart')?.click();
    assert.deepEqual(calls, ['restart']);
    assert.equal(document.querySelector('.mn-os-update-menu'), null);
  });

  test('returning to idle hides the pill and closes the popover', async () => {
    const { slot, emit } = setup(baseStatus());
    await flush();
    emit(baseStatus({ state: 'ready', pendingVersion: '1.1.0', progressPercent: 100 }));
    slot.querySelector<HTMLButtonElement>('.mn-os-mb-update-pill')?.click();
    assert.ok(document.querySelector('.mn-os-update-menu'));
    emit(baseStatus());
    assert.equal(slot.hidden, true);
    assert.equal(document.querySelector('.mn-os-update-menu'), null);
  });

  test('cleanup removes the pill', async () => {
    const { slot, emit, cleanup } = setup(baseStatus());
    await flush();
    emit(baseStatus({ state: 'downloading', pendingVersion: '1.1.0', progressPercent: 5 }));
    cleanup();
    assert.equal(slot.querySelector('.mn-os-mb-update-pill'), null);
    assert.equal(slot.hidden, true);
  });
});
