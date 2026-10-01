import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import serverDOMPurify from 'isomorphic-dompurify';
import type { Chat } from '../../src/types';
import { chatTranscriptFilename, formatChatTranscript, formatChatTranscriptHtml } from '../../src/chat/transcript-export';

function fixture(history: Chat['history']): Chat {
  return { id: 'export-chat', name: 'A chat <with> "code"', history } as Chat;
}

function parseHtml(chat: Chat): Document {
  const window = new Window();
  // jsdom-backed sanitizer: happy-dom unwraps pre tags and misses some attributes.
  DOMPurify.sanitize = serverDOMPurify.sanitize;
  const html = formatChatTranscriptHtml(chat);
  window.document.write(html);
  return window.document;
}

test('copies ordered messages and tool work, omitting hidden context and private reasoning', () => {
  const chat = fixture([
    { role: 'user', content: 'Please fix this' },
    { role: 'user', content: 'internal resume', hiddenFromTranscript: true },
    { role: 'assistant', content: 'Checking now', thinking: ['private reasoning'], tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call-1', content: 'const value = 1;' },
    { role: 'assistant', content: 'Fixed **the bug**.' },
    { role: 'injection', kind: 'brain-notes', body: 'internal notes', createdAt: 1 },
  ]);
  const text = formatChatTranscript(chat);
  assert.ok(text.indexOf('Please fix this') < text.indexOf('Checking now'));
  assert.ok(text.indexOf('Tool call: read_file') < text.indexOf('Tool result: read_file'));
  assert.ok(text.indexOf('const value = 1;') < text.indexOf('Fixed **the bug**.'));
  assert.doesNotMatch(text, /internal|private reasoning/);
  const document = parseHtml(chat);
  assert.equal(document.querySelectorAll('details').length, 2);
  assert.equal(document.querySelector('strong')?.textContent, 'the bug');
  assert.equal(document.querySelector('title')?.textContent, chat.name);
});

test('renders code and tables while stripping executable HTML and remote assets', () => {
  const document = parseHtml(fixture([
    { role: 'user', content: '<img src=x onerror=alert(1)>' },
    { role: 'assistant', content: '```ts\nconst value = "<safe>";\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script><style>body{display:none}</style><img src="https://example.com/tracker"><a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a>' },
  ]));
  assert.equal(document.querySelector('.user-text')?.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(document.querySelector('pre code')?.textContent?.trim(), 'const value = "<safe>";');
  assert.equal(document.querySelectorAll('table td').length, 2);
  assert.equal(document.querySelectorAll('script, img, .prose style').length, 0);
  assert.equal(document.querySelector('a')?.getAttribute('href'), null);
  assert.equal(document.querySelectorAll('a')[1]?.getAttribute('href'), 'https://example.com');
  assert.match(document.querySelector('meta[http-equiv]')?.getAttribute('content') ?? '', /default-src 'none'/);
});

test('uses visible issue and code-map snapshots and embeds only safe image bytes', () => {
  const chat = fixture([
    { role: 'user', content: 'internal issue workflow', issue: { id: 'ISS-1', title: 'Fix build', description: 'Build fails' } as never },
    { role: 'user', content: 'internal map evidence', codeMap: { question: 'How does it work?', title: 'engine.ts', kind: 'file' },
      images: [{ name: 'screen.png', dataUrl: 'data:image/png;base64,YQ==' }, { name: 'unsafe.svg', dataUrl: 'data:image/svg+xml;base64,YQ==' }] },
  ]);
  const text = formatChatTranscript(chat);
  assert.match(text, /ISS-1: Fix build/);
  assert.match(text, /How does it work\?/);
  assert.match(text, /\[image: screen.png\]/);
  assert.doesNotMatch(text, /internal/);
  assert.equal(parseHtml(chat).querySelectorAll('img').length, 1);
});

test('refuses an unloaded transcript instead of silently exporting an empty one', () => {
  const chat = { ...fixture([]), historyLoaded: false };
  assert.throws(() => formatChatTranscript(chat), /not loaded/);
  assert.throws(() => formatChatTranscriptHtml(chat), /not loaded/);
  assert.equal(chatTranscriptFilename('bad/name: "chat"?'), 'bad-name- -chat---transcript.html');
  assert.equal(chatTranscriptFilename(''), 'chat-transcript.html');
  assert.equal(parseHtml(fixture([])).querySelector('main > p')?.textContent, 'No messages yet.');
});
