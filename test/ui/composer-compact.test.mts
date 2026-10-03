import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';

const CHAT_ID = '22222222-2222-2222-2222-222222222222';

const { createEmptyChatObject, setSessionStateForTests } = await import(
  '../../src/state/sessions.ts'
);
const { disposeModeSelectorForTests, initModeSelector } = await import(
  '../../src/ui/mode-selector.ts'
);
const {
  COMPOSER_COMPACT_ENTER_PX,
  COMPOSER_COMPACT_LEAVE_PX,
  clampComposerOverflowPlacement,
  disposeComposerCompactForTests,
  initComposerCompact,
  isComposerControlsCompact,
  isComposerControlsNarrow,
  isComposerOverflowToolsPageOpen,
  nextComposerCompactState,
  refreshComposerCompactOverflow,
  syncComposerCompactFromWidth,
} = await import('../../src/ui/composer-compact.ts');

let windowInstance: Window | null = null;

function setupComposerDom(): HTMLElement {
  windowInstance = new Window();
  installHappyDomGlobals(windowInstance);

  const bar = document.createElement('div');
  bar.className = 'input-bar';

  const row = document.createElement('div');
  row.id = 'composerControls';
  row.className = 'composer-controls';

  const modeSelector = document.createElement('div');
  modeSelector.id = 'modeSelector';
  modeSelector.className = 'mode-segmented';

  const thinking = document.createElement('div');
  thinking.id = 'composerThinkingWrap';
  thinking.className = 'composer-control thinking-control-wrap';
  const fast = document.createElement('button');
  fast.id = 'composerCursorFast';

  const contextDocs = document.createElement('div');
  contextDocs.id = 'composerContextDocumentsWrap';
  contextDocs.className = 'composer-control context-documents-control-wrap';

  const wheel = document.createElement('div');
  wheel.className = 'context-usage-anchor';

  const trail = document.createElement('div');
  trail.className = 'composer-controls__trail';

  const tools = document.createElement('div');
  tools.id = 'composerToolsAnchor';
  tools.className = 'composer-tools-anchor';
  const toolsBtn = document.createElement('button');
  toolsBtn.type = 'button';
  toolsBtn.id = 'btnComposerTools';
  const toolsPopover = document.createElement('div');
  toolsPopover.id = 'composerToolsPopover';
  toolsPopover.className = 'composer-tools-popover hidden';
  const toolsFooter = document.createElement('div');
  toolsFooter.className = 'composer-tools-popover__footer';
  const webSearch = document.createElement('div');
  webSearch.className = 'composer-tools-popover__setting';
  const cacheToggle = document.createElement('label');
  cacheToggle.className = 'composer-tools-popover__toggle';
  const settingsLink = document.createElement('button');
  settingsLink.type = 'button';
  settingsLink.id = 'composerToolsOpenSettings';
  toolsFooter.append(webSearch, cacheToggle, settingsLink);
  toolsPopover.append(toolsFooter);
  tools.append(toolsBtn, toolsPopover);

  const overflowAnchor = document.createElement('div');
  overflowAnchor.className = 'composer-overflow-anchor';
  overflowAnchor.id = 'composerOverflowAnchor';
  const overflowBtn = document.createElement('button');
  overflowBtn.type = 'button';
  overflowBtn.id = 'btnComposerOverflow';
  const popover = document.createElement('div');
  popover.id = 'composerOverflowPopover';
  popover.className = 'composer-overflow-popover hidden';
  const slot = document.createElement('div');
  slot.id = 'composerOverflowSlot';
  slot.className = 'composer-overflow-slot';

  const settingsPage = document.createElement('div');
  settingsPage.id = 'composerOverflowSettingsPage';
  settingsPage.className = 'composer-overflow-page composer-overflow-page--settings';
  const toolsNav = document.createElement('button');
  toolsNav.type = 'button';
  toolsNav.id = 'composerOverflowToolsNav';
  toolsNav.className = 'composer-overflow-tools-nav';
  toolsNav.textContent = 'Tools';
  settingsPage.appendChild(toolsNav);

  const toolsPage = document.createElement('div');
  toolsPage.id = 'composerOverflowToolsPage';
  toolsPage.className = 'composer-overflow-page composer-overflow-page--tools hidden';
  toolsPage.hidden = true;
  const toolsHead = document.createElement('header');
  toolsHead.className = 'composer-overflow-tools-head';
  const toolsBack = document.createElement('button');
  toolsBack.type = 'button';
  toolsBack.id = 'composerOverflowToolsBack';
  toolsBack.setAttribute('aria-label', 'Back');
  const toolsTitle = document.createElement('h2');
  toolsTitle.id = 'composerOverflowToolsTitle';
  toolsTitle.textContent = 'Tools';
  const enableSlot = document.createElement('div');
  enableSlot.id = 'composerOverflowEnableAllSlot';
  toolsHead.append(toolsBack, toolsTitle, enableSlot);
  const toolsBody = document.createElement('div');
  toolsBody.id = 'composerOverflowToolsBody';
  toolsPage.append(toolsHead, toolsBody);

  slot.append(settingsPage, toolsPage);
  popover.appendChild(slot);
  overflowAnchor.append(overflowBtn, popover);

  trail.append(tools, overflowAnchor);
  row.append(modeSelector, thinking, fast, contextDocs, wheel, trail);
  bar.appendChild(row);
  document.body.appendChild(bar);

  const chat = createEmptyChatObject('');
  chat.id = CHAT_ID;
  chat.modeId = 'plan';
  setSessionStateForTests({
    version: 2,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });

  return row;
}

