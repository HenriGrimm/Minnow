import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { Window } from 'happy-dom';

const { setStatus, setReadyStatus } = await import('../../src/ui/status.ts');

function setupDom() {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;

  document.body.innerHTML = `
    <div class="status-pill">
      <div class="s-dot" id="sDot"></div>
      <span id="sText"></span>
    </div>
    <div class="mn-os-mb-status status-pill">
      <div class="s-dot" id="osStatusDot"></div>
      <span id="osStatusText"></span>
    </div>
  `;
  return window;
}

describe('status', () => {
  afterEach(() => {
    document.body.replaceChildren();
    mock.restoreAll();
  });

  test('setStatus updates legacy topbar and OS menubar pills', () => {
    setupDom();
    setStatus('spin', 'Loading models…');

    const sDot = document.getElementById('sDot');
    const sText = document.getElementById('sText');
    const osDot = document.getElementById('osStatusDot');
    const osText = document.getElementById('osStatusText');

    assert.equal(sDot?.className, 's-dot spin');
    assert.equal(sText?.textContent, 'Loading models…');
    assert.equal(osDot?.className, 's-dot spin');
    assert.equal(osText?.textContent, 'Loading models…');
  });

  test('setStatus sets title on long non-error messages for both pills', () => {
    setupDom();
    const longMsg = 'Loading models from every configured provider right now…';
    setStatus('spin', longMsg);

    assert.equal(document.getElementById('sText')?.getAttribute('title'), longMsg);
    assert.equal(document.getElementById('osStatusText')?.getAttribute('title'), longMsg);
  });

  test('setStatus marks errors copyable with click-to-copy title hint', () => {
    setupDom();
    const longMsg = 'Cannot reach one or more providers. Check Settings → Providers.';
    setStatus('err', longMsg);

    const osText = document.getElementById('osStatusText');
    const sText = document.getElementById('sText');
    assert.ok(osText?.classList.contains('status-pill__text--copyable'));
    assert.ok(sText?.classList.contains('status-pill__text--copyable'));
    assert.equal(osText?.getAttribute('role'), 'button');
    assert.equal(osText?.getAttribute('title'), `${longMsg} (click to copy)`);
    assert.equal(sText?.getAttribute('title'), `${longMsg} (click to copy)`);
  });

  test('clicking an error status copies the full message', async () => {
    const win = setupDom();
    const errMsg = 'Cannot reach one or more providers. Check Settings → Providers.';
    let copied = '';
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          copied = text;
        },
      },
    });

    setStatus('err', errMsg);
    document.getElementById('osStatusText')?.dispatchEvent(new win.Event('click'));

    // Clipboard write is async; yield a tick for the promise.
    await Promise.resolve();
    assert.equal(copied, errMsg);
  });

  test('setReadyStatus marks both pills ok and clears copyable affordance', () => {
    setupDom();
    setStatus('err', 'Something failed');
    setReadyStatus();

    assert.equal(document.getElementById('sDot')?.className, 's-dot ok');
    assert.equal(document.getElementById('osStatusDot')?.className, 's-dot ok');
    assert.equal(document.getElementById('sText')?.textContent, 'Ready');
    assert.equal(document.getElementById('osStatusText')?.textContent, 'Ready');
    assert.equal(
      document.getElementById('osStatusText')?.classList.contains('status-pill__text--copyable'),
      false,
    );
  });
});
