/**
 * fetch_web_content shared utilities and server handlers (BUG-011).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dropNoiseSubtrees,
  formatFetchNetworkError,
  rankParagraphsByQuery,
  rankSentencesByQuery,
  rankWebContentByQuery,
  selectMainRegion,
  stripHtmlToPlainText,
  truncateUtf8,
  validateHttpUrl,
  WEB_RAG_EXCERPT_LIMIT,
  WEB_RAG_EXCERPT_MAX_CHARS,
  WEB_RAG_MAX_CHARS,
  WEB_TEXT_DEFAULT_MAX_BYTES,
  WEB_TEXT_MAX_BYTES,
  fetchUrlText,
} from '../../src/lib/fetch-web-content.mjs';
import {
  toolFetchWebContent,
  toolRagWebContent,
} from '../../server/tools/fetch-web-content.js';

describe('validateHttpUrl', () => {
  it('accepts https URLs', () => {
    const result = validateHttpUrl('https://example.com/path');
    assert.equal(result.ok, true);
    assert.equal(result.url.hostname, 'example.com');
  });

  it('rejects non-http schemes', () => {
    const result = validateHttpUrl('file:///etc/passwd');
    assert.equal(result.ok, false);
    assert.match(result.error, /only http and https/);
  });

  it('rejects malformed URLs', () => {
    const result = validateHttpUrl('not a url');
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid URL/);
  });
});

describe('stripHtmlToPlainText', () => {
  it('treats hydration strings as opaque, including nested-looking script tags', () => {
    const html = `<html><head><script>const template = '<script>nested'; self.__next_f.push([1,"${'junk '.repeat(50000)}"])</script></head><body><p>Subscription costs $20 per month with API access.</p><script>const tag = '<script>'; hydrationTail()</script></body></html>`;
    assert.equal(stripHtmlToPlainText(html), 'Subscription costs $20 per month with API access.');
  });

  it('never restores an unterminated script in the short-content fallback', () => {
    assert.equal(stripHtmlToPlainText('<p>Pricing</p><script>unclosed hydration data'), 'Pricing');
  });
  it('removes tags and script content', () => {
    const html =
      '<html><head><style>.x{}</style></head><body><script>alert(1)</script><p>Hello <b>world</b></p></body></html>';
    const text = stripHtmlToPlainText(html);
    assert.equal(text, 'Hello world');
  });

  it('decodes common entities', () => {
    assert.equal(stripHtmlToPlainText('<p>A &amp; B</p>'), 'A & B');
  });

  it('keeps block boundaries as newlines so paragraphs survive', () => {
    const text = stripHtmlToPlainText('<p>First para.</p><p>Second para.</p>');
    assert.equal(text, 'First para.\nSecond para.');
  });

  it('drops navigation, sidebars, footers, and reference lists', () => {
    const body =
      `<body><nav>Home About Contact</nav>` +
      `<div class="sidebar">Related links</div>` +
      `<p>${'Real page content. '.repeat(20)}</p>` +
      `<ol class="reflist">Citation junk</ol>` +
      `<footer>Copyright</footer></body>`;
    const text = stripHtmlToPlainText(body);
    assert.match(text, /Real page content/);
    assert.doesNotMatch(text, /Home About Contact/);
    assert.doesNotMatch(text, /Related links/);
    assert.doesNotMatch(text, /Citation junk/);
    assert.doesNotMatch(text, /Copyright/);
  });

  it('falls back to the whole document when the heuristics strip everything', () => {
    const body = '<div class="menu"><p>Only content lives inside a noisy class.</p></div>';
    assert.match(stripHtmlToPlainText(body), /Only content lives/);
  });
});

describe('bounded web excerpts', () => {
  it('finds late matches without returning a whole unpunctuated document', () => {
    const text = 'unrelated '.repeat(20000) + 'The subscription price includes API access for developers.';
    const excerpts = rankWebContentByQuery(text, 'subscription price API');
    assert.ok(excerpts.some((s) => s.includes('subscription price')));
    assert.ok(excerpts.every((s) => s.length <= WEB_RAG_EXCERPT_MAX_CHARS));
    assert.ok(excerpts.join('').length <= WEB_RAG_MAX_CHARS);
  });

  it('bounds total returned content even when every long paragraph matches', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Plan ${i}: API subscription ${'includes usage '.repeat(150)}`).join('\n\n');
    const excerpts = rankWebContentByQuery(text, 'API subscription', 1000);
    assert.ok(excerpts.length > 0 && excerpts.length <= WEB_RAG_EXCERPT_LIMIT);
    assert.ok(excerpts.every((s) => s.length <= WEB_RAG_EXCERPT_MAX_CHARS));
    assert.ok(excerpts.join('').length <= WEB_RAG_MAX_CHARS);
  });
});

describe('dropNoiseSubtrees', () => {
  it('removes nested markup with its dropped parent', () => {
    const out = dropNoiseSubtrees('<nav><div><span>gone</span></div></nav><p>kept</p>');
    assert.doesNotMatch(out, /gone/);
    assert.match(out, /kept/);
  });

  it('does not swallow the document when a drop tag is never closed', () => {
    const out = dropNoiseSubtrees('<nav><p>tail content</p>');
    assert.match(out, /tail content/);
  });

  it('ignores chrome-looking classes on root elements', () => {
    // MediaWiki puts feature flags like vector-toc-available on <html>.
    const out = dropNoiseSubtrees(
      '<html class="vector-toc-available"><body class="menu"><p>whole page</p></body></html>',
    );
    assert.match(out, /whole page/);
  });
});

describe('selectMainRegion', () => {
  it('prefers a substantial <main> region', () => {
    const main = `<main>${'content '.repeat(200)}</main>`;
    const html = `<body><div>chrome</div>${main}</body>`;
    const region = selectMainRegion(html);
    assert.doesNotMatch(region, /chrome/);
    assert.match(region, /content/);
  });

  it('ignores a tiny <main> and keeps the document', () => {
    const html = `<body><main>hi</main><p>${'body text '.repeat(200)}</p></body>`;
    assert.match(selectMainRegion(html), /body text/);
  });
});

describe('truncateUtf8', () => {
  it('leaves short text unchanged', () => {
    assert.equal(truncateUtf8('hello', 100), 'hello');
  });

  it('truncates and appends byte cap notice', () => {
    const text = 'x'.repeat(WEB_TEXT_MAX_BYTES + 50);
    const out = truncateUtf8(text, WEB_TEXT_MAX_BYTES);
    assert.match(out, new RegExp(`\\[truncated to ${WEB_TEXT_MAX_BYTES} bytes\\]`));
    assert.ok(out.length < text.length);
  });
});

describe('rankParagraphsByQuery', () => {
  it('returns paragraphs matching query terms', () => {
    const text =
      'Unrelated intro paragraph with filler content here.\n\nMinnow research mode uses deeper web RAG excerpts for agents.';
    const hits = rankParagraphsByQuery(text, 'minnow research', 3);
    assert.ok(hits.length >= 1);
    assert.match(hits[0], /Minnow research/i);
  });
});

describe('rankWebContentByQuery', () => {
  it('merges sentence and paragraph hits up to the excerpt limit', () => {
    const text =
      'Minnow is a local chat client. It supports many tools.\n\nResearch mode uses web fetch with paragraph ranking for denser excerpts.';
    const hits = rankWebContentByQuery(text, 'minnow research', WEB_RAG_EXCERPT_LIMIT);
    assert.ok(hits.length >= 1);
    assert.ok(hits.length <= WEB_RAG_EXCERPT_LIMIT);
  });
});

describe('rankSentencesByQuery', () => {
  it('returns sentences matching query terms', () => {
    const text =
      'Minnow is a local chat client. It supports many tools. Research mode uses web fetch.';
    const hits = rankSentencesByQuery(text, 'minnow research', 3);
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((s) => /minnow/i.test(s)));
  });
});

describe('formatFetchNetworkError', () => {
  it('includes URL and Minnow hint when requested', () => {
    const msg = formatFetchNetworkError('https://example.com', new TypeError('Failed to fetch'), {
      suggestNpmStart: true,
    });
    assert.match(msg, /https:\/\/example\.com/);
    assert.match(msg, /Open Minnow/i);
    assert.match(msg, /CORS/i);
  });
});

describe('fetchUrlText', () => {
  it('returns HTTP error with status and URL', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('gone', { status: 404, statusText: 'Not Found' });

    try {
      const result = await fetchUrlText('https://example.com/missing');
      assert.match(result, /HTTP 404/);
      assert.match(result, /example\.com/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('strips HTML bodies', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<html><body><p>Page text</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    try {
      const result = await fetchUrlText('https://example.com/');
      assert.equal(result, 'Page text');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('toolFetchWebContent', () => {
  it('requires url argument', async () => {
    const result = await toolFetchWebContent({});
    assert.match(result, /"url" is required/);
  });

  it('returns truncated plain text on success', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(`<html><body>${'word '.repeat(Math.ceil((WEB_TEXT_MAX_BYTES + 500) / 5))}</body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    try {
      const result = await toolFetchWebContent({ url: 'https://example.com/' });
      assert.ok(!result.startsWith('Error:'));
      assert.match(result, /<<<UNTRUSTED_SOURCE_DATA source="web:https:\/\/example\.com\/">>>/);
      assert.ok(result.includes(`[truncated to ${WEB_TEXT_DEFAULT_MAX_BYTES} bytes]`));
      assert.match(result, /use rag_web_content with a query/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('honours max_bytes up to the hard ceiling', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(`<html><body>${'word '.repeat(20_000)}</body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    try {
      const result = await toolFetchWebContent({ url: 'https://example.com/', max_bytes: 4096 });
      assert.ok(result.includes('[truncated to 4096 bytes]'));

      const clamped = await toolFetchWebContent({
        url: 'https://example.com/',
        max_bytes: WEB_TEXT_MAX_BYTES * 4,
      });
      assert.ok(!clamped.includes('[truncated to'));
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('toolRagWebContent', () => {
  it('requires query argument', async () => {
    const result = await toolRagWebContent({ url: 'https://example.com' });
    assert.match(result, /"query" is required/);
  });

  it('returns ranked excerpts', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        '<html><body><p>Minnow agents fetch pages for research.</p><p>Unrelated filler text here.</p></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );

    try {
      const result = await toolRagWebContent({
        url: 'https://example.com/docs',
        query: 'minnow research',
      });
      assert.match(result, /<<<UNTRUSTED_SOURCE_DATA source="web-rag:https:\/\/example\.com\/docs">>>/);
      assert.match(result, /Relevant excerpts/);
      assert.match(result, /1\./);
      assert.match(result, /minnow/i);
    } finally {
      globalThis.fetch = original;
    }
  });
});