afterEach(() => {
  if (windowInstance) {
    disposeComposerCompactForTests();
    disposeModeSelectorForTests();
    windowInstance.close();
    windowInstance = null;
  }
  setSessionStateForTests(null);
});

describe('composer compact overflow', () => {
  test('index.html defines the two-page cog sheet', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    assert.match(html, /id="composerOverflowSettingsPage"/);
    assert.match(html, /id="codeComposerModelAnchor"/);
    assert.match(html, /id="composerOverflowToolsPage"/);
    assert.match(html, /id="composerOverflowToolsNav"/);
    assert.match(html, /id="composerOverflowToolsBack"/);
  });
  test('hysteresis: narrow below 560px, back only above 600px', () => {
    assert.equal(COMPOSER_COMPACT_ENTER_PX, 560);
    assert.equal(COMPOSER_COMPACT_LEAVE_PX, 600);
    assert.equal(nextComposerCompactState(false, 500), true);
    assert.equal(nextComposerCompactState(true, 580), true);
    assert.equal(nextComposerCompactState(true, 610), false);
    assert.equal(nextComposerCompactState(false, 580), false);
    assert.equal(nextComposerCompactState(false, 0), false);
  });

  test('footer row keeps mode, effort and wheel; the rest lives in the cog at every width', () => {
    const row = setupComposerDom();
    initModeSelector();
    initComposerCompact();
    syncComposerCompactFromWidth(700);

    const bar = row.closest('.input-bar');
    const slot = document.getElementById('composerOverflowSlot');
    const thinking = document.getElementById('composerThinkingWrap');
    const fast = document.getElementById('composerCursorFast');
    const contextDocs = document.getElementById('composerContextDocumentsWrap');
    const tools = document.getElementById('composerToolsAnchor');
    const wheel = row.querySelector('.context-usage-anchor');
    const dropdown = document.getElementById('modeSelectorDropdown');
    const overflowBtn = document.getElementById('btnComposerOverflow');

    assert.equal(isComposerControlsCompact(), true);
    assert.equal(isComposerControlsNarrow(), false);
    assert.equal(thinking?.parentElement, row, 'effort stays one click away');
    assert.equal(fast?.parentElement, row, 'Fast stays beside effort');
    assert.equal(contextDocs?.parentElement?.id, 'composerOverflowSettingsPage');
    assert.equal(tools?.parentElement?.id, 'composerOverflowToolsBody');
    assert.ok(slot);
    assert.equal(wheel?.parentElement, row);
    assert.equal(dropdown?.hidden, false);
    assert.match(dropdown?.textContent ?? '', /Plan/);
    assert.equal(dropdown?.parentElement, row);
    assert.equal(overflowBtn?.closest('#composerControls'), row);
    assert.equal(slot?.contains(overflowBtn), false);
    assert.equal(bar?.classList.contains('input-bar--composer-compact'), true);
    assert.equal(document.getElementById('composerOverflowAnchor')?.previousElementSibling, dropdown);

    syncComposerCompactFromWidth(500);
    assert.equal(isComposerControlsNarrow(), true);
    assert.equal(thinking?.parentElement?.id, 'composerOverflowSettingsPage');
    assert.equal(fast?.parentElement?.id, 'composerOverflowSettingsPage');
    assert.ok(row.classList.contains('composer-controls--narrow'));

    syncComposerCompactFromWidth(940);
    assert.equal(isComposerControlsNarrow(), false);
    assert.equal(thinking?.parentElement, row);
    assert.equal(fast?.parentElement, row);
    assert.equal(contextDocs?.parentElement?.id, 'composerOverflowSettingsPage');
    assert.equal(tools?.parentElement?.id, 'composerOverflowToolsBody');
    assert.equal(bar?.classList.contains('input-bar--composer-compact'), true);
  });

  test('mode dropdown CSS never allows the compact trigger to shrink or clip', () => {
    const css = readFileSync(new URL('../../src/styles/mode-selector.css', import.meta.url), 'utf8');
    assert.match(css, /#modeSelectorDropdown[\s\S]*flex-shrink:\s*0/);
    assert.match(css, /#modeSelectorDropdown[\s\S]*min-width:\s*max-content/);
    assert.match(
      css,
      /\.composer-controls:not\(\.composer-controls--compact\) #modeSelector\.mode-segmented[\s\S]*min-width:\s*max-content/,
    );
  });

  test('refresh re-parks a control inserted after compact is already on', () => {
    const row = setupComposerDom();
    initModeSelector();
    initComposerCompact();
    syncComposerCompactFromWidth(700);

    const wrap = document.createElement('div');
    wrap.id = 'composerBrainNotesWrap';
    row.appendChild(wrap);
    const runTarget = document.createElement('div');
    runTarget.id = 'composerRunTargetWrap';
    row.appendChild(runTarget);
    refreshComposerCompactOverflow();

    assert.equal(wrap.parentElement?.id, 'composerOverflowSettingsPage');
    assert.equal(runTarget.parentElement, row, 'run target stays in the footer row');
  });

  test('compact CSS pins mode, cog, model, wheel inside the composer column', () => {
    const css = readFileSync(new URL('../../src/styles/composer-overflow.css', import.meta.url), 'utf8');
    assert.match(css, /\.composer-controls\.composer-controls--compact \{[\s\S]*?display:\s*flex;/);
    assert.doesNotMatch(
      css,
      /\.composer-controls--compact \.composer-controls__trail \{\s*display:\s*contents;/,
    );
    assert.match(css, /\.composer-controls--compact #modeSelectorDropdown \{[\s\S]*?order:\s*1;/);
    assert.match(css, /\.composer-controls--compact #composerRunTargetWrap \{[^}]*order:\s*2;/);
    assert.match(css, /\.composer-controls--compact #composerThinkingWrap \{[^}]*order:\s*3;/);
    assert.match(css, /\.composer-controls--compact \.composer-overflow-anchor \{[\s\S]*?order:\s*4;/);
    assert.match(css, /\.composer-controls--compact \.context-usage-anchor \{[\s\S]*?order:\s*5;/);
    assert.match(css, /\.composer-controls--compact \.composer-controls__trail \{[\s\S]*?order:\s*6;/);
    assert.match(
      css,
      /\.input-bar\.input-bar--composer-compact > \.composer-controls \{\s*grid-column:\s*1;/,
    );
    const hubCss = readFileSync(new URL('../../src/styles/hub.css', import.meta.url), 'utf8');
    assert.match(
      hubCss,
      /\.input-bar\.input-bar--hub\.input-bar--composer-compact > \.composer-controls \{\s*grid-column:\s*1 \/ -1;/,
    );
  });

  test('overflow sheet CSS is a two-page sheet with labeled rows', () => {
    const css = readFileSync(new URL('../../src/styles/composer-overflow.css', import.meta.url), 'utf8');
    assert.match(css, /\.composer-overflow-page--settings/);
    assert.match(css, /\.composer-overflow-settings-lead/);
    assert.match(css, /\.composer-overflow-page--tools/);
    assert.match(css, /\.composer-overflow-tools-nav/);
    assert.match(
      css,
      /\.composer-overflow-page--settings \.thinking-toggle-btn\[aria-pressed='true'\]::before/,
    );
    assert.match(
      css,
      /\.composer-overflow-page--tools \.composer-tools-popover__setting[\s\S]*display:\s*none/,
    );
    assert.doesNotMatch(
      css,
      /\.composer-overflow-slot \.composer-tools-popover:not\(\.hidden\)[\s\S]*display:\s*contents/,
    );
    assert.doesNotMatch(css, /max-height:\s*min\(40vh/);
    assert.match(css, /content:\s*'Reasoning'/);
    assert.match(css, /content:\s*'Context documents'/);
    assert.match(css, /content:\s*'Code map'/);
    assert.match(css, /content:\s*'Brain notes'/);
    assert.match(css, /\.composer-overflow-popover \{[\s\S]*?z-index:\s*1200;/);
  });

  test('overflow clamp keeps a fitting sheet inside the chat column', () => {
    const placed = clampComposerOverflowPlacement(
      { top: 400, left: 171, width: 414, height: 485 },
      { width: 1600, height: 1000, columnLeft: 348, columnRight: 1000 },
    );
    assert.equal(placed.left, 356);
    assert.equal(placed.top, 400);
  });

  test('overflow clamp viewport-only when the sheet is wider than the column', () => {
    const placed = clampComposerOverflowPlacement(
      { top: 400, left: 171, width: 414, height: 485 },
      { width: 1600, height: 1000, columnLeft: 348, columnRight: 700 },
    );
    assert.equal(placed.left, 171);
  });

  test('open overflow sheet portals to body and close restores it beside the cog', () => {
    const row = setupComposerDom();
    initModeSelector();
    initComposerCompact();
    syncComposerCompactFromWidth(700);

    const btn = document.getElementById('btnComposerOverflow');
    const popover = document.getElementById('composerOverflowPopover');
    const anchor = document.getElementById('composerOverflowAnchor');
    assert.ok(btn);
    assert.ok(popover);
    assert.ok(anchor);
    assert.equal(row.classList.contains('composer-controls--compact'), true);

    btn.click();
    assert.equal(popover.parentElement, document.body);
    assert.equal(popover.classList.contains('hidden'), false);
    assert.equal(btn.getAttribute('aria-expanded'), 'true');

    btn.click();
    assert.equal(popover.parentElement, anchor);
    assert.equal(popover.classList.contains('hidden'), true);
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
  });

  test('keyboard entry skips hidden settings and Tab exits the portaled sheet at its boundary', () => {
    setupComposerDom();
    initModeSelector();
    initComposerCompact();
    const settings = document.getElementById('composerOverflowSettingsPage')!;
    const hidden = document.createElement('div');
    hidden.hidden = true;
    hidden.innerHTML = '<button>Unavailable setting</button>';
    settings.prepend(hidden);
    const first = document.createElement('button');
    first.textContent = 'Visible setting';
    hidden.after(first);
    const button = document.getElementById('btnComposerOverflow')!;
    button.click();
    assert.equal(document.activeElement, first);
    const tab = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.equal(document.activeElement, button);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
  });

  test('cog opens settings page; Tools nav drills in; Back returns; Escape closes', () => {
    const row = setupComposerDom();
    initModeSelector();
    initComposerCompact();
    syncComposerCompactFromWidth(700);

    const btn = document.getElementById('btnComposerOverflow');
    const settingsPage = document.getElementById('composerOverflowSettingsPage');
    const toolsPage = document.getElementById('composerOverflowToolsPage');
    const nav = document.getElementById('composerOverflowToolsNav');
    const back = document.getElementById('composerOverflowToolsBack');
    const popover = document.getElementById('composerOverflowPopover');
    assert.ok(btn && settingsPage && toolsPage && nav && back && popover);

    btn.click();
    assert.equal(settingsPage.classList.contains('hidden'), false, 'settings visible on open');
    assert.equal(toolsPage.classList.contains('hidden'), true, 'tools hidden on open');
    assert.equal(isComposerOverflowToolsPageOpen(), false, 'tools page flag off on open');
    assert.equal(
      document.getElementById('composerToolsPopover')?.classList.contains('hidden'),
      true,
      'tools popover stays closed on settings page',
    );

    nav.click();
    assert.equal(settingsPage.classList.contains('hidden'), true, 'settings hidden after drill-in');
    assert.equal(toolsPage.hasAttribute('hidden'), false, 'tools hidden attr cleared');
    assert.equal(toolsPage.classList.contains('hidden'), false, 'tools visible after drill-in');
    assert.equal(isComposerOverflowToolsPageOpen(), true, 'tools page flag on');
    assert.equal(
      document.getElementById('composerToolsPopover')?.classList.contains('hidden'),
      false,
      'tools popover inlined on tools page',
    );

    back.click();
    assert.equal(settingsPage.classList.contains('hidden'), false, 'settings visible after back');
    assert.equal(toolsPage.classList.contains('hidden'), true, 'tools hidden after back');
    assert.equal(isComposerOverflowToolsPageOpen(), false, 'tools page flag off after back');

    nav.click();
    const KeyEvent = window.KeyboardEvent;
    document.dispatchEvent(new KeyEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(popover.classList.contains('hidden'), true, 'escape closes sheet from tools page');
    assert.equal(isComposerOverflowToolsPageOpen(), false, 'tools page flag off after escape');
    assert.equal(row.classList.contains('composer-controls--compact'), true, 'still compact');
  });
});
