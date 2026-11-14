import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { initGraphiteAppChrome } from '../../src/os/graphite-app-chrome';

test('External Connections has a decorative sidebar icon at desktop and narrow widths', () => {
  for (const width of [1440, 640]) {
    const win = new Window({ width });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    Object.assign(globalThis, { window: win, document: win.document });
    try {
      win.document.body.innerHTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
      const dispose = initGraphiteAppChrome();
      const button = win.document.querySelector('[data-settings-nav-area="external-connections"]')!;
      const icons = button.querySelectorAll('.settings-nav__graphite-icon');
      assert.equal(icons.length, 1);
      assert.equal(icons[0].getAttribute('aria-hidden'), 'true');
      assert.equal(button.querySelector('.settings-nav__item-label')?.textContent, 'External Connections');
      dispose();
      assert.equal(button.querySelector('.settings-nav__graphite-icon'), null);
    } finally {
      Object.assign(globalThis, { window: previousWindow, document: previousDocument });
      win.close();
    }
  }
});
