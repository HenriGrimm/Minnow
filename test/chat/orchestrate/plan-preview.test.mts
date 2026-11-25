/**
 * parsePlanFrontMatter — static YAML front matter fixtures.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  buildPlanPreviewDom,
  mountPlanPreviewContent,
  parsePlanFrontMatter,
  planMarkdownForDisplay,
  readPlanArtifactMarkdown,
  splitPlanMarkdown,
} from '../../../src/chat/plans/plan-preview.ts';

const PLAN_MARKDOWN = `---
name: demo-feature
overview: Ship the manual orchestrate board with tests.
todos:
  - id: 11111111-1111-1111-1111-111111111111
    content: Parse plan front matter
    status: pending
  - id: 22222222-2222-2222-2222-222222222222
    content: Build preview DOM
    status: completed
isProject: true
---

# Demo Feature

## Wave Breakdown

### Wave 1 — Setup
`;

describe('parsePlanFrontMatter', () => {
  test('parses name, overview, and todo objects', () => {
    const parsed = parsePlanFrontMatter(PLAN_MARKDOWN);
    assert.equal(parsed.name, 'demo-feature');
    assert.equal(parsed.overview, 'Ship the manual orchestrate board with tests.');
    assert.equal(parsed.todos.length, 2);
    assert.deepEqual(parsed.todos[0], {
      id: '11111111-1111-1111-1111-111111111111',
      content: 'Parse plan front matter',
      status: 'pending',
    });
    assert.deepEqual(parsed.todos[1], {
      id: '22222222-2222-2222-2222-222222222222',
      content: 'Build preview DOM',
      status: 'completed',
    });
  });

  test('returns empty todos when front matter has no todos block', () => {
    const minimal = `---
name: only-title
overview: Short summary
---

# Body
`;
    const parsed = parsePlanFrontMatter(minimal);
    assert.equal(parsed.name, 'only-title');
    assert.equal(parsed.overview, 'Short summary');
    assert.deepEqual(parsed.todos, []);
  });
});

describe('splitPlanMarkdown', () => {
  test('separates body after closing fence', () => {
    const { parsed, bodyMarkdown } = splitPlanMarkdown(PLAN_MARKDOWN);
    assert.equal(parsed.name, 'demo-feature');
    assert.match(bodyMarkdown, /^# Demo Feature/);
    assert.doesNotMatch(bodyMarkdown, /^---/);
  });
});

describe('planMarkdownForDisplay', () => {
  test('uses markdown body when present (not front-matter scalars)', () => {
    const display = planMarkdownForDisplay(PLAN_MARKDOWN);
    assert.match(display, /^# Demo Feature/);
    assert.doesNotMatch(display, /^name:/m);
    assert.doesNotMatch(display, /Ship the manual orchestrate board/);
  });

  test('synthesizes markdown when file has only front matter', () => {
    const minimal = `---
name: only-title
overview: Short summary line
todos:
  - id: 11111111-1111-1111-1111-111111111111
    content: First task
    status: pending
---

`;
    const display = planMarkdownForDisplay(minimal);
    assert.match(display, /^# only-title/);
    assert.match(display, /Short summary line/);
    assert.match(display, /- \[ \] First task/);
  });
});

describe('readPlanArtifactMarkdown', () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  });

  test('loads full file via preview API (not read_file cap)', async () => {
    globalThis.window = { location: { origin: 'http://localhost:9473' } } as Window;

    const body = 'x'.repeat(40_000);
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      assert.match(url, /\/api\/preview\/file\/documentation\/plans\/big-plan\.md/);
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    };

    const markdown = await readPlanArtifactMarkdown('documentation/plans/big-plan.md');
    assert.equal(markdown, body);
    assert.ok(markdown.length > 32_000);
  });

  test('returns empty string for blank path or failed fetch', async () => {
    assert.equal(await readPlanArtifactMarkdown(''), '');
    globalThis.window = { location: { origin: 'http://localhost:9473' } } as Window;
    globalThis.fetch = async () => new Response('missing', { status: 404 });
    assert.equal(await readPlanArtifactMarkdown('documentation/plans/missing.md'), '');
  });

  test('cacheBust is forwarded as a preview query param', async () => {
    globalThis.window = { location: { origin: 'http://localhost:9473' } } as Window;
    let seen = '';
    globalThis.fetch = async (input: RequestInfo | URL) => {
      seen = String(input);
      return new Response('# Spec\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    };
    const markdown = await readPlanArtifactMarkdown('documentation/plans/references/demo-spec.md', {
      cacheBust: 7,
    });
    assert.equal(markdown, '# Spec\n');
    assert.match(seen, /[?&]v=7/);
    assert.match(seen, /[?&]raw=1/);
  });
});

describe('mountPlanPreviewContent', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'HTMLElement');
  });

  test('shows empty placeholder for blank markdown', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;

    const host = document.createElement('div');
    mountPlanPreviewContent(host, '');
    assert.ok(host.querySelector('.plan-preview__empty'));
  });
});

describe('buildPlanPreviewDom', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'HTMLElement');
  });

  test('wraps markdown in plan-preview body with assistant bubble classes', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;

    // Whitespace-only skips marked/DOMPurify in happy-dom; asserts DOM shape only.
    const root = buildPlanPreviewDom(' ', { modeId: 'orchestrate' });

    assert.ok(root.classList.contains('plan-preview'));
    assert.ok(!root.querySelector('.plan-preview__title'));
    assert.ok(!root.querySelector('.plan-preview__overview'));
    const body = root.querySelector('.plan-preview__body');
    assert.ok(body);
    assert.ok(body!.classList.contains('msg-bubble--md'));
  });
});
