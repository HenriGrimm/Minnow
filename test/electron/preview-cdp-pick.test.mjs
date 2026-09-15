import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * CDP picking session lifecycle (MIN-370 / cross-origin Select fix).
 * Requires `npm run electron:build` so dist includes preview-cdp-pick.js. The module only imports
 * the pure adapter at runtime (the `electron` import is type-only), so a fake `WebContents` with a
 * mock `debugger` drives the whole flow with no live Chromium.
 *
 * Regression focus: the DOM tree must be requested (DOM.getDocument) before the first click, or
 * DOM.getBoxModel rejects with "Document needs to be requested first"; and searchForNode inspect
 * mode must be re-armed after each pick (it is one-shot in Chromium).
 */
const { enableCdpPicking } = await import('../../electron/dist/preview-cdp-pick.js');

const BOX_MODEL = { model: { content: [10, 20, 110, 20, 110, 60, 10, 60], width: 100, height: 40 } };

function makeDebugger() {
  const calls = [];
  let messageListener = null;
  const dbg = {
    attached: false,
    isAttached() {
      return this.attached;
    },
    attach() {
      this.attached = true;
    },
    detach() {
      this.attached = false;
    },
    async sendCommand(method, params) {
      calls.push({ method, params });
      switch (method) {
        case 'Runtime.evaluate':
          return { result: { value: 2 } };
        case 'DOM.getBoxModel':
          return BOX_MODEL;
        case 'DOM.pushNodesByBackendIdsToFrontend':
          return { nodeIds: [77] };
        case 'DOM.describeNode':
          return { node: { nodeName: 'BUTTON', localName: 'button', attributes: ['id', 'buy'] } };
        case 'DOM.getOuterHTML':
          return { outerHTML: '<button id="buy">Buy</button>' };
        case 'CSS.getComputedStyleForNode':
          return { computedStyle: [{ name: 'color', value: 'rgb(0,0,0)' }] };
        default:
          return {};
      }
    },
    on(_event, listener) {
      messageListener = listener;
    },
    removeListener() {
      messageListener = null;
    },
    emit(method, params) {
      messageListener?.(null, method, params);
    },
    hasListener() {
      return messageListener != null;
    },
  };
  return { dbg, calls };
}

