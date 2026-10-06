/**
 * User bubbles restore `/skill-id` chips instead of dropping the audit footer.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { renderUserMessageBubble } = await import('../../src/ui/user-message-bubble.ts');

let domWindow: Window | null = null;

function setupDom(): HTMLDivElement {
  const window = new Window();
  domWindow = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLDivElement = window.HTMLDivElement;
  globalThis.window = window as unknown as Window & typeof globalThis;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  document.body.appendChild(bubble);
  return bubble;
}

afterEach(() => {
  domWindow?.happyDOM.close();
  domWindow = null;
});

describe('user message skill chips', () => {
  test('renders a chip for a skill-only send', () => {
    const bubble = setupDom();
    renderUserMessageBubble(bubble, '[skill: impeccable]');
    const chip = bubble.querySelector('.skill-chip');
    assert.ok(chip);
    assert.equal(chip?.textContent, '/impeccable');
    assert.equal(bubble.textContent, '/impeccable');
  });

  test('renders chip plus remaining prompt text', () => {
    const bubble = setupDom();
    renderUserMessageBubble(bubble, 'lets improve the skill display\n\n[skill: impeccable]');
    const chip = bubble.querySelector('.skill-chip');
    assert.equal(chip?.textContent, '/impeccable');
    assert.match(bubble.textContent ?? '', /lets improve the skill display/);
  });
});

describe('issue ticket messages', () => {
  test('formats the full description and authenticates images in the original workspace', () => {
    const bubble = setupDom();
    window.__MINNOW_SESSION_TOKEN__ = 'fresh-token';
    const issue = {
      id: 'ISS-43', type: 'bug', title: 'Issue images', status: 'open', priority: 'high', labels: [],
      workspacePath: '/original/project',
      description: '## Context\n\nA **formatted** issue.\n\n## Acceptance criteria\n\n- [x] Show images\n- [ ] Keep the full description\n\n![Screenshot](/api/issues/attachments?key=draft-123%2Fimage.png&token=expired&workspace=wrong)\n\n[Attachment](/api/issues/attachments?key=draft-123%2Fimage.png)\n\nFinal paragraph.',
    };
    for (let paint = 0; paint < 2; paint++) {
      // Repainting a persisted snapshot must use the current credential as well.
      window.__MINNOW_SESSION_TOKEN__ = `fresh-token-${paint}`;
      renderUserMessageBubble(bubble, 'Generated workflow prompt', { issue: JSON.parse(JSON.stringify(issue)) });
      const description = bubble.querySelector('.issue-ticket__description')!;
      assert.match(description.textContent ?? '', /Context/);
      assert.equal(description.querySelector('h2')?.textContent, 'Acceptance criteria');
      assert.equal(description.querySelector('strong')?.textContent, 'formatted');
      assert.equal(description.querySelectorAll('li').length, 2);
      assert.match(description.textContent ?? '', /Final paragraph/);
      const image = description.querySelector('img[alt="Screenshot"]')!;
      const url = new URL(image.getAttribute('src')!, 'http://localhost');
      assert.equal(url.searchParams.get('key'), 'draft-123/image.png');
      assert.equal(url.searchParams.get('token'), `fresh-token-${paint}`);
      assert.equal(url.searchParams.get('workspace'), '/original/project');
      assert.equal(description.querySelector('a')?.getAttribute('href'), image.getAttribute('src'));
    }
    assert.match(issue.description, /token=expired/);
  });

  test('renders a dedicated ticket instead of the generated prompt', () => {
    const bubble = setupDom();
    renderUserMessageBubble(bubble, 'Work on this issue in Build mode.\n\nIssue: ISS-42', {
      issue: {
        id: 'ISS-42',
        type: 'bug',
        title: 'Composer clips on narrow panes',
        description: 'The send control overlaps the mode picker below 520px.',
        status: 'in_progress',
        priority: 'high',
        labels: ['chat', 'responsive'],
      },
    });

    assert.ok(bubble.classList.contains('msg-bubble--issue-ticket'));
    assert.equal(bubble.querySelector('.issue-ticket__id')?.textContent, 'ISS-42');
    assert.equal(
      bubble.querySelector('.issue-ticket__title')?.textContent,
      'Composer clips on narrow panes',
    );
    assert.match(bubble.textContent ?? '', /In progress/);
    assert.doesNotMatch(bubble.textContent ?? '', /Work on this issue/);
  });
});
