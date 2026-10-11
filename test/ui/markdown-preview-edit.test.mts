import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

// DOMPurify binds to window at module load — one window for the file, installed before the imports.
const win = new Window({ url: 'http://localhost:9473/' });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.HTMLElement = win.HTMLElement;
g.DocumentFragment = win.DocumentFragment;
g.Element = win.Element;
const { renderMarkdownSourceBlocks } = await import('../../src/markdown/renderer.ts');
const { mountEditableMarkdownPreview, splitBlockSource } = await import(
  '../../src/ui/markdown-preview-edit.ts'
);

const DOC = [
  '# Title',
  '',
  'First [ref][r] paragraph',
  'second line.',
  '',
  '- a',
  '- b',
  '',
  '[r]: https://example.com',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
].join('\n');

describe('editable markdown preview', () => {
  let preview: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    preview = document.createElement('div');
    document.body.appendChild(preview);
  });

  after(async () => {
    await win.happyDOM.abort();
    await win.happyDOM.close();
  });

  test('blocks map back to exact source ranges', () => {
    const blocks = renderMarkdownSourceBlocks(preview, DOC);
    assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'code']);
    assert.equal(DOC.slice(blocks[0]!.start, blocks[0]!.end), '# Title');
    assert.equal(DOC.slice(blocks[3]!.start, blocks[3]!.end), '```js\nconst x = 1;\n```\n');
    assert.equal(preview.querySelector('h1')?.dataset.mdBlock, '0');
    assert.equal(preview.querySelector('ul')?.dataset.mdBlock, '2');
    // Reference links still resolve when blocks render one at a time.
    assert.equal(preview.querySelector('a')?.getAttribute('href'), 'https://example.com');
  });

  test('splitBlockSource keeps trailing newlines out of the editable body', () => {
    assert.deepEqual(splitBlockSource('```\nx\n```\n'), { body: '```\nx\n```', trailing: '\n' });
    assert.deepEqual(splitBlockSource('# Hi'), { body: '# Hi', trailing: '' });
  });

  test('editing one block splices only that range and re-renders on commit', () => {
    const changes: string[] = [];
    const editor = mountEditableMarkdownPreview(preview, DOC, {
      onChange: (next) => changes.push(next),
    });
    (preview.querySelector('ul li') as HTMLElement).click();
    const textarea = preview.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea, 'clicking a block opens its source');
    assert.equal(textarea.value, '- a\n- b');
    assert.equal(preview.querySelector('ul'), null);

    textarea.value = '- a\n- b\n- c';
    textarea.dispatchEvent(new window.Event('input'));
    assert.equal(changes.at(-1), DOC.replace('- a\n- b', '- a\n- b\n- c'));

    editor.commit();
    assert.equal(preview.querySelector('textarea'), null);
    assert.equal(preview.querySelectorAll('ul li').length, 3);
  });

  test('Escape restores the original block', () => {
    const changes: string[] = [];
    mountEditableMarkdownPreview(preview, DOC, { onChange: (next) => changes.push(next) });
    (preview.querySelector('h1') as HTMLElement).click();
    const textarea = preview.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '# Changed';
    textarea.dispatchEvent(new window.Event('input'));
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(changes.at(-1), DOC);
    assert.equal(preview.querySelector('h1')?.textContent, 'Title');
  });

  test('links stay clickable instead of opening the block', () => {
    mountEditableMarkdownPreview(preview, DOC, { onChange: () => {} });
    const link = preview.querySelector('a') as HTMLElement;
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
    assert.equal(preview.querySelector('textarea'), null);
  });

  test('an empty document offers a place to start writing', () => {
    const changes: string[] = [];
    mountEditableMarkdownPreview(preview, '', { onChange: (next) => changes.push(next) });
    (preview.querySelector('.md-edit-empty') as HTMLElement).click();
    const textarea = preview.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Hello';
    textarea.dispatchEvent(new window.Event('input'));
    assert.equal(changes.at(-1), 'Hello');
  });
});