const methodsOf = (calls) => calls.map((c) => c.method);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('enableCdpPicking lifecycle', () => {
  test('hover uses the guest toolbar accent with a light fill', async () => {
    const { dbg, calls } = makeDebugger();
    const send = dbg.sendCommand.bind(dbg);
    dbg.sendCommand = async (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression.includes('getImageData')) {
        return { result: { value: [220, 120, 35] } };
      }
      return send(method, params);
    };
    const session = await enableCdpPicking({ debugger: dbg, isDestroyed: () => false }, () => {});
    const config = calls.find(c => c.method === 'Overlay.setInspectMode').params.highlightConfig;
    assert.deepEqual(config.contentColor, { r: 220, g: 120, b: 35, a: 0.12 });
    assert.equal(config.showInfo, false);
    await session.disable();
  });

  test('toolbar clicks execute controls without selecting toolbar elements', async () => {
    const { dbg, calls } = makeDebugger();
    const send = dbg.sendCommand.bind(dbg);
    dbg.sendCommand = async (method, params) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'toolbar-button' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
      return send(method, params);
    };
    const picks = [];
    const session = await enableCdpPicking({ debugger: dbg, isDestroyed: () => false }, p => picks.push(p));
    dbg.emit('Overlay.inspectNodeRequested', { backendNodeId: 3 });
    await flush();
    assert.deepEqual(picks, []);
    assert.equal(calls.some(c => c.method === 'DOM.getBoxModel'), false);
    assert.ok(calls.some(c => c.method === 'Runtime.releaseObject'));
    await session.disable();
  });
  test('requests the document before arming inspect mode', async () => {
    const { dbg, calls } = makeDebugger();
    await enableCdpPicking({ debugger: dbg, isDestroyed: () => false }, () => {});
    const methods = methodsOf(calls);
    const docIdx = methods.indexOf('DOM.getDocument');
    const inspectIdx = methods.indexOf('Overlay.setInspectMode');
    assert.ok(docIdx >= 0, 'DOM.getDocument must be called at enable');
    assert.ok(inspectIdx >= 0, 'inspect mode must be armed');
    assert.ok(docIdx < inspectIdx, 'document must be requested before inspect mode is armed');
  });

  test('a click resolves the node and forwards a pick without the "requested first" error', async () => {
    const { dbg, calls } = makeDebugger();
    const picks = [];
    const errors = [];
    await enableCdpPicking({ debugger: dbg, isDestroyed: () => false }, (p) => picks.push(p), (e) => errors.push(e));

    calls.length = 0;
    dbg.emit('Overlay.inspectNodeRequested', { backendNodeId: 42 });
    await flush();

    assert.deepEqual(errors, [], 'no CDP error should surface');
    assert.equal(picks.length, 1, 'exactly one pick forwarded');
    assert.equal(picks[0].tagName, 'button');
    assert.equal(picks[0].cssSelector, '#buy');
  });

  test('outlines the picked node in-page as the selection indicator', async () => {
    const { dbg, calls } = makeDebugger();
    await enableCdpPicking({ debugger: dbg, isDestroyed: () => false }, () => {});

    calls.length = 0;
    dbg.emit('Overlay.inspectNodeRequested', { backendNodeId: 42 });
    await flush();

    const mark = calls.find(
      (c) => c.method === 'Runtime.evaluate' && /data-mn-selected/.test(c.params?.expression ?? ''),
    );
    assert.ok(mark, 'a Runtime.evaluate marks the picked node with a selection outline');
    // uid starts at 1 for the first pick; the script targets that element by data-mn-uid.
    assert.match(mark.params.expression, /data-mn-uid="1"/);
    assert.match(mark.params.expression, /outline/);
  });

  test('clears in-page selection outlines on disable', async () => {
    const { dbg, calls } = makeDebugger();
    const session = await enableCdpPicking({ debugger: dbg, isDestroyed: () => false }, () => {});

    calls.length = 0;
    await session.disable();

    const clear = calls.find(
      (c) => c.method === 'Runtime.evaluate' && /data-mn-selected/.test(c.params?.expression ?? ''),
    );
    assert.ok(clear, 'disable strips the selection outlines from the guest');
  });

  test('re-arms inspect mode after each pick (searchForNode is one-shot)', async () => {
    const { dbg, calls } = makeDebugger();
    await enableCdpPicking({ debugger: dbg, isDestroyed: () => false }, () => {});

    calls.length = 0;
    dbg.emit('Overlay.inspectNodeRequested', { backendNodeId: 42 });
    await flush();

    const reArm = calls.filter((c) => c.method === 'Overlay.setInspectMode');
    assert.equal(reArm.length, 1, 'inspect mode re-armed after the pick');
    assert.equal(reArm[0].params.mode, 'searchForNode');
  });

  test('re-requests the document when it is invalidated (SPA route swap)', async () => {
    const { dbg, calls } = makeDebugger();
    await enableCdpPicking({ debugger: dbg, isDestroyed: () => false }, () => {});

    calls.length = 0;
    dbg.emit('DOM.documentUpdated', {});
    await flush();

    assert.ok(
      calls.some((c) => c.method === 'DOM.getDocument'),
      'document re-requested on DOM.documentUpdated',
    );
  });

  test('disable turns off inspect mode and detaches', async () => {
    const { dbg, calls } = makeDebugger();
    const session = await enableCdpPicking({ debugger: dbg, isDestroyed: () => false }, () => {});

    calls.length = 0;
    await session.disable();

    const off = calls.find((c) => c.method === 'Overlay.setInspectMode');
    assert.ok(off, 'inspect mode set on disable');
    assert.equal(off.params.mode, 'none');
    assert.equal(dbg.isAttached(), false, 'debugger detached');
    assert.equal(dbg.hasListener(), false, 'message listener removed');
  });
});
