/**
 * Composer Expand button — mounting, enabled state, streaming apply, cancel.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { initComposerExpand, setExpandPromptFetcherForTests, isComposerExpanding } =
  await import('../../src/ui/composer-expand.ts');

let domWindow: Window | null = null;

function setupDom(): void {
  const window = new Window();
  domWindow = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globalThis.Event = window.Event;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  globalThis.Node = window.Node;
  globalThis.window = window as unknown as Window & typeof globalThis;

  document.body.innerHTML = `
    <div id="composerInsetActions">
      <button type="button" id="attachBtn"></button>
      <button type="button" id="btnComposerMic"></button>
    </div>
    <textarea id="msgInput"></textarea>
    <div class="chat-app-input">
      <button type="button" id="btnChatAppAttach"></button>
    </div>
    <textarea id="chatAppInput"></textarea>
    <div id="sDot"></div>
    <div id="sText"></div>
    <div id="osStatusDot"></div>
    <div id="osStatusText"></div>
  `;
}

function codeButton(): HTMLButtonElement {
  const btn = document.getElementById('btnComposerExpand');
  assert.ok(btn instanceof HTMLButtonElement, 'expand button should be mounted');
  return btn;
}

function codeInput(): HTMLTextAreaElement {
  return document.getElementById('msgInput') as HTMLTextAreaElement;
}

function typeInto(input: HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  setupDom();
});

afterEach(() => {
  setExpandPromptFetcherForTests(null);
  domWindow?.close();
  domWindow = null;
});

describe('initComposerExpand mounting', () => {
  test('mounts after the mic on Code and after attach on Chat', () => {
    initComposerExpand();

    const code = codeButton();
    assert.equal(code.previousElementSibling?.id, 'btnComposerMic');
    assert.ok(code.classList.contains('input-inset-btn'));

    const chat = document.getElementById('btnChatAppExpand');
    assert.ok(chat instanceof HTMLButtonElement);
    assert.equal(chat.previousElementSibling?.id, 'btnChatAppAttach');
  });

  test('is idempotent — a second init does not duplicate buttons', () => {
    initComposerExpand();
    initComposerExpand();
    assert.equal(document.querySelectorAll('#btnComposerExpand').length, 1);
  });

  test('starts disabled and follows whether the composer has text', () => {
    initComposerExpand();
    const btn = codeButton();
    const input = codeInput();

    assert.equal(btn.disabled, true);

    typeInto(input, 'add dark mode');
    assert.equal(btn.disabled, false);

    typeInto(input, '   ');
    assert.equal(btn.disabled, true);
  });
});

describe('expanding', () => {
  test('streams partials into the composer and keeps the final text', async () => {
    const seen: string[] = [];
    setExpandPromptFetcherForTests(async (req) => {
      req.onPartial?.('Add a dark');
      seen.push(codeInput().value);
      req.onPartial?.('Add a dark mode toggle');
      seen.push(codeInput().value);
      return { text: 'Add a dark mode toggle to the settings page.' };
    });

    initComposerExpand();
    const input = codeInput();
    typeInto(input, 'dark mode');
    codeButton().click();
    await settle();

    assert.deepEqual(seen, ['Add a dark', 'Add a dark mode toggle']);
    assert.equal(input.value, 'Add a dark mode toggle to the settings page.');
    assert.equal(input.readOnly, false);
    assert.equal(isComposerExpanding(), false);
  });

  test('fires input listeners once on the settled value, not per chunk', async () => {
    setExpandPromptFetcherForTests(async (req) => {
      req.onPartial?.('one');
      req.onPartial?.('one two');
      req.onPartial?.('one two three');
      return { text: 'one two three four' };
    });

    initComposerExpand();
    const input = codeInput();
    typeInto(input, 'dark mode');

    // Count only events raised by the expansion, not the typing above.
    let events = 0;
    input.addEventListener('input', () => {
      events += 1;
    });

    codeButton().click();
    await settle();

    assert.equal(events, 1, 'streaming partials must not notify draft/sidebar listeners');
    assert.equal(input.value, 'one two three four');
  });

  test('notifies listeners when a cancel restores the draft', async () => {
    setExpandPromptFetcherForTests(
      (req) =>
        new Promise((resolve) => {
          req.onPartial?.('partial');
          req.signal.addEventListener('abort', () => resolve({ text: null }), { once: true });
        }),
    );

    initComposerExpand();
    const input = codeInput();
    typeInto(input, 'dark mode');
    const btn = codeButton();
    btn.click();
    await settle();

    let events = 0;
    input.addEventListener('input', () => {
      events += 1;
    });
    btn.click();
    await settle();

    assert.equal(events, 1);
    assert.equal(input.value, 'dark mode');
  });

  test('passes the draft through and never sends it', async () => {
    let draft = '';
    setExpandPromptFetcherForTests(async (req) => {
      draft = req.draft;
      return { text: 'expanded' };
    });

    initComposerExpand();
    typeInto(codeInput(), 'dark mode');
    codeButton().click();
    await settle();

    assert.equal(draft, 'dark mode');
    // No send button exists in this DOM; the text stays put for the user.
    assert.equal(codeInput().value, 'expanded');
  });

  test('marks the button busy and locks the input while streaming', async () => {
    let release: (() => void) | null = null;
    setExpandPromptFetcherForTests(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { text: 'expanded' };
    });

    initComposerExpand();
    const btn = codeButton();
    const input = codeInput();
    typeInto(input, 'dark mode');
    btn.click();
    await settle();

    assert.equal(isComposerExpanding(), true);
    assert.equal(btn.getAttribute('aria-busy'), 'true');
    assert.ok(btn.classList.contains('composer-expand-btn--busy'));
    assert.equal(input.readOnly, true);
    assert.ok(input.classList.contains('composer-expanding'));

    release?.();
    await settle();

    assert.equal(btn.getAttribute('aria-busy'), 'false');
    assert.equal(input.readOnly, false);
    assert.equal(input.classList.contains('composer-expanding'), false);
  });

  test('restores the original draft when the model errors', async () => {
    setExpandPromptFetcherForTests(async () => ({ text: null, error: 'boom' }));

    initComposerExpand();
    const input = codeInput();
    typeInto(input, 'dark mode');
    codeButton().click();
    await settle();

    assert.equal(input.value, 'dark mode');
  });

  test('restores the original draft on empty output', async () => {
    setExpandPromptFetcherForTests(async (req) => {
      req.onPartial?.('partial text');
      return { text: null };
    });

    initComposerExpand();
    const input = codeInput();
    typeInto(input, 'dark mode');
    codeButton().click();
    await settle();

    assert.equal(input.value, 'dark mode');
  });

  test('clicking while busy cancels and restores the draft', async () => {
    setExpandPromptFetcherForTests(
      (req) =>
        new Promise((resolve) => {
          req.onPartial?.('half an expansion');
          req.signal.addEventListener('abort', () => resolve({ text: null }), { once: true });
        }),
    );

    initComposerExpand();
    const btn = codeButton();
    const input = codeInput();
    typeInto(input, 'dark mode');
    btn.click();
    await settle();
    assert.equal(input.value, 'half an expansion');

    btn.click();
    await settle();

    assert.equal(input.value, 'dark mode');
    assert.equal(isComposerExpanding(), false);
  });

  test('Escape in the composer cancels a running expansion', async () => {
    setExpandPromptFetcherForTests(
      (req) =>
        new Promise((resolve) => {
          req.onPartial?.('half an expansion');
          req.signal.addEventListener('abort', () => resolve({ text: null }), { once: true });
        }),
    );

    initComposerExpand();
    const input = codeInput();
    typeInto(input, 'dark mode');
    codeButton().click();
    await settle();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    assert.equal(input.value, 'dark mode');
    assert.equal(isComposerExpanding(), false);
  });

  test('does nothing when the composer is empty', async () => {
    let called = 0;
    setExpandPromptFetcherForTests(async () => {
      called += 1;
      return { text: 'expanded' };
    });

    initComposerExpand();
    codeButton().click();
    await settle();

    assert.equal(called, 0);
  });
});

describe('undoing an expansion', () => {
  function undoButton(): HTMLButtonElement {
    const btn = codeButton().nextElementSibling;
    assert.ok(
      btn instanceof HTMLButtonElement && btn.classList.contains('composer-expand-undo-btn'),
      'undo button should sit right after expand',
    );
    return btn;
  }

  function ctrlZ(input: HTMLTextAreaElement): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    return event;
  }

  async function expand(to: string): Promise<HTMLTextAreaElement> {
    setExpandPromptFetcherForTests(async () => ({ text: to }));
    initComposerExpand();
    const input = codeInput();
    typeInto(input, 'dark mode');
    codeButton().click();
    await settle();
    return input;
  }

  test('undo button is hidden until an expansion lands', async () => {
    initComposerExpand();
    assert.equal(undoButton().hidden, true);
    await expand('Add a dark mode toggle.');
    assert.equal(undoButton().hidden, false);
  });

  test('Ctrl+Z restores the pre-expansion draft', async () => {
    const input = await expand('Add a dark mode toggle.');
    const event = ctrlZ(input);

    assert.equal(event.defaultPrevented, true);
    assert.equal(input.value, 'dark mode');
    assert.equal(undoButton().hidden, true);
  });

  test('clicking undo restores the draft and notifies listeners once', async () => {
    const input = await expand('Add a dark mode toggle.');
    let events = 0;
    input.addEventListener('input', () => {
      events += 1;
    });

    undoButton().click();

    assert.equal(input.value, 'dark mode');
    assert.equal(events, 1);
    assert.equal(undoButton().hidden, true);
  });

  /** Keystrokes change the value natively, bypassing any JS-level setter. */
  function userTypes(input: HTMLTextAreaElement, value: string): void {
    let proto = Object.getPrototypeOf(input);
    while (proto && !Object.getOwnPropertyDescriptor(proto, 'value')?.set) {
      proto = Object.getPrototypeOf(proto);
    }
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  test('Ctrl+Z falls through to native undo once the user edits', async () => {
    const input = await expand('Add a dark mode toggle.');
    userTypes(input, 'Add a dark mode toggle. Also light.');
    assert.equal(undoButton().hidden, true);

    const event = ctrlZ(input);
    assert.equal(event.defaultPrevented, false);
    assert.equal(input.value, 'Add a dark mode toggle. Also light.');

    // Native undo back to the expanded text re-arms it.
    userTypes(input, 'Add a dark mode toggle.');
    assert.equal(undoButton().hidden, false);
    ctrlZ(input);
    assert.equal(input.value, 'dark mode');
  });

  test('a programmatic write (send, chat switch) disarms the undo', async () => {
    const input = await expand('Add a dark mode toggle.');
    input.value = '';
    assert.equal(undoButton().hidden, true);

    input.value = 'Add a dark mode toggle.';
    assert.equal(ctrlZ(input).defaultPrevented, false);
    assert.equal(input.value, 'Add a dark mode toggle.');
    assert.equal(Object.prototype.hasOwnProperty.call(input, 'value'), false);
  });

  test('a cancelled or failed expansion leaves nothing to undo', async () => {
    setExpandPromptFetcherForTests(async () => ({ text: null, error: 'boom' }));
    initComposerExpand();
    const input = codeInput();
    typeInto(input, 'dark mode');
    codeButton().click();
    await settle();

    assert.equal(undoButton().hidden, true);
    assert.equal(ctrlZ(input).defaultPrevented, false);
  });
});

