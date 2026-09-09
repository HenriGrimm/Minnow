/**
 * Tool result bubbles show GitHub-style +/− badges.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { renderToolCall, renderToolResult } = await import('../../src/ui/tool-messages.ts');

function setupDom() {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  document.body.innerHTML = '<main id="chatArea"></main>';
  return window;
}

describe('renderToolResult codeChange badge', () => {
  /** @type {import('happy-dom').Window | undefined} */
  let window;

  afterEach(() => {
    window?.close();
    window = undefined;
  });

  test('shows + and − on success', () => {
    window = setupDom();
    const wrap = renderToolCall('save_file', { path: 'a.ts' });
    renderToolResult(wrap, 'Saved a.ts', undefined, undefined, {
      additions: 12,
      deletions: 3,
      path: 'a.ts',
    });
    const badge = wrap.querySelector('.tool-call-code-change');
    assert.ok(badge);
    assert.equal(badge.querySelector('.tool-call-code-change__add')?.textContent, '+12');
    assert.equal(badge.querySelector('.tool-call-code-change__del')?.textContent, '−3');
  });

  test('hides badge on error result', () => {
    window = setupDom();
    const wrap = renderToolCall('save_file', { path: 'a.ts' });
    renderToolResult(wrap, 'Error: denied', undefined, undefined, {
      additions: 5,
      deletions: 0,
    });
    assert.equal(wrap.querySelector('.tool-call-code-change'), null);
  });

  test('hides badge when stats are zero', () => {
    window = setupDom();
    const wrap = renderToolCall('move_file', {});
    renderToolResult(wrap, 'Moved', undefined, undefined, {
      additions: 0,
      deletions: 0,
    });
    assert.equal(wrap.querySelector('.tool-call-code-change'), null);
  });

  test('renders unified diff panel when diffLines present', () => {
    window = setupDom();
    const wrap = renderToolCall('save_file', { path: 'a.ts' });
    renderToolResult(wrap, 'Saved', undefined, undefined, {
      additions: 1,
      deletions: 1,
      path: 'a.ts',
      diffLines: [
        { type: 'unchanged', text: 'keep' },
        { type: 'remove', text: 'old' },
        { type: 'add', text: 'new' },
      ],
    });
    const panel = wrap.querySelector('.tool-call-diff');
    assert.ok(panel);
    assert.ok(panel.querySelector('.prompt-diff__line--remove'));
    assert.ok(panel.querySelector('.prompt-diff__line--add'));
    assert.equal(panel.querySelector('.prompt-diff__line--unchanged'), null);
    assert.equal(panel.querySelector('.prompt-diff__lineno')?.textContent, '2');
    // The diff is the card; the raw result is only reachable through the disclosure.
    assert.ok(!wrap.querySelector('.tool-call-body > .tool-call-pre--result'));
    assert.ok(wrap.querySelector('.tool-call-raw-details .tool-call-pre--result'));
  });

  test('badge replaces the text outcome rather than sitting beside it', () => {
    window = setupDom();
    const wrap = renderToolCall('save_file', { path: 'a.ts' });
    renderToolResult(wrap, 'Saved a.ts', undefined, undefined, {
      additions: 4,
      deletions: 0,
      path: 'a.ts',
    });
    const outcome = wrap.querySelector('.tool-call-outcome');
    assert.ok(outcome.querySelector('.tool-call-code-change'));
    assert.equal(outcome.textContent, '+4');
  });
});

