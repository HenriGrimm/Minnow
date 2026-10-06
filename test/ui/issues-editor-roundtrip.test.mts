/**
 * Editor round-trip — §13's blocking gate, exercised through the real editor.
 *
 * The scenario is the one that matters: an agent writes a description full of
 * markdown the editor cannot represent, the user opens it and edits one
 * paragraph in the middle, and everything they did not touch must come back
 * byte-identical.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const windows: Window[] = [];

async function mountEditor(value: string, issueId?: string): Promise<{
  handle: Awaited<ReturnType<typeof importEditor>>['createIssueEditor'] extends (
    host: HTMLElement,
    options: infer O,
  ) => infer R
    ? R
    : never;
  host: HTMLElement;
  body: HTMLElement;
  changes: string[];
}> {
  const window = new Window({ url: 'http://localhost/' });
  windows.push(window);
  const globalAny = globalThis as Record<string, unknown>;
  globalAny.window = window;
  globalAny.document = window.document;
  globalAny.Node = window.Node;
  globalAny.NodeFilter = window.NodeFilter;
  globalAny.HTMLElement = window.HTMLElement;
  globalAny.Element = window.Element;

  const { createIssueEditor } = await importEditor();
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.appendChild(host as unknown as never);

  const changes: string[] = [];
  const handle = createIssueEditor(host, {
    value,
    issueId,
    onChange: (markdown: string) => changes.push(markdown),
  });
  const body = host.querySelector('.mn-editor__body') as HTMLElement;
  return { handle, host, body, changes } as never;
}

function importEditor(): Promise<typeof import('../../src/ui/issue-editor')> {
  return import('../../src/ui/issue-editor');
}


afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

test('dropping an image inserts it inline, persists its record, and survives reopening', async () => {
  const store = await import('../../src/state/issues-store.ts');
  const config = await import('../../src/tools/config.ts');
  store.setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
  const issue = store.addIssue({ title: 'Image context', description: 'Before after' });
  const { body, handle } = await mountEditor('Before after', issue.id);
  const originalFetch = globalThis.fetch;
  config.setLocalServerAvailableForTests(true);
  globalThis.fetch = (async () => new Response(JSON.stringify({ attachment: {
    key: `${issue.id}/screen.png`, name: 'screen.png', path: `/attachments/${issue.id}/screen.png`, mime: 'image/png', bytes: 3,
  } }), { status: 200 })) as typeof fetch;
  try {
    const range = document.createRange();
    range.setStart(body.querySelector('p')!.firstChild!, 7);
    range.collapse(true);
    window.getSelection()!.addRange(range);
    const event = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [
      { name: 'screen.png', type: 'image/png', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
    ] } });
    body.dispatchEvent(event);
    for (let i = 0; i < 100 && !store.findIssueById(issue.id)?.attachments?.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(event.defaultPrevented, true);
    assert.equal(store.findIssueById(issue.id)?.attachments?.length, 1);
    const markdown = handle.getValue();
    assert.match(markdown, /^Before !\[screen.png\]/);
    assert.match(markdown, /after$/);
    handle.setValue(markdown);
    assert.equal(body.querySelector('img')?.getAttribute('src'), `/api/issues/attachments?key=${issue.id}%2Fscreen.png`);
    assert.equal(handle.flush(), markdown);
  } finally {
    globalThis.fetch = originalFetch;
    config.setLocalServerAvailableForTests(false);
    store.setIssuesStateForTests(null);
  }
});

test('draft image metadata survives expansion and attaches when the issue is created', async () => {
  const store = await import('../../src/state/issues-store.ts');
  const config = await import('../../src/tools/config.ts');
  store.setIssuesStateForTests({ version: 2, schemaRevision: 3, nextId: 1, issues: [] });
  const { body, handle } = await mountEditor('Draft context');
  const originalFetch = globalThis.fetch;
  config.setLocalServerAvailableForTests(true);
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ attachment: {
      key: `${request.issueId}/screen.png`, name: 'screen.png', path: `/attachments/${request.issueId}/screen.png`, mime: 'image/png', bytes: 3,
    } }));
  }) as typeof fetch;
  try {
    const event = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [
      { name: 'screen.png', type: 'image/png', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
    ] } });
    body.dispatchEvent(event);
    await handle.waitForImages();
    const markdown = `${handle.flush()}\n\nExpanded acceptance criteria`;
    handle.setValue(markdown);
    const issue = store.addIssue({ title: 'Created with image', description: handle.flush() });
    handle.attachImagesToIssue(issue.id);
    assert.match(issue.description, /!\[screen.png\]/);
    assert.equal(store.findIssueById(issue.id)?.attachments?.length, 1);
    assert.match(store.findIssueById(issue.id)!.attachments![0].path, /\/draft-/);
    handle.setValue('');
    assert.equal(handle.getValue(), '');
  } finally {
    globalThis.fetch = originalFetch;
    config.setLocalServerAvailableForTests(false);
    store.setIssuesStateForTests(null);
  }
});

/** A description shaped like something an agent would actually write. */
const AGENT_DOC = [
  '---',
  'generated-by: builder',
  '---',
  '',
  '## Findings',
  '',
  'The parser drops the second frame.',
  '',
  '<details>',
  '<summary>Full log</summary>',
  '',
  '    raw indented output',
  '</details>',
  '',
  '- [ ] reproduce',
  '- [x] locate',
  '',
  '```ts',
  'const x: number = 1;',
  '```',
  '',
  'See the note[^1] for context.',
  '',
  '[^1]: Filed against the old parser.',
  '',
  '[docs]: https://example.com "Reference"',
].join('\n');