describe('bar composers (Research and Super Plan)', () => {
  function mountBarComposer(inputId: string, btnId: string): HTMLTextAreaElement {
    document.body.innerHTML = `
      <textarea id="${inputId}"></textarea>
      <button type="button" class="composer-expand-btn composer-expand-btn--bar" id="${btnId}"></button>
    `;
    initComposerExpand();
    return document.getElementById(inputId) as HTMLTextAreaElement;
  }

  test('Research prebuilt button binds in place and expands #researchQuery', async () => {
    setExpandPromptFetcherForTests(async () => ({
      text: 'Compare the leading options for offline sync with benchmarks and tradeoffs.',
    }));

    const input = mountBarComposer('researchQuery', 'btnResearchExpand');
    const btn = document.getElementById('btnResearchExpand') as HTMLButtonElement;

    assert.equal(btn.disabled, true);
    typeInto(input, 'compare sync options');
    assert.equal(btn.disabled, false);

    btn.click();
    await settle();

    assert.equal(
      input.value,
      'Compare the leading options for offline sync with benchmarks and tradeoffs.',
    );
  });

  test('Super Plan prebuilt button binds under a disconnected root', async () => {
    setExpandPromptFetcherForTests(async () => ({
      text: 'Add offline queueing to the sync layer with retry semantics and idempotency.',
    }));

    const root = document.createElement('div');
    root.innerHTML = `
      <textarea id="superPlanPrompt"></textarea>
      <button type="button" class="composer-expand-btn composer-expand-btn--bar" id="btnSuperPlanExpand"></button>
    `;
    initComposerExpand(root);

    const input = root.querySelector('#superPlanPrompt') as HTMLTextAreaElement;
    const btn = root.querySelector('#btnSuperPlanExpand') as HTMLButtonElement;

    input.value = 'offline queue';
    input.dispatchEvent(new domWindow!.Event('input', { bubbles: true }));
    assert.equal(btn.disabled, false);

    btn.click();
    await settle();

    assert.match(
      input.value,
      /Add offline queueing to the sync layer/,
    );
  });
});
