import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  applyMarkdownHeadingIds,
  classifyMarkdownHref,
  decorateRenderedMarkdown,
  githubHeadingSlug,
  handleMarkdownLinkClick,
  hardenMarkdownAnchors,
  parseMarkdownLineFragment,
  resetMarkdownLinkRoutingForTests,
  resolveMarkdownWorkspacePath,
  setMarkdownWorkspaceOpenerForTests,
} from '../../src/markdown/links.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

describe('markdown links', () => {
  /** @type {Window | undefined} */
  let win: Window | undefined;

  beforeEach(() => {
    win = new Window({ url: 'http://localhost:9473/#/app/code/chat' });
    installHappyDomGlobals(win);
    resetMarkdownLinkRoutingForTests();
  });

  afterEach(async () => {
    if (win) {
      await teardownHappyDomAsync(win);
      win = undefined;
    }
    resetMarkdownLinkRoutingForTests();
  });

  test('githubHeadingSlug matches GitHub-style fragments', () => {
    assert.equal(githubHeadingSlug('What it is'), 'what-it-is');
    assert.equal(githubHeadingSlug('Overview'), 'overview');
    assert.equal(githubHeadingSlug('  '), 'section');
  });

  test('code blocks and tables remain keyboard reachable after markdown decoration', () => {
    const root = document.createElement('div');
    root.innerHTML = '<pre><code>long code</code></pre><table><tr><td>wide table</td></tr></table><p>Plain text</p>';
    decorateRenderedMarkdown(root);
    assert.equal(root.querySelector('code')?.tabIndex, 0);
    assert.equal(root.querySelector('table')?.tabIndex, 0);
    assert.equal(root.querySelector('p')?.hasAttribute('tabindex'), false);
  });

  test('applyMarkdownHeadingIds suffixes duplicates like GitHub slugger', () => {
    const root = document.createElement('div');
    root.innerHTML = '<h2>Overview</h2><h2>Overview</h2><h3>What it is</h3>';
    applyMarkdownHeadingIds(root);
    const ids = [...root.querySelectorAll('h2, h3')].map((el) => el.id);
    assert.deepEqual(ids, ['overview', 'overview-1', 'what-it-is']);
  });

  test('resolveMarkdownWorkspacePath is relative to the source file directory', () => {
    assert.equal(
      resolveMarkdownWorkspacePath('contributor/architecture.md', 'documentation/context.md'),
      'documentation/contributor/architecture.md',
    );
    assert.equal(resolveMarkdownWorkspacePath('../README.md', 'documentation/context.md'), 'README.md');
    assert.equal(resolveMarkdownWorkspacePath('/README.md', 'documentation/context.md'), 'README.md');
    assert.equal(resolveMarkdownWorkspacePath('src/main.ts', null), 'src/main.ts');
    assert.equal(resolveMarkdownWorkspacePath('../../etc/passwd', 'documentation/context.md'), null);
    assert.equal(resolveMarkdownWorkspacePath('../secret', null), null);
  });

  test('parseMarkdownLineFragment accepts GitHub L-ranges', () => {
    assert.deepEqual(parseMarkdownLineFragment('L12'), { startLine: 12, endLine: 12 });
    assert.deepEqual(parseMarkdownLineFragment('L10-L20'), { startLine: 10, endLine: 20 });
    assert.deepEqual(parseMarkdownLineFragment('L10-20'), { startLine: 10, endLine: 20 });
    assert.equal(parseMarkdownLineFragment('overview'), null);
  });

  test('classifyMarkdownHref keeps in-app hashes pass-through', () => {
    assert.equal(classifyMarkdownHref('#/app/code/chat', null).type, 'pass');
    assert.equal(classifyMarkdownHref('#/wiki/documentation%2Fmanual', null).type, 'pass');
    assert.equal(classifyMarkdownHref('#brain-wiki/entities/foo', null).type, 'pass');
    assert.equal(classifyMarkdownHref('mailto:hi@example.com', null).type, 'pass');
  });

  test('classifyMarkdownHref treats other hashes as in-document headings', () => {
    assert.deepEqual(classifyMarkdownHref('#overview', null), { type: 'heading', id: 'overview' });
    assert.deepEqual(classifyMarkdownHref('#what-it-is', 'documentation/context.md'), {
      type: 'heading',
      id: 'what-it-is',
    });
  });

  test('classifyMarkdownHref resolves workspace files and line fragments', () => {
    assert.deepEqual(classifyMarkdownHref('contributor/setup.md', 'documentation/context.md'), {
      type: 'workspace',
      path: 'documentation/contributor/setup.md',
    });
    assert.deepEqual(classifyMarkdownHref('src/main.ts#L10-L12', null), {
      type: 'workspace',
      path: 'src/main.ts',
      lineRange: { startLine: 10, endLine: 12 },
    });
    assert.deepEqual(classifyMarkdownHref('README.md#install', 'documentation/context.md'), {
      type: 'workspace',
      path: 'documentation/README.md',
      headingId: 'install',
    });
    assert.equal(classifyMarkdownHref('https://example.com/a', null).type, 'http');
    assert.equal(classifyMarkdownHref('javascript:alert(1)', null).type, 'ignore');
  });

  test('in-document hash click does not change the SPA location hash', () => {
    const preview = document.createElement('div');
    preview.className = 'file-viewer-markdown-preview msg-bubble msg-bubble--md';
    const heading = document.createElement('h2');
    heading.textContent = 'Overview';
    preview.appendChild(heading);
    applyMarkdownHeadingIds(preview);
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#overview');
    anchor.textContent = 'Overview';
    preview.appendChild(anchor);
    document.body.appendChild(preview);

    const hashBefore = window.location.hash;
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: anchor, configurable: true });
    handleMarkdownLinkClick(event);

    assert.equal(event.defaultPrevented, true);
    assert.equal(window.location.hash, hashBefore);
    assert.equal(hashBefore.startsWith('#/app/code'), true);
  });

  test('relative markdown file click is intercepted and opened in the viewer', () => {
    const opened: Array<{ path: string; headingId?: string }> = [];
    setMarkdownWorkspaceOpenerForTests((path, headingId) => {
      opened.push({ path, headingId });
    });

    const preview = document.createElement('div');
    preview.className = 'file-viewer-markdown-preview msg-bubble msg-bubble--md';
    preview.dataset.mdSourcePath = 'documentation/context.md';
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'contributor/architecture.md');
    preview.appendChild(anchor);
    document.body.appendChild(preview);

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: anchor, configurable: true });
    handleMarkdownLinkClick(event);

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(opened, [{ path: 'documentation/contributor/architecture.md', headingId: undefined }]);
    assert.equal(window.location.hash, '#/app/code/chat');
  });

  test('in-app hash links are not preventDefaulted', () => {
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble msg-bubble--md';
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#/app/issues');
    bubble.appendChild(anchor);
    document.body.appendChild(bubble);

    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: anchor, configurable: true });
    handleMarkdownLinkClick(event);

    assert.equal(event.defaultPrevented, false);
  });

  test('hardenMarkdownAnchors adds new-tab fallback except for in-app hashes', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<a href="foo.md">file</a><a href="#overview">head</a><a href="#/app/code">app</a>';
    hardenMarkdownAnchors(root);
    const [file, head, app] = [...root.querySelectorAll('a')];
    assert.equal(file.target, '_blank');
    assert.equal(head.target, '_blank');
    assert.equal(app.target, '');
  });
});