describe('renderToolCall row zones', () => {
  /** @type {import('happy-dom').Window | undefined} */
  let window;

  afterEach(() => {
    window?.close();
    window = undefined;
  });

  test('non-file tool leads with its action word', () => {
    window = setupDom();
    const wrap = renderToolCall('web_search', { query: 'oklch' });
    assert.equal(wrap.querySelector('.tool-call-action')?.textContent, 'Search web');
    assert.equal(wrap.querySelector('.tool-call-target')?.textContent, 'oklch');
  });

  test('unknown tool falls back to spaced snake_case', () => {
    window = setupDom();
    const wrap = renderToolCall('my_custom_tool', {});
    assert.equal(wrap.querySelector('.tool-call-action')?.textContent, 'my custom tool');
  });

  test('paths split so the file name survives truncation', () => {
    window = setupDom();
    const wrap = renderToolCall('read_file', { path: 'src/ui/tool-messages.ts' });
    const target = wrap.querySelector('.tool-call-target');
    assert.ok(target?.classList.contains('tool-call-target--path'));
    assert.equal(target.querySelector('.tool-call-target__dir')?.textContent, 'src/ui/');
    assert.equal(target.querySelector('.tool-call-target__base')?.textContent, 'tool-messages.ts');
  });

  test('running rows show a spinner and no outcome', () => {
    window = setupDom();
    const wrap = renderToolCall('read_file', { path: 'a.ts' });
    assert.ok(wrap.querySelector('.tool-call-status .tool-call-spinner'));
    assert.ok(wrap.querySelector('.tool-call-outcome')?.classList.contains('hidden'));
  });

  test('settled rows swap the spinner for the tool glyph and a measurement', () => {
    window = setupDom();
    const wrap = renderToolCall('read_file', { path: 'a.ts' });
    renderToolResult(wrap, 'one\ntwo\nthree');
    assert.equal(wrap.querySelector('.tool-call-spinner'), null);
    assert.ok(wrap.querySelector('.tool-call-status .tool-call-icon'));
    assert.equal(wrap.querySelector('.tool-call-outcome')?.textContent, '3 lines');
  });

  test('failures read as words, with no status pill or check glyph', () => {
    window = setupDom();
    const wrap = renderToolCall('read_file', { path: 'test/missing.md' });
    renderToolResult(wrap, "Error: ENOENT: no such file or directory, stat 'test/missing.md'");
    const outcome = wrap.querySelector('.tool-call-outcome');
    assert.equal(outcome?.textContent, 'not found');
    assert.ok(outcome?.classList.contains('tool-call-outcome--danger'));
    assert.ok(!wrap.querySelector('.tool-call-status-label'));
    assert.match(
      wrap.querySelector('.tool-call-error')?.textContent ?? '',
      /^File or folder not found/,
    );
  });

  test('a structured body keeps the verbatim I/O behind one disclosure', () => {
    window = setupDom();
    const wrap = renderToolCall('list_directory', { path: 'docs' });
    renderToolResult(wrap, '[dir] plans\n[file] readme.md');
    const disclosures = wrap.querySelectorAll('.tool-call-raw-details');
    assert.equal(disclosures.length, 1);
    assert.equal(disclosures[0].querySelector('summary')?.textContent, 'Raw input and output');
    assert.ok(wrap.querySelector('.tool-call-friendly'));
  });

  test('tools without a structured body show output once, with no disclosure', () => {
    window = setupDom();
    const wrap = renderToolCall('web_search', { query: 'oklch' });
    renderToolResult(wrap, 'some results');
    assert.ok(wrap.querySelector('.tool-call-pre--result'));
    assert.equal(wrap.querySelectorAll('.tool-call-raw-details').length, 0);
  });

  test('file card links the path and opens by default', () => {
    window = setupDom();
    const wrap = renderToolCall('save_file', { path: 'src/wait-for-vite.mjs' });
    const target = wrap.querySelector('.tool-call-target--file-link');
    assert.equal(wrap.querySelector('.tool-call-action')?.textContent, 'Write');
    assert.equal(target?.textContent, 'wait-for-vite.mjs');
    assert.equal(target?.tagName, 'BUTTON');
    assert.equal(wrap.dataset.filePath, 'src/wait-for-vite.mjs');
  });

  test('file card is open by default with file-card classes', () => {
    window = setupDom();
    const wrap = renderToolCall('save_file', { path: 'src/wait-for-vite.mjs' });
    const details = wrap.querySelector('.tool-call-details');
    assert.ok(wrap.classList.contains('tool-call-msg--file'));
    assert.ok(details?.classList.contains('tool-call-details--file'));
    assert.equal(details?.open, true);
  });

  test('file card diff header is a clickable open link', () => {
    window = setupDom();
    const wrap = renderToolCall('save_file', { path: 'src/wait-for-vite.mjs' });
    renderToolResult(wrap, 'Saved', undefined, undefined, {
      additions: 1,
      deletions: 0,
      path: 'src/wait-for-vite.mjs',
      diffLines: [{ type: 'add', text: 'new line' }],
    });
    assert.ok(wrap.querySelector('.tool-call-diff__header--link'));
  });

  test('file card shows diff on result', () => {
    window = setupDom();
    const wrap = renderToolCall('save_file', { path: 'src/wait-for-vite.mjs' });
    renderToolResult(wrap, 'Saved', undefined, undefined, {
      additions: 2,
      deletions: 1,
      path: 'src/wait-for-vite.mjs',
      diffLines: [
        { type: 'remove', text: 'old line' },
        { type: 'add', text: 'new line' },
      ],
    });
    const panel = wrap.querySelector('.tool-call-diff');
    assert.ok(panel);
    assert.equal(wrap.querySelector('.tool-call-target')?.textContent, 'wait-for-vite.mjs');
    const badge = wrap.querySelector('.tool-call-code-change');
    assert.equal(badge?.querySelector('.tool-call-code-change__add')?.textContent, '+2');
    assert.equal(badge?.querySelector('.tool-call-code-change__del')?.textContent, '−1');
  });

  test('browser screenshot attachment uses session token on img and link', () => {
    window = setupDom();
    window.__MINNOW_SESSION_TOKEN__ = 'test-session-token';
    const wrap = renderToolCall('browser_screenshot', {});
    renderToolResult(wrap, 'Screenshot saved: abc.png', [
      {
        type: 'image',
        url: '/api/browser/screenshot/abc',
        mime: 'image/png',
        alt: 'Browser screenshot',
      },
    ]);
    const link = wrap.querySelector('.tool-call-screenshot-link');
    const img = wrap.querySelector('.tool-call-screenshot');
    assert.ok(link);
    assert.ok(img);
    assert.match(link.getAttribute('href') ?? '', /token=test-session-token/);
    assert.match(img.getAttribute('src') ?? '', /token=test-session-token/);
  });

  test('run_impeccable detect exit 2 paints as success, not failed', () => {
    window = setupDom();
    const wrap = renderToolCall('run_impeccable', {
      command: 'detect',
      target: 'tool-test/impeccable-probe',
    });
    const result =
      'Error: impeccable detect exited 2\n3 anti-patterns found.\nline 6: [design-system-color] red';
    renderToolResult(wrap, result, undefined, {
      command: 'detect',
      target: 'tool-test/impeccable-probe',
    });
    assert.ok(wrap.classList.contains('tool-call-msg--ok'));
    assert.ok(!wrap.classList.contains('tool-call-msg--fail'));
    assert.equal(wrap.querySelector('.tool-call-error'), null);
    assert.equal(wrap.querySelector('.tool-call-outcome')?.textContent, '3 anti-patterns');
    const raw = wrap.querySelector('.tool-call-pre--result')?.textContent ?? '';
    assert.doesNotMatch(raw, /exited 2/);
    assert.match(raw, /3 anti-patterns found/);
  });
});
