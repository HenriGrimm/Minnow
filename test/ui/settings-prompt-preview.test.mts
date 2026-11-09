import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import serverDOMPurify from 'isomorphic-dompurify';
import { mountPromptPreview } from '../../src/ui/settings-prompt-preview.ts';
import {
  closeAgentCenterLightbox,
  isAgentCenterLightboxOpen,
  openAgentCenterLightbox,
} from '../../src/ui/settings-agent-center-lightbox.ts';
import {
  bindShellOverlayTrigger,
  closeShellOverlay,
  isShellOverlayOpen,
  openShellOverlay,
} from '../../src/ui/shell-overlay-state.ts';

let win: Window;
let disposeTrigger: (() => void) | undefined;
const originalSanitize = DOMPurify.sanitize;

beforeEach(() => {
  win = new Window();
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
  DOMPurify.sanitize = serverDOMPurify.sanitize;
});

afterEach(() => {
  closeAgentCenterLightbox();
  closeShellOverlay();
  disposeTrigger?.();
  DOMPurify.sanitize = originalSanitize;
  win.close();
});

test('prompt preview formats Markdown, preserves literal tags and round-trips source edits', () => {
  const body = document.createElement('div');
  const textarea = document.createElement('textarea');
  const source = '## How you work\n\n- **Investigate** first\n\n<env>\nWorking directory: {{cwd}}\n</env>\n\n`<path>`\n\n```html\n<div>example</div>\n```\n\n[Unsafe](javascript:alert(1))';
  textarea.value = source;
  body.appendChild(textarea);
  document.body.appendChild(body);
  mountPromptPreview(body, textarea);
  const preview = body.querySelector<HTMLElement>('[aria-label="Prompt preview"]')!;
  const toggle = body.querySelector('button')!;

  assert.equal(textarea.hidden, true);
  assert.equal(preview.querySelector('h2')?.textContent, 'How you work');
  assert.equal(preview.querySelector('li strong')?.textContent, 'Investigate');
  assert.ok(preview.textContent?.includes('<env>'));
  assert.ok(preview.textContent?.includes('{{cwd}}'));
  assert.ok(preview.textContent?.includes('</env>'));
  assert.equal(preview.querySelector('p code')?.textContent, '<path>');
  assert.ok(preview.querySelector('pre code')?.textContent?.includes('<env>\nWorking directory: {{cwd}}\n</env>'));
  assert.equal(preview.querySelectorAll('pre code')[1]?.textContent, '<div>example</div>\n');
  assert.equal(preview.querySelector('a')?.hasAttribute('href'), false);
  assert.equal(textarea.value, source);

  toggle.click();
  assert.equal(textarea.hidden, false);
  assert.equal(preview.hidden, true);
  assert.equal(document.activeElement, textarea);
  textarea.value = '## Updated\n\nNew **content**';
  toggle.click();
  assert.equal(textarea.hidden, true);
  assert.equal(preview.hidden, false);
  assert.equal(preview.querySelector('h2')?.textContent, 'Updated');
  assert.equal(preview.querySelector('strong')?.textContent, 'content');
});

test('workflow skill preview hides YAML metadata without changing the editable file', () => {
  const body = document.createElement('div');
  const textarea = document.createElement('textarea');
  textarea.value = '---\r\nname: ask\r\ndescription: Answer questions\r\n---\r\n\r\n# Ask\r\n\r\nRead first.';
  const source = textarea.value;
  body.appendChild(textarea);
  document.body.appendChild(body);
  const preview = mountPromptPreview(body, textarea, { stripFrontMatter: true });
  assert.equal(body.querySelector('h1')?.textContent, 'Ask');
  assert.ok(!body.querySelector('.settings-prompt-preview')?.textContent?.includes('name: ask'));
  assert.equal(textarea.value, source);
  textarea.value = '# Restored';
  preview.refresh();
  assert.equal(body.querySelector('h1')?.textContent, 'Restored');
});

test('close button, Escape and backdrop dismiss only the prompt lightbox above Settings', () => {
  document.body.innerHTML = '<button id="settingsTrigger">Settings</button><section id="settingsView"><button id="promptCard">System prompt</button></section>';
  const trigger = document.getElementById('settingsTrigger')!;
  const card = document.getElementById('promptCard')!;
  disposeTrigger = bindShellOverlayTrigger(trigger, 'settings');
  let settingsClosed = 0;
  openShellOverlay('settings', () => { settingsClosed++; });
  const open = () => {
    card.focus();
    openAgentCenterLightbox({ title: 'System prompt', badge: 'Prompt', render: () => {} });
  };
  const assertSettingsStayedOpen = () => {
    assert.equal(isAgentCenterLightboxOpen(), false);
    assert.equal(isShellOverlayOpen('settings'), true);
    assert.equal(settingsClosed, 0);
    assert.equal(document.activeElement, card);
  };

  open();
  const overlay = document.getElementById('agentCenterLightboxOverlay')!;
  const close = overlay.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
  close.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  close.click();
  assertSettingsStayedOpen();

  open();
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true }));
  assertSettingsStayedOpen();

  open();
  overlay.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  overlay.click();
  assertSettingsStayedOpen();
});
