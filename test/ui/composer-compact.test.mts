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
  slot.append(settingsPage);
  popover.appendChild(slot);
  overflowAnchor.append(overflowBtn, popover);

  trail.append(overflowAnchor);
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
  test('index.html keeps composer settings without a tool permission page', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    assert.match(html, /id="composerOverflowSettingsPage"/);
    assert.match(html, /id="codeComposerModelAnchor"/);
    assert.doesNotMatch(html, /id="composerOverflowToolsPage"/);
    assert.doesNotMatch(html, /id="composerOverflowToolsNav"/);
    assert.doesNotMatch(html, /id="composerOverflowToolsBack"/);
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

  test('footer keeps worktree and model controls while secondary settings move into the cog', () => {
    const row = setupComposerDom();
    initModeSelector();
    initComposerCompact();
    syncComposerCompactFromWidth(700);

    const bar = row.closest('.input-bar');
    const slot = document.getElementById('composerOverflowSlot');
    const thinking = document.getElementById('composerThinkingWrap');
    const worktree = document.createElement('div');
    worktree.id = 'composerRunTargetWrap';
    row.append(worktree);
    const fast = document.getElementById('composerCursorFast');
    const contextDocs = document.getElementById('composerContextDocumentsWrap');
    const wheel = row.querySelector('.context-usage-anchor');
    const dropdown = document.getElementById('modeSelectorDropdown');
    const overflowBtn = document.getElementById('btnComposerOverflow');

    assert.equal(isComposerControlsCompact(), true);
    assert.equal(isComposerControlsNarrow(), false);
    assert.equal(thinking?.parentElement, row, 'effort stays one click away');
    assert.equal(fast?.parentElement, row, 'Fast stays beside effort');
    assert.equal(contextDocs?.parentElement?.id, 'composerOverflowSettingsPage');
    assert.ok(slot);
    assert.equal(wheel?.parentElement, row);
    assert.equal(dropdown?.hidden, true, 'legacy mode dropdown stays hidden');

    assert.equal(dropdown?.parentElement, row);
    assert.equal(overflowBtn?.closest('#composerControls'), row);
    assert.equal(slot?.contains(overflowBtn), false);
    assert.equal(bar?.classList.contains('input-bar--composer-compact'), true);
    assert.equal(document.getElementById('composerOverflowAnchor')?.previousElementSibling, dropdown);

    syncComposerCompactFromWidth(500);
    assert.equal(isComposerControlsNarrow(), true);
    assert.equal(worktree.parentElement, row, 'single worktree control stays accessible at narrow widths');
    assert.equal(thinking?.parentElement, row, 'internal reasoning state stays with the composer');
    assert.equal(fast?.parentElement?.id, 'composerOverflowSettingsPage');
    assert.ok(row.classList.contains('composer-controls--narrow'));

    syncComposerCompactFromWidth(940);
    assert.equal(isComposerControlsNarrow(), false);
    assert.equal(thinking?.parentElement, row);
    assert.equal(fast?.parentElement, row);
    assert.equal(contextDocs?.parentElement?.id, 'composerOverflowSettingsPage');
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

  test('overflow sheet CSS keeps labeled turn controls without a tools page', () => {
    const css = readFileSync(new URL('../../src/styles/composer-overflow.css', import.meta.url), 'utf8');
    assert.match(css, /\.composer-overflow-page--settings/);
    assert.match(css, /\.composer-overflow-settings-lead/);
    assert.doesNotMatch(css, /\.composer-overflow-page--tools/);
    assert.doesNotMatch(css, /\.composer-overflow-tools-nav/);
    assert.match(
      css,
      /\.composer-overflow-page--settings \.thinking-toggle-btn\[aria-pressed='true'\]::before/,
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

  test('cog opens composer settings and Escape closes it', () => {
    setupComposerDom();
    initComposerCompact();
    const button = document.getElementById('btnComposerOverflow')!;
    const popover = document.getElementById('composerOverflowPopover')!;
    button.click();
    assert.equal(popover.classList.contains('hidden'), false);
    assert.equal(document.getElementById('composerOverflowToolsNav'), null);
    document.dispatchEvent(new windowInstance!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(popover.classList.contains('hidden'), true);
  });
});
