/**
 * Inline subset: markdown → DOM → markdown.
 *
 * The round-trip here only ever runs on blocks the user edited, so a drift
 * costs one paragraph rather than the document — but a paragraph is still the
 * user's writing, so both directions are pinned.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import {
  collectInlineRefs,
  escapeHtml,
  htmlToInline,
  inlineToHtml,
} from '../../src/issues/markdown-inline.ts';

const windows: Window[] = [];

function host(html: string): Element {
  const window = new Window();
  windows.push(window);
  const div = window.document.createElement('div');
  div.innerHTML = html;
  return div as unknown as Element;
}

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

describe('inlineToHtml', () => {
  test('renders the supported marks', () => {
    assert.equal(inlineToHtml('**bold**'), '<strong>bold</strong>');
    assert.equal(inlineToHtml('*em*'), '<em>em</em>');
    assert.equal(inlineToHtml('~~gone~~'), '<s>gone</s>');
    assert.equal(inlineToHtml('`code`'), '<code>code</code>');
  });

  test('does not treat emphasis inside code spans as emphasis', () => {
    assert.equal(inlineToHtml('`a ** b`'), '<code>a ** b</code>');
  });

  test('escapes HTML in text and in code', () => {
    assert.equal(inlineToHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
    assert.equal(inlineToHtml('`<b>`'), '<code>&lt;b&gt;</code>');
  });

  test('renders HTML line breaks in prose while keeping code and unsafe tags literal', () => {
    const rendered = host(inlineToHtml('First.<br><BR/><br />Next. `<br>` <br onclick="bad()">'));
    assert.equal(rendered.querySelectorAll('br').length, 3);
    assert.equal(rendered.querySelector('code')?.textContent, '<br>');
    assert.equal(rendered.textContent, 'First.Next. <br> <br onclick="bad()">');
    assert.equal(htmlToInline(rendered), 'First.\n\n\nNext. `<br>` <br onclick="bad()">');
  });

  test('renders links and images with escaped attributes', () => {
    assert.equal(
      inlineToHtml('[label](https://x.test)'),
      '<a href="https://x.test">label</a>',
    );
    assert.equal(
      inlineToHtml('![alt "q"](/img.png)'),
      '<img src="/img.png" alt="alt &quot;q&quot;">',
    );
  });

  test('adds session token to issue attachment image URLs for browser fetches', () => {
    const globalAny = globalThis as { window?: { __MINNOW_SESSION_TOKEN__?: string } };
    globalAny.window = { __MINNOW_SESSION_TOKEN__: 'test-session-token' };
    const html = inlineToHtml('![shot](/api/issues/attachments?key=MIN-1%2Fscreen.png)');
    assert.match(html, /src="\/api\/issues\/attachments\?key=MIN-1%2Fscreen\.png&amp;token=test-session-token"/);
    delete globalAny.window;
  });

  test('a # inside a URL does not become an issue chip', () => {
    const html = inlineToHtml('[x](https://github.com/o/r/issues/12#note)');
    assert.ok(!html.includes('mn-mention'));
  });

  test('issue mentions become data-carrying chips', () => {
    const html = inlineToHtml('see #MIN-42 please');
    assert.match(html, /data-mention="issue"/);
    assert.match(html, /data-issue-id="MIN-42"/);
    assert.match(html, /contenteditable="false"/);
  });

  test('code mentions carry path and line range', () => {
    const html = inlineToHtml('look at @src/ui/foo.ts:12-34');
    assert.match(html, /data-mention="code"/);
    assert.match(html, /data-path="src\/ui\/foo\.ts"/);
    assert.match(html, /data-start-line="12"/);
    assert.match(html, /data-end-line="34"/);
  });

  test('an @word without a file extension is not a code mention', () => {
    assert.ok(!inlineToHtml('ask @builder about it').includes('mn-mention'));
  });
});

describe('htmlToInline', () => {
  test('reverses the supported marks', () => {
    assert.equal(htmlToInline(host('<strong>bold</strong>')), '**bold**');
    assert.equal(htmlToInline(host('<em>em</em>')), '*em*');
    assert.equal(htmlToInline(host('<s>gone</s>')), '~~gone~~');
    assert.equal(htmlToInline(host('<a href="https://x.test">label</a>')), '[label](https://x.test)');
    assert.equal(htmlToInline(host('<img src="/a.png" alt="alt">')), '![alt](/a.png)');
  });

  test('chooses a backtick run longer than the code it wraps', () => {
    assert.equal(htmlToInline(host('<code>a ` b</code>')), '``a ` b``');
  });

  test('mentions serialize back to the text they were written from', () => {
    const html = inlineToHtml('see #MIN-42 and @src/a.ts:3');
    assert.equal(htmlToInline(host(html)), 'see #MIN-42 and @src/a.ts:3');
  });

  test('unknown elements contribute text, never HTML', () => {
    assert.equal(htmlToInline(host('<div class="x">plain</div>')), 'plain');
    assert.equal(htmlToInline(host('<span style="color:red">red</span>')), 'red');
  });

  test('typed markdown stays markdown rather than being escaped', () => {
    // The audience types `**bold**` by reflex. Escaping it to `\*\*bold\*\*`
    // would make the editor refuse the notation its own file format is made
    // of; instead it becomes real emphasis on the next commit.
    assert.equal(htmlToInline(host('a *em* b')), 'a *em* b');
    assert.equal(htmlToInline(host('**bold**')), '**bold**');
  });

  test('round-trips a mixed line', () => {
    const source = 'A **bold** and *em* with `code` and [a](https://x.test) and #MIN-1';
    assert.equal(htmlToInline(host(inlineToHtml(source))), source);
  });

  test('strips session token from issue attachment images on serialize', () => {
    const globalAny = globalThis as { window?: { __MINNOW_SESSION_TOKEN__?: string } };
    globalAny.window = { __MINNOW_SESSION_TOKEN__: 'test-session-token' };
    const source = '![shot](/api/issues/attachments?key=MIN-1%2Fscreen.png)';
    assert.equal(htmlToInline(host(inlineToHtml(source))), source);
    delete globalAny.window;
  });
});

describe('escapeHtml', () => {
  test('covers the four characters that change parsing', () => {
    assert.equal(escapeHtml('<&">'), '&lt;&amp;&quot;&gt;');
  });
});

describe('collectInlineRefs', () => {
  test('finds issue ids and code refs', () => {
    const refs = collectInlineRefs('Fixes #MIN-1 and #MIN-2 in @src/a.ts:5-9');
    assert.deepEqual(refs.issueIds, ['MIN-1', 'MIN-2']);
    assert.deepEqual(refs.codeRefs, [{ path: 'src/a.ts', startLine: 5, endLine: 9 }]);
  });

  test('dedupes repeated mentions', () => {
    const refs = collectInlineRefs('#MIN-1 #MIN-1 @a.ts:1 @a.ts:1');
    assert.equal(refs.issueIds.length, 1);
    assert.equal(refs.codeRefs.length, 1);
  });

  test('ignores mentions inside code, where they are output not links', () => {
    const refs = collectInlineRefs('```\n#MIN-9 @src/x.ts:1\n```\n\nand `#MIN-8`');
    assert.deepEqual(refs.issueIds, []);
    assert.deepEqual(refs.codeRefs, []);
  });

  test('a bare path with no line number still resolves', () => {
    const refs = collectInlineRefs('open @src/ui/a.ts');
    assert.deepEqual(refs.codeRefs, [
      { path: 'src/ui/a.ts', startLine: undefined, endLine: undefined },
    ]);
  });
});
