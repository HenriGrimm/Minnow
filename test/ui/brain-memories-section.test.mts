/**
 * Brain Memories section registration, routing helpers and grouping.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { resolveBrainMemoryRoute } from '../../src/ui/brain-memory-routing.ts';
import { groupMemories, renderMemoriesSection, resetMemoriesSectionForTests } from '../../src/ui/brain/memories-section.ts';
import { buildMemoryGraph, filterMemories } from '../../src/ui/brain/graph/graph-data.ts';
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

const limits = { title: 100, body: 1200, evidence: 300 };

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

  test('the memory graph is the home view of the Memories section', () => {
    const section = html.match(/<section id="brainSection-memories"[\s\S]*?<\/section>/)![0];
    assert.match(section, /id="brainMemoryCanvas"/);
    assert.match(section, /data-memory-view="graph" aria-selected="true"/);
    assert.match(section, /id="brainMemoryAdd"/);
    assert.match(section, /id="brainMemoryAddScope"/);
    assert.doesNotMatch(html, /class="brain-page is-graph-canvas-bg"/, 'the page no longer depends on the deleted canvas stylesheet');
  });

  test('buildMemoryGraph hangs memories off a kind cluster under their scope hub', () => {
    const listing: MemoryListing = {
      project: { key: 'minnow--abc', label: 'Minnow' },
      kinds: ['decision', 'constraint', 'gotcha', 'preference', 'reference'],
      limits,
      memories: [
        memory({ id: 'a', kind: 'decision', title: 'Use sqlite sessions store', body: 'sessions sqlite store migration' }),
        memory({ id: 'b', kind: 'gotcha', title: 'sqlite sessions lock', body: 'sessions sqlite store locking', supersedes: ['a'] }),
        memory({ id: 'u', kind: 'preference', scope: 'user', title: 'Terse commit messages' }),
      ],
    };
    const { nodes, edges } = buildMemoryGraph(listing);
    const ids = nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, [
      'hub:project', 'hub:user',
      'kind:project:decision', 'kind:project:gotcha', 'kind:user:preference',
      'mem:a', 'mem:b', 'mem:u',
    ]);
    const edge = (source: string, target: string) => edges.find((e) => e.source === source && e.target === target)?.kind;
    assert.equal(edge('mem:a', 'kind:project:decision'), 'member');
    assert.equal(edge('kind:project:decision', 'hub:project'), 'member');
    assert.equal(edge('mem:u', 'kind:user:preference'), 'member');
    assert.equal(edge('mem:b', 'mem:a'), 'supersedes');
    assert.equal(edges.filter((e) => e.kind === 'related').length, 0, 'a supersedes pair is not linked twice');
    assert.equal(nodes.find((n) => n.id === 'hub:project')?.sublabel, 'This project · 2 memories');
  });

  test('buildMemoryGraph keeps empty hubs, and filters by search, scope and kind', () => {
    const listing: MemoryListing = {
      project: { key: 'p', label: 'P' }, kinds: [], limits,
      memories: [
        memory({ id: 'a', kind: 'decision', title: 'Alpha' }),
        memory({ id: 'b', kind: 'gotcha', title: 'Beta' }),
        memory({ id: 'u', kind: 'preference', scope: 'user', title: 'Gamma' }),
      ],
    };
    assert.deepEqual(buildMemoryGraph({ ...listing, memories: [] }).nodes.map((n) => n.id), ['hub:project', 'hub:user']);
    assert.deepEqual(filterMemories(listing, { query: 'bet' }).map((m) => m.id), ['b']);
    assert.deepEqual(filterMemories(listing, { hiddenKinds: new Set(['gotcha']) }).map((m) => m.id), ['a', 'u']);
    const userOnly = buildMemoryGraph(listing, { hiddenScopes: new Set(['project']) });
    assert.deepEqual(userOnly.nodes.map((n) => n.id), ['hub:user', 'kind:user:preference', 'mem:u']);
    const noProject = buildMemoryGraph({ ...listing, project: null });
    assert.ok(!noProject.nodes.some((n) => n.id.includes('project')), 'project memories need an open project');
  });

  test('the retired wiki tree is not part of the Brain page', () => {
    assert.doesNotMatch(html, /Legacy notes<\/h2>/);
    assert.doesNotMatch(html, /id="brainGraphLegacyNote"/);
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

  test('groupMemories puts the project first, groups by kind and reports counts', () => {
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
    assert.deepEqual(groups.map((g) => [g.scope, g.title, g.count]), [
      ['project', 'Project · minnow', 2],
      ['user', 'Your preferences · all projects', 1],
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
    resetMemoriesSectionForTests();
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
    assert.equal(document.getElementById('brainSection-memories')!.dataset.view, 'list', 'falls back to the list without a 2D canvas');
    assert.equal(document.querySelector('[data-memory-edit]'), null, 'nothing is selected until you pick a memory');
    (document.querySelector('[data-memory-select="initial"]') as HTMLButtonElement).click();
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
