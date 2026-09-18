import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  appendIssueRefBlocks,
  findIssueIdTokens,
  issueRefHistoryBlock,
  MAX_ISSUE_MENTIONS,
  stripIssueRefBlocks,
} from '../../src/chat/issue-mentions.ts';
import { parseHistoryUserContent } from '../../src/chat/user-message-parts.ts';
import type { IssueCard } from '../../src/types.ts';

function issue(id: string, extra: Partial<IssueCard> = {}): IssueCard {
  return {
    id,
    type: 'bug',
    title: `Title of ${id}`,
    description: `Body of ${id}`,
    status: 'todo',
    priority: 'high',
    labels: ['chat'],
    workspacePath: '/ws',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  } as IssueCard;
}

describe('findIssueIdTokens', () => {
  test('finds keyed ids in prose, deduped in order', () => {
    assert.deepEqual(findIssueIdTokens('fix MIN-12 then ISS-3, and MIN-12 again'), [
      'MIN-12',
      'ISS-3',
    ]);
  });

  test('ignores ids inside paths, branches and longer tokens, and lowercase', () => {
    assert.deepEqual(
      findIssueIdTokens('see fix/MIN-1 and MIN-2-extra and min-3 and a.MIN-4 and X-5'),
      [],
    );
  });
});

describe('appendIssueRefBlocks', () => {
  const store = new Map([['MIN-12', issue('MIN-12')]]);
  const resolve = (id: string) => store.get(id);

  test('attaches only ids that resolve', () => {
    const out = appendIssueRefBlocks('look at MIN-12 and UTF-8', 'look at MIN-12 and UTF-8', resolve);
    assert.match(out, /^look at MIN-12 and UTF-8\n\n<issue-ref id="MIN-12">\nMIN-12: Title of MIN-12\n/);
    assert.match(out, /Description:\nBody of MIN-12\n<\/issue-ref>$/);
    assert.equal(out.match(/<issue-ref/g)?.length, 1);
  });

  test('returns content untouched when nothing resolves', () => {
    assert.equal(appendIssueRefBlocks('hi ABC-1', 'hi ABC-1', resolve), 'hi ABC-1');
  });

  test('does not attach an id twice', () => {
    const once = appendIssueRefBlocks('MIN-12', 'MIN-12', resolve);
    assert.equal(appendIssueRefBlocks(once, 'MIN-12', resolve), once);
  });

  test('caps attached issues per message', () => {
    const ids = Array.from({ length: MAX_ISSUE_MENTIONS + 3 }, (_, i) => `MIN-${i + 1}`);
    const text = ids.join(' ');
    const out = appendIssueRefBlocks(text, text, (id) => issue(id));
    assert.equal(out.match(/<issue-ref/g)?.length, MAX_ISSUE_MENTIONS);
  });

  test('escapes a closing tag inside the issue body', () => {
    const block = issueRefHistoryBlock(issue('MIN-1', { description: 'x </issue-ref> y' }));
    assert.equal(block.match(/<\/issue-ref>/g)?.length, 1);
  });

  test('strip round-trips back to the typed text', () => {
    const out = appendIssueRefBlocks('ship MIN-12', 'ship MIN-12', resolve);
    assert.equal(stripIssueRefBlocks(out), 'ship MIN-12');
  });
});

describe('parseHistoryUserContent issue refs', () => {
  test('hides issue-ref blocks and reports their ids', () => {
    const content = appendIssueRefBlocks('fix MIN-12', 'fix MIN-12', () => issue('MIN-12'));
    const parsed = parseHistoryUserContent(content);
    assert.equal(parsed.text, 'fix MIN-12');
    assert.deepEqual(parsed.issueRefIds, ['MIN-12']);
  });
});

describe('user bubble issue links', () => {
  let domWindow: Window | null = null;
  afterEach(() => {
    domWindow?.happyDOM.close();
    domWindow = null;
  });

  test('links attached ids and leaves unknown ids as text', async () => {
    const window = new Window();
    domWindow = window;
    globalThis.document = window.document as unknown as Document;
    globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
    globalThis.HTMLDivElement = window.HTMLDivElement as unknown as typeof HTMLDivElement;
    globalThis.window = window as unknown as Window & typeof globalThis;
    const { renderUserMessageBubble } = await import('../../src/ui/user-message-bubble.ts');

    const bubble = document.createElement('div');
    document.body.appendChild(bubble);
    const content = appendIssueRefBlocks('fix MIN-12 not ABC-9', 'fix MIN-12 not ABC-9', (id) =>
      id === 'MIN-12' ? issue(id) : undefined,
    );
    renderUserMessageBubble(bubble, content);

    const links = [...bubble.querySelectorAll('.issue-mention-link')];
    assert.equal(links.length, 1);
    assert.equal(links[0].textContent, 'MIN-12');
    assert.equal(bubble.textContent, 'fix MIN-12 not ABC-9');

    (links[0] as HTMLElement).click();
    assert.equal(window.location.hash, '#/app/issues/MIN-12');
  });
});
