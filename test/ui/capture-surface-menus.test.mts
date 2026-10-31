import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { initCaptureSurfaceMenus, resetCaptureSurfaceMenusForTests } from '../../src/ui/capture-surface-menus';
import { closeContextMenu } from '../../src/ui/context-menu';
import { registerMenuContributor, resetMenuRegistryForTests } from '../../src/ui/menu-registry';

const dom = new Window({ url: 'http://localhost/' });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node'] as const) {
  (globalThis as Record<string, unknown>)[name] = name === 'window' ? dom : dom[name];
}
const copied: string[] = [];
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  platform: 'MacIntel', clipboard: { writeText: async (text: string) => { copied.push(text); } },
} });

beforeEach(() => {
  document.body.innerHTML = '<aside>Outside chat</aside><div id="chatArea"><div class="msg" data-chat-id="chat-1"><div class="msg-bubble">First message</div></div><div class="msg"><div class="msg-bubble">Second message</div></div></div>';
  copied.length = 0;
  window.getSelection()?.removeAllRanges();
  registerMenuContributor('issues', () => [
    { id: 'create-issue', label: 'Create issue…', onSelect: () => {} },
    { kind: 'submenu', id: 'add-to-issue', label: 'Add to issue', items: [] },
  ], { kinds: ['chat-message'] });
  initCaptureSurfaceMenus();
});
afterEach(() => {
  closeContextMenu();
  resetCaptureSurfaceMenusForTests();
  resetMenuRegistryForTests();
});
after(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
  dom.close();
});

function rightClick(target = document.querySelector('.msg-bubble')!): MouseEvent {
  const event = new dom.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(event as unknown as Event);
  return event as unknown as MouseEvent;
}
function row(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll<HTMLButtonElement>('.mn-menu__item')]
    .find(item => item.querySelector('.mn-menu__label')?.textContent === label);
  assert.ok(result, `menu has ${label}`);
  return result;
}
function select(node: Node, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

test('text actions precede issue actions and Copy retains the original selection', async () => {
  const bubble = document.querySelector('.msg-bubble')!;
  select(bubble.firstChild!, 0, 5);
  assert.equal(rightClick().defaultPrevented, true);
  assert.equal(row('Cut').disabled, true);
  assert.equal(row('Paste').disabled, true);
  assert.equal(row('Copy').disabled, false);
  row('Create issue…');
  row('Add to issue');
  // Menu focus and subsequent selection changes must not change what gets copied.
  window.getSelection()!.removeAllRanges();
  row('Copy').click();
  await Promise.resolve();
  assert.deepEqual(copied, ['First']);
});

test('Copy without a selection copies the whole message without the capture size limit', async () => {
  const text = 'Long message '.repeat(1000);
  document.querySelector('.msg-bubble')!.textContent = text;
  rightClick();
  row('Copy').click();
  await Promise.resolve();
  assert.deepEqual(copied, [text.trim()]);
});

test('Select All stays in the current chat and can be copied across messages', async () => {
  rightClick();
  row('Select All').click();
  const text = window.getSelection()!.toString();
  assert.ok(text.includes('First message'));
  assert.ok(text.includes('Second message'));
  assert.ok(!text.includes('Outside chat'));
  rightClick();
  row('Copy').click();
  await Promise.resolve();
  assert.deepEqual(copied, [text]);
});

test('a selection in another pane does not replace the clicked message', async () => {
  select(document.querySelector('aside')!.firstChild!, 0, 7);
  rightClick();
  row('Copy').click();
  await Promise.resolve();
  assert.deepEqual(copied, ['First message']);
});

test('message edit fields and previously handled events retain their own editing menu', () => {
  const bubble = document.querySelector('.msg-bubble')!;
  bubble.innerHTML = '<textarea>Draft</textarea><div contenteditable="true"><span>Inline draft</span></div>';
  for (const target of [bubble.querySelector('textarea')!, bubble.querySelector('span')!]) {
    assert.equal(rightClick(target).defaultPrevented, false);
    assert.equal(document.querySelector('.mn-menu'), null);
  }
  bubble.addEventListener('contextmenu', event => event.preventDefault(), { once: true });
  rightClick(bubble);
  assert.equal(document.querySelector('.mn-menu'), null);
});
