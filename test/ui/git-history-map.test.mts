import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { GitCommitEntry } from '../../src/state/git-api.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { createGitHistoryMap } from '../../src/ui/git-history-map/page.ts';
import { buildGitHistoryModel, collapseGitHistoryBranches, filterGitHistoryModel } from '../../src/ui/git-history-map/model.ts';
import { layoutGitHistory, routeGitHistoryEdges } from '../../src/ui/git-history-map/layout.ts';
import { renderGitHistoryScene } from '../../src/ui/git-history-map/scene.ts';
import { spatialTestDom } from './spatial-test-dom.ts';

const hash = (n: number) => n.toString(16).padStart(40, '0');
const commit = (n: number, parents: number[] = [], refs: string[] = []): GitCommitEntry => ({
  hash: hash(n), parents: parents.map(hash), refs, subject: `Commit ${n}`, author: 'Tester', relativeTime: 'now',
});
const fork = [commit(8, [7, 6], ['HEAD -> refs/heads/main']), commit(7, [3]),
  commit(6, [5], ['refs/heads/feature', 'refs/remotes/upstream/feature', 'refs/remotes/mirror/feature', 'tag: refs/tags/v1']),
  commit(5, [4]), commit(4, [3]), commit(3, [2]), commit(2, [1]), commit(1)];

test('fork and merge topology runs older to newer from left to right and preserves relative geometry', () => {
  const model = buildGitHistoryModel(fork);
  assert.equal(model.edges.length, fork.reduce((n, c) => n + c.parents.length, 0));
  assert.equal(model.nodes[2].refs.filter((r) => r.kind === 'remote').length, 2);
  assert.equal(model.nodes[2].refs.find((r) => r.kind === 'tag')?.name, 'v1');
  assert.equal(model.nodes[0].isHead, true);
  assert.notEqual(model.nodes[1].lane, model.nodes[2].lane);
  const partial = buildGitHistoryModel(fork.slice(0, 4));
  const before = layoutGitHistory(partial);
  const after = layoutGitHistory(model);
  for (const [sha, box] of before.boxes) assert.deepEqual(after.boxes.get(sha), { ...box, x: box.x + (fork.length - 4) * 320 });
  assert.ok(partial.edges.some((e) => e.boundary));
  assert.equal(model.edges.some((e) => e.boundary), false);
  assert.deepEqual(layoutGitHistory(buildGitHistoryModel(fork)), after);
  const boxes = [...after.boxes.values()];
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].x + boxes[i].w < boxes[i - 1].x);
  for (const route of routeGitHistoryEdges(model, after)) assert.doesNotMatch(route.path, /NaN|undefined/);
});

test('octopus merges, detached HEAD, orphan roots, and duplicate pages remain deterministic', () => {
  const records = [commit(9, [8, 7, 6], ['HEAD']), commit(8, [5]), commit(7, [5]), commit(6, [5]), commit(5), commit(4)];
  const model = buildGitHistoryModel([...records, records[0]]);
  assert.equal(model.nodes.length, records.length);
  assert.equal(model.nodes[0].refs[0].kind, 'head');
  assert.equal(new Set(model.nodes.slice(1, 4).map((n) => n.lane)).size, 3);
  assert.equal(model.edges.filter((e) => e.child === hash(9)).length, 3);
  assert.deepEqual(layoutGitHistory(model), layoutGitHistory(buildGitHistoryModel(records)));
});

test('search retains adjacent topology and selection; collapse retains tips, joins, and selected interiors', () => {
  const model = buildGitHistoryModel(fork);
  const filtered = filterGitHistoryModel(model, { query: 'Commit 5' }, hash(1));
  assert.deepEqual([...filtered.matches], [hash(5)]);
  for (const n of [1, 4, 5, 6]) assert.ok(filtered.nodes.some((c) => c.commit.hash === hash(n)));
  const remote = filterGitHistoryModel(model, { refKind: 'remote' });
  assert.deepEqual([...remote.matches], [hash(6)]);
  const branch = model.nodes.find((n) => n.commit.hash === hash(5))!.branchKey;
  const collapsed = collapseGitHistoryBranches(model, new Set([branch]), hash(5));
  assert.ok(collapsed.nodes.some((n) => n.commit.hash === hash(6)));
  assert.ok(collapsed.nodes.some((n) => n.commit.hash === hash(5)));
  assert.equal(collapsed.nodes.some((n) => n.commit.hash === hash(4)), false);
  assert.ok(collapsed.edges.some((e) => e.hiddenCount === 1));
});

