import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { createCompactionSummary } from '../../src/ui/compaction-summary.ts';
import { createCompactionDivider } from '../../src/ui/compaction-divider.ts';
import type { ContextNoticeMessage } from '../../src/types.ts';

beforeEach(() => {
  const window = new Window();
  globalThis.document = window.document;
  DOMPurify.sanitize = DOMPurify(window).sanitize;
});

test('formats a real checkpoint into sections and retains the exact wire summary', () => {
  const text = readFileSync(new URL('../runner/__golden__/compaction-refactor.txt', import.meta.url), 'utf8');
  const root = createCompactionSummary(text);
  const content = root.querySelector('.compaction-summary__content')!;
  assert.match(content.querySelector('h3')!.textContent, /Session goal/);
  assert.doesNotMatch(content.textContent, /Prior context \(compacted/);
  assert.equal(content.querySelectorAll('li').length, 6);
  const history = content.querySelector('details')!;
  assert.equal(history.open, false);
  assert.equal(history.querySelector('summary')!.textContent, 'File observations');
  assert.match(history.textContent, /historical source excerpts; recall rows for details/);
  assert.match(content.textContent, /\[RESOLVED\]/);
  assert.equal(root.querySelector('.compaction-divider__text')!.textContent, text);
  assert.equal(root.querySelector<HTMLDetailsElement>('.compaction-summary__source')!.open, false);
});

test('folds attached files literally and leaves the rest of the goal readable', () => {
  const text = '[Session goal]\nBuild **the app**.\n\n<file name="plan.md">\n[Files]\n<script>source()</script>\n</file>\n\nKeep the public API.\n\n[Current status]\nReady.';
  const root = createCompactionSummary(text);
  const content = root.querySelector('.compaction-summary__content')!;
  assert.equal(content.querySelector('strong')!.textContent, 'the app');
  assert.equal(content.querySelectorAll('section').length, 2);
  const file = content.querySelector<HTMLDetailsElement>('.compaction-summary__file')!;
  assert.equal(file.open, false);
  assert.equal(file.querySelector('summary')!.textContent, 'plan.md');
  assert.equal(file.querySelector('pre')!.textContent, '[Files]\n<script>source()</script>');
  assert.match(file.nextElementSibling!.textContent, /Keep the public API/);
  assert.equal(content.querySelector('script'), null);
});

test('keeps section-like code and unknown bracketed lines as content', () => {
  const text = '[Session goal]\nInspect this:\n\n```text\n[Files]\n```\n\n[Current status]\n[ERROR] The check failed.';
  const root = createCompactionSummary(text);
  assert.equal(root.querySelectorAll('section').length, 2);
  assert.equal(root.querySelector('code')!.textContent, '[Files]\n');
  assert.match(root.querySelectorAll('section')[1].textContent, /\[ERROR\] The check failed/);
});

test('sanitizes checkpoint prose without loading media or creating unsafe links', () => {
  const text = 'Saved **progress**. <script>alert(1)</script><img src="https://example.com/pixel" onerror="alert(1)">\n\n![pixel](https://example.com/pixel) [unsafe](javascript:alert%281%29) [local](file:///etc/passwd) [docs](https://example.com/docs)';
  const root = createCompactionSummary(text);
  assert.equal(root.querySelector('script, img, [onerror]'), null);
  const links = root.querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com/docs');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(root.querySelector('.compaction-divider__text')!.textContent, text);
});

test('supports unstructured, truncated, and empty saved summaries', () => {
  const truncated = createCompactionSummary('[Session goal]\nBuild it.\n<file name="plan.md">\n1: # Plan\n2…\n\n[Current status]\nReady to build.');
  assert.match(truncated.querySelector('.compaction-summary__file pre')!.textContent, /2…/);
  assert.equal(truncated.querySelectorAll('section').length, 2);
  assert.match(truncated.querySelectorAll('section')[1].textContent, /Ready to build/);
  const plain = createCompactionSummary('A legacy summary with `code`.');
  assert.equal(plain.querySelector('code')!.textContent, 'code');
  const empty = createCompactionSummary('');
  assert.match(empty.textContent, /No summary text was saved/);
  assert.equal(empty.querySelector('.compaction-summary__source'), null);
});

test('formats only on first expansion and preserves nested disclosure state on reopen', () => {
  const notice: ContextNoticeMessage = {
    role: 'context', policy: 'compact', droppedTurns: 2, createdAt: 0,
    summaryText: '[Session goal]\nKeep going.',
  };
  const divider = createCompactionDivider(notice);
  const details = divider.querySelector('details')!;
  assert.equal(divider.querySelector('.compaction-summary'), null);
  const toggle = () => details.dispatchEvent(new document.defaultView!.Event('toggle'));
  details.open = true;
  toggle();
  const source = divider.querySelector<HTMLDetailsElement>('.compaction-summary__source')!;
  source.open = true;
  details.open = false;
  toggle();
  details.open = true;
  toggle();
  assert.equal(divider.querySelectorAll('.compaction-summary').length, 1);
  assert.equal(source.open, true);
  assert.match(divider.querySelector('.compaction-summary__prose')!.textContent, /Keep going/);
});
