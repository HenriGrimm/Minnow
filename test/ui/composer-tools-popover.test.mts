import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { installComponentDom, type ComponentDom } from './components/component-dom.mts';

mock.module('../../src/tools/config.ts', { namedExports: {
  loadToolConfigIntoDrawer() {},
  syncWebSearchProviderFromSearchConfig: async () => {},
} });
mock.module('../../src/ui/tools-list.ts', { namedExports: { ensureToolsSectionFilled() {} } });

const { initComposerToolsPopover, closeAllToolsPopovers, isComposerToolsPopoverOpen } = await import('../../src/ui/composer-tools-popover.ts');
let dom: ComponentDom;
afterEach(() => { closeAllToolsPopovers(); dom?.cleanup(); });

test('tools flyout uses Popover and returns its original content home on Escape', () => {
  dom = installComponentDom();
  dom.doc.body.innerHTML = `<div id="home"><button id="btnComposerTools">Tools</button>
    <div id="composerToolsPopover" class="composer-tools-popover hidden"><select aria-label="Permission"><option>Ask</option></select><button id="composerToolsOpenSettings">Settings</button></div></div>`;
  const button = dom.doc.getElementById('btnComposerTools') as HTMLButtonElement;
  const content = dom.doc.getElementById('composerToolsPopover')!;
  const select = content.querySelector('select');
  initComposerToolsPopover();
  initComposerToolsPopover();
  button.click();
  assert.equal(isComposerToolsPopoverOpen(), true);
  assert.equal(button.classList.contains('mn-btn--icon'), true);
  const flyout = content.closest('.mn-popover')!;
  assert.ok(flyout === content);
  assert.equal(content.parentElement?.id, 'home');
  assert.equal(content.hasAttribute('data-mn-surface'), true);
  assert.equal(content.style.position, '');
  assert.equal(flyout.classList.contains('mn-occludes-preview'), true);
  assert.equal(flyout.hasAttribute('data-above-shell-overlay'), true);
  dom.key(content, 'Escape');
  assert.equal(isComposerToolsPopoverOpen(), false);
  assert.equal(content.parentElement?.id, 'home');
  assert.equal(content.classList.contains('hidden'), true);
  assert.equal(dom.doc.activeElement === button, true);
  button.click();
  assert.equal(content.querySelector('select') === select, true);
  dom.pointer(dom.doc.body, 'pointerdown');
  assert.equal(isComposerToolsPopoverOpen(), false);
  assert.equal(content.parentElement?.id, 'home');
});
