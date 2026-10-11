import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchReleaseSources, generateReleaseDraft } from '../../src/chat/releases/draft-release-notes.ts';
import type { ReleaseDraftContext } from '../../src/state/actions-api.ts';

const context: ReleaseDraftContext = {
  repo: 'github.com/o/r', tag: 'v2', baseTag: 'v1', baseSha: 'a'.repeat(40),
  targetSha: 'b'.repeat(40), commitCount: 1, commits: [{ sha: 'b'.repeat(40), message: 'feat: keyboard navigation\n\nSupport arrows.' }],
};

test('small histories use one grounded final generation', async () => {
  let calls = 0;
  const text = await generateReleaseDraft(context, { signal: new AbortController().signal, complete: async messages => {
    calls++;
    assert.match(String(messages[0].content), /untrusted source data/);
    assert.match(String(messages[1].content), /Support arrows/);
    assert.match(String(messages[1].content), /Since: "v1"/);
    return '```markdown\n## Features\n- Navigate using arrow keys.\n```';
  } });
  assert.equal(calls, 1);
  assert.equal(text, '## Features\n- Navigate using arrow keys.');
});

test('oversized sources are split without losing any characters', () => {
  const sources = ['prefix\n' + 'x'.repeat(5000) + '\nTAIL', 'next message'];
  const batches = batchReleaseSources(sources, 1000);
  assert.equal(batches.flat().join(''), sources.join(''));
  assert(batches.every(batch => batch.join('').length <= 1000));
});

test('large histories review every message and consolidate recursively', async () => {
  const commits = Array.from({ length: 200 }, (_, i) => ({ sha: String(i).padStart(40, '0'), message: `marker-${i}-end ${'detail '.repeat(70)}` }));
  const reviewed: string[] = [];
  let final = 0;
  const text = await generateReleaseDraft({ ...context, commits, commitCount: commits.length }, {
    signal: new AbortController().signal, contextLimit: 4096,
    complete: async messages => {
      const source = String(messages[1].content);
      if (source.startsWith('Produce the final')) { final++; return '## Improvements\n- Improved navigation.'; }
      reviewed.push(source);
      return 'User-facing navigation improvements.';
    },
  });
  for (let i = 0; i < 200; i++) assert(reviewed.some(source => source.includes(`marker-${i}-end`)), `commit ${i}`);
  assert.equal(final, 1);
  assert.match(text, /Improved navigation/);
});

test('initial-release prompt is explicit and empty ranges never invoke the model', async () => {
  await generateReleaseDraft({ ...context, baseTag: null, baseSha: null }, {
    signal: new AbortController().signal,
    complete: async messages => { assert.match(String(messages[1].content), /Initial release/); return 'First release.'; },
  });
  await assert.rejects(generateReleaseDraft({ ...context, commits: [], commitCount: 0 }, {
    signal: new AbortController().signal, complete: async () => { assert.fail('No inference for empty history'); },
  }), /No new commits/);
});

test('empty output, provider failures, and non-contracting summaries fail the entire draft', async () => {
  await assert.rejects(generateReleaseDraft(context, { signal: new AbortController().signal, complete: async () => '' }), /no release notes/);
  await assert.rejects(generateReleaseDraft(context, { signal: new AbortController().signal, complete: async () => { throw new Error('provider unavailable'); } }), /provider unavailable/);
  await assert.rejects(generateReleaseDraft({ ...context, commits: [{ sha: 'a'.repeat(40), message: 'x'.repeat(8000) }] }, {
    signal: new AbortController().signal, contextLimit: 4096, complete: async () => 'x'.repeat(8000),
  }), /could not consolidate/);
});

test('cancellation stops between batches and discards a completed result', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(generateReleaseDraft({ ...context, commits: [{ sha: 'a'.repeat(40), message: 'x'.repeat(8000) }] }, {
    signal: controller.signal, contextLimit: 4096,
    complete: async () => { calls++; controller.abort(); return 'summary'; },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
