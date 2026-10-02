import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import {
  bindPreviewInstanceToElement,
  setPreviewInstanceVisible,
  unbindPreviewInstance,
  resetPreviewInstanceHostsForTests,
} from '../../src/ui/preview-instance-host.ts';
import { registerChromePopover, unregisterChromePopover, resetChromePopoverRegistryForTests } from '../../src/ui/preview-electron-visibility.ts';

describe('preview-instance-host', () => {
  const originalWindow = globalThis.window;
  const originalResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;

  let createCalls: string[] = [];
  let showCalls: Array<{ bounds: unknown; tabId: unknown; instanceId: unknown }> = [];
  let hideCalls: Array<{ tabId: unknown; instanceId: unknown }> = [];
  let observedElements: unknown[] = [];
  let disconnected = 0;

  class FakeResizeObserver {
    constructor(private cb: () => void) {}
    observe(el: unknown): void {
      observedElements.push(el);
    }
    disconnect(): void {
      disconnected += 1;
    }
    trigger(): void {
      this.cb();
    }
  }

  function makeElement(rect: { left: number; top: number; width: number; height: number }): HTMLElement {
    return {
      getBoundingClientRect: () => rect,
    } as unknown as HTMLElement;
  }

  beforeEach(() => {
    // Reset any instances left bound by the previous test BEFORE zeroing counters — otherwise
    // the disconnect() calls from that cleanup would be attributed to this test.
    resetPreviewInstanceHostsForTests();
    resetChromePopoverRegistryForTests();
    createCalls = [];
    showCalls = [];
    hideCalls = [];
    observedElements = [];
    disconnected = 0;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    Object.defineProperty(globalThis, 'window', {
      value: {
        minnow: {
          preview: {
            instances: {
              create: async (instanceId?: string) => {
                createCalls.push(instanceId ?? '');
                return instanceId ?? 'workspace-preview';
              },
              destroy: async () => {},
              list: async () => [],
            },
            show: async (bounds: unknown, tabId?: unknown, instanceId?: unknown) => {
              showCalls.push({ bounds, tabId, instanceId });
            },
            hide: async (tabId?: unknown, instanceId?: unknown) => {
              hideCalls.push({ tabId, instanceId });
            },
          },
        },
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    resetPreviewInstanceHostsForTests();
    resetChromePopoverRegistryForTests();
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
    (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
  });

  test('binding an instance creates it and shows bounds read from the element', async () => {
    const el = makeElement({ left: 5, top: 10, width: 200, height: 150 });
    bindPreviewInstanceToElement('design', el);
    // instances.create and show are fire-and-forget (void) inside bindPreviewInstanceToElement.
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(createCalls, ['design']);
    assert.equal(showCalls.length, 1);
    assert.deepEqual(showCalls[0].bounds, { x: 5, y: 10, width: 200, height: 150 });
    assert.equal(showCalls[0].instanceId, 'design');
    assert.equal(observedElements.length, 1);
  });

  test('two instances bound to different elements stay independent', async () => {
    const designEl = makeElement({ left: 0, top: 0, width: 100, height: 100 });
    const workspaceEl = makeElement({ left: 300, top: 0, width: 400, height: 400 });

    bindPreviewInstanceToElement('design', designEl);
    bindPreviewInstanceToElement('workspace-preview', workspaceEl);
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(createCalls.sort(), ['design', 'workspace-preview']);
    const byInstance = Object.fromEntries(showCalls.map((c) => [c.instanceId, c.bounds]));
    assert.deepEqual(byInstance.design, { x: 0, y: 0, width: 100, height: 100 });
    assert.deepEqual(byInstance['workspace-preview'], { x: 300, y: 0, width: 400, height: 400 });
  });

  test('setPreviewInstanceVisible(false) hides without unbinding', async () => {
    const el = makeElement({ left: 0, top: 0, width: 100, height: 100 });
    bindPreviewInstanceToElement('design', el);
    await Promise.resolve();
    await Promise.resolve();

    setPreviewInstanceVisible('design', false);
    await Promise.resolve();

    assert.equal(hideCalls.length, 1);
    assert.equal(hideCalls[0].instanceId, 'design');
  });

  test('unbindPreviewInstance disconnects the observer and hides the instance', async () => {
    const el = makeElement({ left: 0, top: 0, width: 100, height: 100 });
    bindPreviewInstanceToElement('design', el);
    await Promise.resolve();

    unbindPreviewInstance('design');
    await Promise.resolve();

    assert.equal(disconnected, 1);
    assert.ok(hideCalls.some((c) => c.instanceId === 'design'));
  });

  test('menus hide bound guests until the last menu closes, including during bounds updates', () => {
    const el = makeElement({ left: 0, top: 0, width: 100, height: 100 });
    bindPreviewInstanceToElement('workspace-preview-secondary', el);
    registerChromePopover();
    registerChromePopover();
    const showsBeforeClose = showCalls.length;
    setPreviewInstanceVisible('workspace-preview-secondary', true);
    bindPreviewInstanceToElement('another-preview', el);
    assert.equal(showCalls.length, showsBeforeClose);
    assert.ok(hideCalls.some((call) => call.instanceId === 'workspace-preview-secondary'));
    assert.ok(hideCalls.some((call) => call.instanceId === 'another-preview'));
    unregisterChromePopover();
    assert.equal(showCalls.length, showsBeforeClose);
    setPreviewInstanceVisible('another-preview', false);
    unregisterChromePopover();
    assert.equal(showCalls.length, showsBeforeClose + 1);
    assert.equal(showCalls.at(-1)?.instanceId, 'workspace-preview-secondary');
    unbindPreviewInstance('workspace-preview-secondary');
    registerChromePopover();
    unregisterChromePopover();
    assert.equal(showCalls.length, showsBeforeClose + 1, 'unbound and inactive guests stay hidden');
  });

  test('zero-size element bounds hides instead of showing', async () => {
    const el = makeElement({ left: 0, top: 0, width: 0, height: 0 });
    bindPreviewInstanceToElement('design', el);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(showCalls.length, 0);
    assert.ok(hideCalls.some((c) => c.instanceId === 'design'));
  });
});