describe('issue editor round-trip', () => {
  test('an untouched document serializes back byte-identically', async () => {
    const { handle } = await mountEditor(AGENT_DOC);
    assert.equal(handle.getValue(), AGENT_DOC);
  });

  test('markdown outside the rich-text subset provides source inputs', async () => {
    const { body } = await mountEditor(AGENT_DOC);
    const raw = Array.from(body.querySelectorAll('.mn-editor__raw'));
    const reasons = raw.map((el) => el.querySelector('.mn-editor__raw-label')?.textContent?.split(' · ')[0]);

    assert.ok(reasons.includes('front matter'));
    assert.ok(reasons.includes('HTML'));
    assert.ok(reasons.includes('footnote'));
    assert.ok(reasons.includes('link definition'));
    for (const el of raw) {
      assert.equal(el.getAttribute('contenteditable'), 'false');
      assert.ok(el.querySelector('textarea[aria-label]'));
    }
  });

  for (const source of [
    '1. **Export targets:**\n   * **Chat transcript**: HTML\n   * **Board run**: summary\n2. **Mechanics:** render it',
    '<details>\n<summary>Full log</summary>\n<div data-kind="log">Old value</div>\n</details>',
    '[^1]: Old value',
  ]) {
    test(`source edits persist without changing adjacent blocks: ${source.split('\n')[0]}`, async () => {
      const original = `## Before\n\n${source}\n\nAfter **unchanged**.`;
      const { handle, body, changes } = await mountEditor(original);
      const area = body.querySelector<HTMLTextAreaElement>('.mn-editor__raw-source');
      assert.ok(area);
      assert.equal(area.value, source);
      const edited = source.replace(/HTML|Old value/, 'Updated <value>');
      area.value = edited;
      area.dispatchEvent(new window.Event('input', { bubbles: true }));
      const expected = original.replace(source, edited);
      assert.equal(handle.getValue(), expected);
      assert.equal(handle.flush(), expected);
      assert.equal(handle.flush(), expected);
      assert.deepEqual(changes, [expected]);
      handle.setValue(expected);
      assert.equal(handle.getValue(), expected);
      assert.equal(body.querySelector('value'), null, 'source HTML is never executed');
    });
  }

  test('source paste stays native and blur saves even without an input event', async () => {
    const { handle, body, changes } = await mountEditor('<div>Old</div>');
    const area = body.querySelector<HTMLTextAreaElement>('textarea')!;
    const paste = new window.Event('paste', { bubbles: true, cancelable: true });
    area.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, false);
    area.value = '<div>New</div>';
    area.dispatchEvent(new window.FocusEvent('blur', { bubbles: false }));
    assert.deepEqual(changes, ['<div>New</div>']);
    handle.destroy();
    assert.deepEqual(changes, ['<div>New</div>']);
  });

  test('source fields keep Enter native and support Ctrl+Enter to commit', async () => {
    const { body, changes } = await mountEditor('<div>Old</div>');
    const area = body.querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = '<div>New</div>';
    const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    area.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, false);
    assert.deepEqual(changes, []);
    const commit = new window.KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    });
    area.dispatchEvent(commit);
    assert.equal(commit.defaultPrevented, true);
    assert.deepEqual(changes, ['<div>New</div>']);
  });

  test('editing one paragraph leaves every other byte alone', async () => {
    const { handle, body } = await mountEditor(AGENT_DOC);

    const para = Array.from(body.querySelectorAll('.mn-editor__para')).find((el) =>
      el.textContent?.includes('drops the second frame'),
    );
    assert.ok(para, 'expected the paragraph to be its own editable block');

    // Simulate a typed edit: the editor reads the DOM back for dirty blocks.
    para.textContent = 'The parser drops the third frame.';
    body.dispatchEvent(new (windows[0] as unknown as Window).Event('input', { bubbles: true }));

    // `input` alone only marks dirty; the value is read on demand.
    const out = handle.getValue();
    assert.equal(out, AGENT_DOC.replace('the second frame', 'the third frame'));
    assert.ok(out.includes('generated-by: builder'));
    assert.ok(out.includes('<summary>Full log</summary>'));
    assert.ok(out.includes('    raw indented output'));
    assert.ok(out.includes('[^1]: Filed against the old parser.'));
    assert.ok(out.includes('[docs]: https://example.com "Reference"'));
  });

  test('checklists render as real checkboxes reflecting their state', async () => {
    const { body } = await mountEditor(AGENT_DOC);
    const boxes = Array.from(
      body.querySelectorAll('.mn-editor__task-box'),
    ) as unknown as HTMLInputElement[];
    assert.equal(boxes.length, 2);
    assert.equal(boxes[0].checked, false);
    assert.equal(boxes[1].checked, true);
  });

  test('setValue replaces the document and keeps it lossless', async () => {
    const { handle } = await mountEditor('start');
    handle.setValue(AGENT_DOC);
    assert.equal(handle.getValue(), AGENT_DOC);
  });

  test('an empty description mounts without inventing content', async () => {
    const { handle, body } = await mountEditor('');
    assert.equal(handle.getValue(), '');
    assert.ok(body.classList.contains('is-empty'));
  });

  test('empty descriptions seed an editable paragraph, not a locked blank', async () => {
    const { body } = await mountEditor('');
    const para = body.querySelector('.mn-editor__para');
    assert.ok(para, 'empty editor must offer a paragraph to type into');
    assert.notEqual(para.getAttribute('contenteditable'), 'false');
  });

  test('typing into an empty description is readable back', async () => {
    const { handle, body } = await mountEditor('');
    const para = body.querySelector('.mn-editor__para');
    assert.ok(para);
    para.textContent = 'Filed from the new-issue form.';
    body.dispatchEvent(new (windows[0] as unknown as Window).Event('input', { bubbles: true }));
    assert.equal(handle.getValue(), 'Filed from the new-issue form.');
  });

  test('flush commits an empty-document edit through onChange', async () => {
    const { handle, body, changes } = await mountEditor('');
    const para = body.querySelector('.mn-editor__para');
    assert.ok(para);
    para.textContent = 'Saved on create.';
    body.dispatchEvent(new (windows[0] as unknown as Window).Event('input', { bubbles: true }));
    handle.flush();
    assert.equal(changes.at(-1), 'Saved on create.');
  });

  test('browser-inserted nodes without a block id are still serialized', async () => {
    const { handle, body } = await mountEditor('');
    const extra = body.ownerDocument.createElement('div');
    extra.textContent = 'Orphan typed node';
    body.appendChild(extra);
    body.dispatchEvent(new (windows[0] as unknown as Window).Event('input', { bubbles: true }));
    assert.equal(handle.getValue(), 'Orphan typed node');
  });

  test('a new paragraph typed after existing content is kept', async () => {
    const { handle, body } = await mountEditor('Original line.');
    const extra = body.ownerDocument.createElement('p');
    extra.textContent = 'Second line.';
    body.appendChild(extra);
    body.dispatchEvent(new (windows[0] as unknown as Window).Event('input', { bubbles: true }));
    const out = handle.getValue();
    assert.match(out, /Original line/);
    assert.match(out, /Second line/);
  });

  test('destroy flushes before the node is removed', async () => {
    const { handle, body, changes } = await mountEditor('');
    const para = body.querySelector('.mn-editor__para');
    assert.ok(para);
    para.textContent = 'Kept after remount.';
    body.dispatchEvent(new (windows[0] as unknown as Window).Event('input', { bubbles: true }));
    handle.destroy();
    assert.equal(changes.at(-1), 'Kept after remount.');
  });

  test('text deleted with select-all does not come back under the replacement', async () => {
    const { handle, body } = await mountEditor('test 1');
    // Select-all + delete removes the block element outright; typing then puts a
    // bare text node in the body. The deleted block must not survive in the model.
    body.replaceChildren();
    body.appendChild(body.ownerDocument.createTextNode('test 2'));
    body.dispatchEvent(new (windows[0] as unknown as Window).Event('input', { bubbles: true }));
    assert.equal(handle.getValue(), 'test 2');
  });

  test('clearing the description leaves it empty, not half-restored', async () => {
    const { handle, body } = await mountEditor('test 1' + '\n' + '\n' + 'test 2');
    body.replaceChildren(body.ownerDocument.createElement('br'));
    body.dispatchEvent(new (windows[0] as unknown as Window).Event('input', { bubbles: true }));
    assert.equal(handle.getValue(), '');
  });

  test('an emptied body with no placeholder at all is treated as teardown', async () => {
    // innerHTML = '' during a remount must never be read as "the user deleted it".
    const { handle, body } = await mountEditor('Live text.');
    body.replaceChildren();
    assert.equal(handle.getValue(), 'Live text.');
  });

  test('flushing twice does not append the document to itself', async () => {
    const { handle, body, changes } = await mountEditor('test');
    const para = body.querySelector('[data-block-id]') as HTMLElement;
    para.textContent = 'Hello';
    body.dispatchEvent(new (windows[0] as unknown as Window).Event('input', { bubbles: true }));
    assert.equal(handle.flush(), 'Hello');
    assert.equal(handle.flush(), 'Hello');
    assert.equal(handle.getValue(), 'Hello');
    assert.deepEqual(changes, ['Hello']);
  });

  test('a re-entrant onChange that tears the editor down cannot double the body', async () => {
    // The real panel path: onChange writes the store, the store emit repaints
    // the detail panel, and the repaint destroys this editor — which flushes
    // again. Before the fix that second flush read a DOM belonging to the
    // previous parse and wrote the body twice over.
    const window = new Window({ url: 'http://localhost/' });
    windows.push(window);
    const globalAny = globalThis as Record<string, unknown>;
    globalAny.window = window;
    globalAny.document = window.document;
    globalAny.Node = window.Node;
    globalAny.NodeFilter = window.NodeFilter;
    globalAny.HTMLElement = window.HTMLElement;
    globalAny.Element = window.Element;

    const { createIssueEditor } = await importEditor();
    const host = window.document.createElement('div') as unknown as HTMLElement;
    window.document.body.appendChild(host as unknown as never);

    const changes: string[] = [];
    let handle: ReturnType<typeof createIssueEditor> | undefined;
    handle = createIssueEditor(host, {
      value: 'test',
      onChange: (markdown: string) => {
        changes.push(markdown);
        if (changes.length === 1) handle?.destroy();
      },
    });
    const body = host.querySelector('.mn-editor__body') as unknown as HTMLElement;
    (body.querySelector('[data-block-id]') as HTMLElement).textContent = 'Hello';
    body.dispatchEvent(new window.Event('blur') as unknown as Event);

    assert.deepEqual(changes, ['Hello']);
  });
});

test('an unsaved issue draft opens over LAN HTTP without crypto.randomUUID', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } });
  try {
    const { handle } = await mountEditor('');
    assert.equal(handle.getValue(), '');
    handle.destroy();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});