describe('history controller', () => {
  let dom: ReturnType<typeof spatialTestDom>;
  let previousFetch: typeof fetch;
  let calls: Array<{ skip?: number; cwd?: string }>;
  let records: GitCommitEntry[];
  beforeEach(() => {
    dom = spatialTestDom();
    previousFetch = globalThis.fetch;
    setLocalServerAvailableForTests(true);
    records = fork;
    calls = [];
    globalThis.fetch = async (_url, init) => {
      const input = JSON.parse(String(init?.body));
      calls.push(input);
      const skip = input.skip ?? 0;
      const commits = records.slice(skip, skip + input.count);
      const hasMore = skip + input.count < records.length;
      return { ok: true, json: async () => ({ ok: true, commits, hasMore, nextSkip: hasMore ? skip + input.count : null }) } as Response;
    };
  });
  afterEach(() => { globalThis.fetch = previousFetch; setLocalServerAvailableForTests(false); dom.destroy(); });

  const btn = (host: HTMLElement, text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;

  test('map/list share selection, search, paging, and the persisted preference without re-fetching', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    let selected = '';
    let context = '';
    const api = createGitHistoryMap(host, {
      onSelectCommit: (sha) => { selected = sha; api.setSelection(sha); },
      onContextMenu: (visual) => { context = visual.commit.hash; },
    });
    await api.refresh();
    assert.ok(host.querySelector('[role="toolbar"][aria-label="History discovery"]'));
    const head = host.querySelector<HTMLButtonElement>(`button[data-sha="${hash(8)}"]`)!;
    assert.equal(head.tabIndex, 0);
    head.click();
    assert.equal(selected, hash(8));
    assert.equal(head.getAttribute('aria-pressed'), 'true');
    assert.equal(calls.length, 1);
    head.dispatchEvent(new dom.browser.MouseEvent('contextmenu', { bubbles: true }));
    assert.equal(context, hash(8));
    btn(host, 'List').click();
    assert.equal(localStorage.getItem('minnow.git-history.view'), 'list');
    assert.equal(host.querySelector('.git-history-map__list-row[aria-pressed="true"]')?.getAttribute('data-sha'), selected);
    btn(host, 'Map').click();
    assert.equal(calls.length, 1);
    const search = host.querySelector<HTMLInputElement>('input')!;
    search.value = 'Commit 5';
    search.dispatchEvent(new dom.browser.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.match(host.querySelector('[role="status"]')?.textContent ?? '', /1 matches/);
    assert.ok(host.querySelector(`button[data-sha="${hash(5)}"]`));
    assert.ok(parseFloat(host.querySelector<HTMLElement>('.git-history-map__scene')!.style.height) < 1200,
      'Fit uses the filtered extent instead of the full loaded history');
    assert.equal(calls.length, 1);
    api.destroy();
    assert.equal(host.children.length, 0);
    assert.equal(dom.disconnected(), 2);
  });

  test('roving focus follows arrows and Home; branch collapse/expand preserves tips', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const api = createGitHistoryMap(host);
    await api.refresh();
    const head = host.querySelector<HTMLButtonElement>(`button[data-sha="${hash(8)}"]`)!;
    head.focus();
    head.dispatchEvent(new dom.browser.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal((document.activeElement as HTMLElement).dataset.sha, hash(7));
    document.activeElement!.dispatchEvent(new dom.browser.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal((document.activeElement as HTMLElement).dataset.sha, hash(8));
    const branch = host.querySelector<HTMLSelectElement>('[aria-label="Branch to collapse or expand"]')!;
    branch.value = 'feature';
    branch.dispatchEvent(new dom.browser.Event('change'));
    btn(host, 'Collapse').click();
    assert.match(host.querySelector('[role="status"]')?.textContent ?? '', /2 hidden/);
    btn(host, 'Expand').click();
    assert.match(host.querySelector('[role="status"]')?.textContent ?? '', /8 shown/);
    api.destroy();
  });

  test('older pages append/deduplicate and preserve selection without moving newer nodes', async () => {
    records = Array.from({ length: 405 }, (_, i) => commit(500 - i, [499 - i], i === 0 ? ['HEAD -> refs/heads/main'] : []));
    const host = document.createElement('div');
    const api = createGitHistoryMap(host);
    await api.refresh();
    api.setSelection(records[0].hash);
    const top = host.querySelector<HTMLElement>(`button[data-sha="${records[0].hash}"]`)!.style.top;
    btn(host, 'Load older').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls[1].skip, 200);
    assert.match(host.querySelector('[role="status"]')?.textContent ?? '', /400 loaded/);
    assert.equal(host.querySelector<HTMLElement>(`button[data-sha="${records[0].hash}"]`)!.style.top, top);
    assert.equal(host.querySelector('[aria-pressed="true"][data-sha]')?.getAttribute('data-sha'), records[0].hash);
    btn(host, 'Load older').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(host.querySelector('[role="status"]')?.textContent ?? '', /405 loaded/);
    assert.equal(btn(host, 'Load older').hidden, true);
    assert.ok(host.querySelectorAll('[data-sha]').length <= 181);
    api.destroy();
  });

  test('stale refresh and destroyed responses cannot paint; failures expose Retry', async () => {
    const host = document.createElement('div');
    let resolveFirst!: (value: Response) => void;
    let call = 0;
    globalThis.fetch = async () => {
      call++;
      if (call === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return { ok: true, json: async () => call === 2 ? ({ ok: false, error: 'Offline' }) : ({ ok: true, commits: [commit(10)], hasMore: false }) } as Response;
    };
    const api = createGitHistoryMap(host);
    const old = api.refresh();
    await api.refresh();
    assert.match(host.textContent ?? '', /Offline/);
    btn(host, 'Retry').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveFirst({ ok: true, json: async () => ({ ok: true, commits: [commit(99)] }) } as Response);
    await old;
    assert.ok(host.querySelector(`button[data-sha="${hash(10)}"]`));
    assert.equal(host.querySelector(`button[data-sha="${hash(99)}"]`), null);
    api.destroy();
    assert.equal(host.childElementCount, 0);
  });

  test('5,000 commits keep scene DOM bounded at detail and overview scales', () => {
    const model = buildGitHistoryModel(Array.from({ length: 5000 }, (_, i) => commit(6000 - i, [5999 - i])));
    const layout = layoutGitHistory(model);
    const host = document.createElement('div');
    const overview = document.createElement('canvas');
    const scene = renderGitHistoryScene(host, overview, model, layout, {
      onSelect() {}, onFocus() {}, onKey() {}, consumeDrag: () => false,
    });
    scene.setFocus(hash(6000));
    scene.renderVisible({ x: 0, y: 0, k: 1 }, 800, 600);
    assert.ok(host.querySelectorAll('button').length < 20);
    scene.renderVisible({ x: 0, y: 0, k: 0.001 }, 800, 600);
    assert.equal(overview.hidden, false);
    assert.ok(host.querySelectorAll('button').length <= 1);
    scene.renderVisible({ x: -400_000, y: 0, k: 1 }, 800, 600);
    assert.ok(host.querySelectorAll('button').length < 20);
    scene.destroy();
    assert.equal(host.childElementCount, 0);
  });

  test('polling retains pan, zoom and keyboard focus; older pages keep the visible commit stationary', async () => {
    records = Array.from({ length: 405 }, (_, i) => commit(500 - i, [499 - i], i === 0 ? ['HEAD -> refs/heads/main'] : []));
    const host = document.createElement('div');
    document.body.append(host);
    const api = createGitHistoryMap(host);
    const canvas = host.querySelector<HTMLElement>('.git-history-map__viewport')!;
    canvas.getBoundingClientRect = () => ({ width: 800, height: 600, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, toJSON() {} });
    await api.refresh();
    const scene = host.querySelector<HTMLElement>('.git-history-map__scene')!;
    const head = host.querySelector<HTMLButtonElement>(`button[data-sha="${records[0].hash}"]`)!;
    head.focus();
    btn(host, 'Zoom out').click();
    canvas.dispatchEvent(new dom.browser.WheelEvent('wheel', { deltaY: -220, deltaMode: 0, bubbles: true }));
    const state = scene.style.transform;
    await api.refresh();
    assert.equal(scene.style.transform, state, 'polling does not reveal the focused commit or reset zoom');
    assert.equal((document.activeElement as HTMLElement).dataset.sha, records[0].hash);
    const viewedHash = records[0].hash;
    const screenX = () => {
      const translation = Number(scene.style.transform.match(/translate\(([-.\d]+)px/)![1]);
      const scale = Number(scene.style.transform.match(/scale\(([-.\d]+)\)/)![1]);
      return translation + Number.parseFloat(host.querySelector<HTMLElement>(`button[data-sha="${viewedHash}"]`)!.style.left) * scale;
    };
    const before = screenX();
    btn(host, 'Load older').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(screenX(), before, 'older commits extend to the left without moving the viewed commit');
    records.unshift(commit(501, [500], ['HEAD -> refs/heads/main']));
    await api.refresh();
    assert.equal(screenX(), before, 'new tips do not move the viewed commit');
    api.destroy();
  });

  test('distant overview retains branch colors for nodes and links', () => {
    const model = buildGitHistoryModel(fork);
    const host = document.createElement('div');
    const overview = document.createElement('canvas');
    document.body.append(overview);
    overview.style.setProperty('--mn-accent', 'orange');
    overview.style.setProperty('--git-lane-1', 'green');
    const fills: string[] = [];
    const strokes: string[] = [];
    const context = { fillStyle: '', strokeStyle: '', lineWidth: 1,
      setTransform() {}, clearRect() {}, setLineDash() {}, beginPath() {}, moveTo() {}, bezierCurveTo() {},
      stroke() { strokes.push(this.strokeStyle); }, fillRect() { fills.push(this.fillStyle); }, strokeRect() {},
    };
    overview.getContext = (() => context) as unknown as typeof overview.getContext;
    const api = renderGitHistoryScene(host, overview, model, layoutGitHistory(model), {
      onSelect() {}, onFocus() {}, onKey() {}, consumeDrag: () => false,
    });
    api.renderVisible({ x: 0, y: 0, k: 0.1 }, 800, 600);
    assert.ok(fills.includes('orange'));
    assert.ok(fills.includes('green'), 'side branches retain their color below the detail cutoff');
    assert.ok(strokes.includes('green'), 'parent links retain branch color');
    api.destroy();
  });
});
