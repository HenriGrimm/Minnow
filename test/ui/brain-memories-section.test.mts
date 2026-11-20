/**
 * Brain Memories section registration, routing helpers and grouping.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { resolveBrainMemoryRoute } from '../../src/ui/brain-memory-routing.ts';
import { groupMemories, renderMemoriesSection } from '../../src/ui/brain/memories-section.ts';
import { isLocalServerAvailable, setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import type { MemoryListing, MemoryRecord } from '../../src/brain/types.ts';
import { filterBrainTreeForDisplay, flattenBrainTree } from '../../src/ui/brain/tree-utils.ts';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

function memory(partial: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: partial.id ?? 'id',
    title: partial.title ?? 'Title',
    kind: partial.kind ?? 'decision',
    scope: partial.scope ?? 'project',
    body: 'body',
    evidence: '',
    supersedes: [],
    sourceChatId: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    revision: 'rev',
    ...partial,
  };
}

const limits = { title: 100, body: 1200, evidence: 300, projectCap: 150, userCap: 40 };

describe('brain memories section', () => {
  test('memories rail and panel exist in index.html', () => {
    assert.match(html, /data-brain-nav="memories"/);
    assert.match(html, /id="brainSection-memories"/);
    assert.match(html, /id="brainMemoryEnabled"/);
    assert.match(html, /id="brainMemoryRefresh"/);
    assert.match(html, /id="brainMemoryAddSubmit"/);
    assert.match(html, /id="brainMemoryAddKind"/);
    assert.match(html, /id="brainMemoryAddBody"[^>]*maxlength="1200"/);
    assert.match(html, /brain-section--memories/);
    assert.doesNotMatch(html, /id="brainMemoryAddOpen"/);
  });

  test('the wiki tree is labelled as legacy notes agents do not use', () => {
    assert.match(html, /Legacy notes<\/h2>/);
    assert.match(html, /id="brainGraphLegacyNote">Not used by agents/);
  });

  test('the legacy tree excludes agent memories even with archives enabled', () => {
    const page = (path: string) => ({ type: 'page' as const, id: path, title: path, path });
    const tree = { facts: page('facts/a.md'), memory: { type: 'folder' as const, children: {
      user: page('memory/user/preference.md'),
    } } };
    for (const showArchives of [false, true]) {
      assert.deepEqual(flattenBrainTree(filterBrainTreeForDisplay(tree as never, showArchives)).map(p => p.path), ['facts/a.md']);
    }
  });

  test('groupMemories puts the project first, groups by kind and reports caps', () => {
    const listing: MemoryListing = {
      project: { key: 'minnow--abc', label: 'minnow' },
      kinds: ['decision', 'constraint', 'gotcha', 'preference', 'reference'],
      limits,
      memories: [
        memory({ id: 'g', kind: 'gotcha' }),
        memory({ id: 'd', kind: 'decision' }),
        memory({ id: 'u', kind: 'preference', scope: 'user' }),
      ],
    };
    const groups = groupMemories(listing);
    assert.deepEqual(groups.map((g) => [g.scope, g.title, g.count, g.cap]), [
      ['project', 'Project · minnow', 2, 150],
      ['user', 'Your preferences · all projects', 1, 40],
    ]);
    assert.deepEqual(groups[0].kinds.map((k) => [k.label, k.items.map((m) => m.id)]), [
      ['Decisions', ['d']],
      ['Gotchas', ['g']],
    ]);
  });

  test('without a project only user memories are shown', () => {
    const groups = groupMemories({ project: null, kinds: [], limits, memories: [memory({ scope: 'user', kind: 'preference' })] });
    assert.deepEqual(groups.map((g) => g.scope), ['user']);
  });

  test('resolveBrainMemoryRoute maps store keys to memories', () => {
    assert.equal(resolveBrainMemoryRoute('knowledge.memory.enabled'), 'memories');
    assert.equal(resolveBrainMemoryRoute('knowledge.memory.injection'), 'memories');
    assert.equal(resolveBrainMemoryRoute(undefined, 'memory'), 'memories');
  });

  test('resolveBrainMemoryRoute maps embeddings and synthesis to settings', () => {
    assert.equal(resolveBrainMemoryRoute('knowledge.memory.embeddings'), 'settings');
    assert.equal(resolveBrainMemoryRoute('knowledge.memory.synthesis'), 'settings');
  });

  test('resolveBrainMemoryRoute ignores unrelated keys', () => {
    assert.equal(resolveBrainMemoryRoute('agents.rules.enabled'), null);
  });

  test('live changes refresh the list without replacing a draft; edits send the loaded revision', async t => {
    const win = new Window();
    const previous = { window: globalThis.window, document: globalThis.document,
      HTMLElement: globalThis.HTMLElement, fetch: globalThis.fetch, available: isLocalServerAvailable() };
    Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
    setLocalServerAvailableForTests(true);
    t.after(() => {
      Object.assign(globalThis, { window: previous.window, document: previous.document,
        HTMLElement: previous.HTMLElement, fetch: previous.fetch });
      setLocalServerAvailableForTests(previous.available);
      win.happyDOM.abort();
    });
    document.body.innerHTML = html.match(/<section id="brainSection-memories"[\s\S]*?<\/section>/)![0];
    document.getElementById('brainSection-memories')!.classList.add('is-active');
    let rows = [memory({ id: 'initial', title: 'Original decision', revision: 'r1' })];
    const submitted: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        submitted.push(body);
        rows = rows.map(row => row.id === 'initial' ? { ...row, ...body, revision: 'r2' } : row);
        return Response.json(rows[0]);
      }
      if (String(input).includes('/api/brain/memories')) return Response.json({
        project: { key: 'p', label: 'Project' }, kinds: ['decision'], limits, memories: rows,
      });
      return Response.json({ enabled: true, pageCount: 1 });
    };
    await renderMemoriesSection();
    (document.querySelector('[data-memory-edit]') as HTMLButtonElement).click();
    const body = document.getElementById('brainMemoryAddBody') as HTMLTextAreaElement;
    body.value = 'My draft';
    rows.push(memory({ id: 'agent-save', title: 'New agent memory' }));
    win.dispatchEvent(new win.Event('minnow:memory-changed'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(body.value, 'My draft');
    assert.equal(document.querySelector('[data-memory-select="agent-save"]'), null, 'refresh waits until editing ends');
    (document.getElementById('brainMemoryAddSubmit') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].expectedRevision, 'r1');
    assert.equal(document.querySelector('.brain-memory-detail__body')?.textContent, 'My draft');
    rows.push(memory({ id: 'next-save', title: 'Another agent memory' }));
    win.dispatchEvent(new win.Event('minnow:memory-changed'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(document.querySelector('[data-memory-select="next-save"]'));
  });
});
