import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CodeMapArchitecture, CodeMapFolder, CodeMapModule } from '../../src/brain/types.ts';
import { languageTag, kindBadge, moduleIcon, monogram, packageIcon } from '../../src/ui/code-map/icons.ts';
import { layoutArchitecture, layoutCalls, layoutFolder, rankByCalls } from '../../src/ui/code-map/layout.ts';
import {
  buildArchModel,
  buildCallModel,
  buildFolderModel,
  orderLayers,
  toMermaid,
  type MapLink,
} from '../../src/ui/code-map/model.ts';

function mod(group: string, name: string, files = 4, extra: Partial<CodeMapModule> = {}): CodeMapModule {
  return {
    id: `${group}/${name}`,
    group,
    path: `${group}/${name}`,
    name,
    loose: false,
    test: false,
    files,
    symbols: files * 10,
    lines: files * 100,
    ...extra,
  };
}

function arch(over: Partial<CodeMapArchitecture> = {}): CodeMapArchitecture {
  return {
    repo: 'demo',
    base: '',
    fileCount: 40,
    symbolCount: 400,
    groups: [
      { id: 'src', path: 'src', name: 'src', test: false, files: 24, symbols: 240 },
      { id: 'server', path: 'server', name: 'server', test: false, files: 12, symbols: 120 },
      { id: 'test', path: 'test', name: 'test', test: true, files: 4, symbols: 40 },
    ],
    modules: [
      mod('src', 'ui', 8),
      mod('src', 'chat', 6),
      mod('src', 'lib', 4),
      mod('src', 'state', 3),
      mod('src', 'tools', 3),
      mod('server', 'api', 6),
      mod('server', 'db', 6),
      mod('test', 'ui', 4, { test: true }),
    ],
    edges: [
      { src: 'src/ui', dst: 'src/chat', n: 30 },
      { src: 'src/ui', dst: 'src/lib', n: 9 },
      { src: 'src/chat', dst: 'src/lib', n: 6 },
      { src: 'src/state', dst: 'src/lib', n: 4 },
      { src: 'src/tools', dst: 'src/lib', n: 3 },
      { src: 'src/chat', dst: 'server/api', n: 12 },
      { src: 'server/api', dst: 'server/db', n: 20 },
      { src: 'server/db', dst: 'src/state', n: 2 },
      { src: 'test/ui', dst: 'src/ui', n: 50 },
    ],
    externals: [
      { name: 'better-sqlite3', files: 3, testFiles: 0, modules: { 'server/db': 3 } },
      { name: 'react', files: 1, testFiles: 0, modules: { 'src/ui': 1 } },
    ],
    ...over,
  };
}

describe('code map architecture model', () => {
  it('hides test layers by default and orders callers above callees', () => {
    const model = buildArchModel(arch(), { showTests: false, links: 'all', expandedGroups: new Set() });
    assert.deepEqual(
      model.layers.map((l) => l.id),
      ['src', 'server', '@external'],
    );
    assert.equal(model.hiddenTestGroups, 1);
    assert.equal(model.nodes.has('test/ui'), false);
    const withTests = buildArchModel(arch(), { showTests: true, links: 'all', expandedGroups: new Set() });
    assert.equal(withTests.layers[0]?.id, 'test');
  });

  it('marks links that run up the layer order as back links', () => {
    const model = buildArchModel(arch(), { showTests: false, links: 'all', expandedGroups: new Set() });
    const back = model.links.find((l) => l.src === 'server/db' && l.dst === 'src/state');
    assert.equal(back?.back, true);
    assert.equal(model.links.find((l) => l.src === 'src/chat' && l.dst === 'server/api')?.back, false);
  });

  it('turns a module most others call into a hub with quiet incoming links', () => {
    const model = buildArchModel(arch(), { showTests: false, links: 'all', expandedGroups: new Set() });
    assert.deepEqual(model.hubs, ['src/lib']);
    assert.equal(model.nodes.get('src/lib')?.usedBy, 4);
    assert.ok(model.links.filter((l) => l.dst === 'src/lib').every((l) => l.quiet));
    assert.equal(model.links.find((l) => l.src === 'src/ui' && l.dst === 'src/chat')?.quiet, false);
  });

  it('folds small modules into one card per layer and unfolds on request', () => {
    const many = arch({
      modules: [...arch().modules, ...['a', 'b', 'c', 'd', 'e'].map((n) => mod('src', n, 1))],
    });
    const folded = buildArchModel(many, { showTests: false, links: 'all', expandedGroups: new Set(), perLayer: 5 });
    const more = folded.nodes.get('more:src');
    assert.equal(more?.kind, 'more');
    assert.equal(more?.folded?.length, 5);
    assert.equal(folded.layers[0]?.nodeIds.at(-1), 'more:src');
    const open = buildArchModel(many, { showTests: false, links: 'all', expandedGroups: new Set(['src']), perLayer: 5 });
    assert.equal(open.nodes.has('more:src'), false);
  });

  it('shows packages used in at least two files as quiet external links', () => {
    const model = buildArchModel(arch(), { showTests: false, links: 'all', expandedGroups: new Set() });
    const pkg = model.nodes.get('pkg:better-sqlite3');
    assert.equal(pkg?.kind, 'package');
    assert.equal(model.nodes.has('pkg:react'), false);
    const link = model.links.find((l) => l.dst === 'pkg:better-sqlite3');
    assert.equal(link?.external, true);
    assert.equal(link?.quiet, true);
  });

  it('cross-layer filter quiets links inside a layer', () => {
    const model = buildArchModel(arch(), { showTests: false, links: 'cross', expandedGroups: new Set() });
    assert.equal(model.links.find((l) => l.src === 'src/ui' && l.dst === 'src/chat')?.quiet, true);
    assert.equal(model.links.find((l) => l.src === 'src/chat' && l.dst === 'server/api')?.quiet, false);
  });

  it('orders layers by net outgoing calls', () => {
    const order = orderLayers(
      ['db', 'ui', 'api'],
      [
        { srcLayer: 'ui', dstLayer: 'api', n: 5 },
        { srcLayer: 'api', dstLayer: 'db', n: 5 },
      ],
      () => 0,
    );
    assert.deepEqual(order, ['ui', 'api', 'db']);
  });

  it('lays out every card inside its layer frame with a path per link', () => {
    const model = buildArchModel(arch(), { showTests: false, links: 'all', expandedGroups: new Set() });
    const layout = layoutArchitecture(model);
    for (const layer of model.layers) {
      const frame = layout.frames.find((f) => f.id === layer.id)!;
      for (const id of layer.nodeIds) {
        const box = layout.boxes.get(id)!;
        assert.ok(box.x >= frame.x && box.x + box.w <= frame.x + frame.w, `${id} inside ${layer.id} horizontally`);
        assert.ok(box.y >= frame.y && box.y + box.h <= frame.y + frame.h, `${id} inside ${layer.id} vertically`);
      }
    }
    for (const link of model.links) assert.match(layout.paths.get(link.id) ?? '', /^M[\d.-]+ [\d.-]+C/);
    assert.ok(layout.width > 0 && layout.height > 0);
  });

  it('exports drawn links as Mermaid, dashed when they run backwards', () => {
    const model = buildArchModel(arch(), { showTests: false, links: 'all', expandedGroups: new Set() });
    const text = toMermaid(model.nodes, model.links);
    assert.match(text, /^flowchart TD/);
    assert.match(text, /-\.->/);
    assert.doesNotMatch(text, /better-sqlite3"\]\n.*-->.*pkg/);
  });
});

describe('code map files and calls', () => {
  const folder: CodeMapFolder = {
    path: 'pkg',
    nodes: [
      { id: 'pkg/routes.js', kind: 'file', path: 'pkg/routes.js', name: 'routes.js', symbols: 4, lines: 290, files: 1, outside: 0, callsIn: 0, callsOut: 9 },
      { id: 'pkg/query.js', kind: 'file', path: 'pkg/query.js', name: 'query.js', symbols: 10, lines: 464, files: 1, outside: 3, callsIn: 9, callsOut: 8 },
      { id: 'pkg/rank.js', kind: 'file', path: 'pkg/rank.js', name: 'rank.js', symbols: 4, lines: 111, files: 1, outside: 0, callsIn: 5, callsOut: 0 },
      { id: 'pkg/cascade.js', kind: 'file', path: 'pkg/cascade.js', name: 'cascade.js', symbols: 9, lines: 792, files: 1, outside: 0, callsIn: 6, callsOut: 3 },
      { id: 'pkg/config.js', kind: 'file', path: 'pkg/config.js', name: 'config.js', symbols: 2, lines: 108, files: 1, outside: 0, callsIn: 0, callsOut: 0 },
    ],
    edges: [
      { src: 'pkg/routes.js', dst: 'pkg/query.js', n: 9 },
      { src: 'pkg/query.js', dst: 'pkg/cascade.js', n: 6 },
      { src: 'pkg/query.js', dst: 'pkg/rank.js', n: 2 },
      { src: 'pkg/cascade.js', dst: 'pkg/query.js', n: 3 },
    ],
    hidden: [],
    calledFrom: [],
    callsInto: [],
    summary: null,
  };

  it('ranks callers left of callees, breaking cycles, and parks unlinked files', () => {
    const model = buildFolderModel(folder, 'all');
    const layout = layoutFolder(model);
    const x = (id: string) => layout.boxes.get(id)!.x;
    assert.ok(x('pkg/routes.js') < x('pkg/query.js'));
    assert.ok(x('pkg/query.js') < x('pkg/cascade.js'));
    assert.ok(x('pkg/query.js') < x('pkg/rank.js'));
    const cycle = model.links.find((l) => l.src === 'pkg/cascade.js' && l.dst === 'pkg/query.js');
    assert.equal(cycle?.back, true);
    assert.equal(model.nodes.get('pkg/config.js')?.layer, -1);
    assert.ok(layout.frames.some((f) => f.id === '@unlinked'));
  });

  it('ranks an acyclic chain by depth', () => {
    const links: MapLink[] = [
      { id: 'a', src: 'a', dst: 'b', n: 1, back: false, cross: true, quiet: false, external: false },
      { id: 'b', src: 'b', dst: 'c', n: 1, back: false, cross: true, quiet: false, external: false },
      { id: 'c', src: 'a', dst: 'c', n: 1, back: false, cross: true, quiet: false, external: false },
    ];
    const rank = rankByCalls(['a', 'b', 'c'], links, () => 0);
    assert.deepEqual([rank.get('a'), rank.get('b'), rank.get('c')], [0, 1, 2]);
  });

  it('builds call columns and hides common method names', () => {
    const ref = (id: string, name: string) => ({ symbolId: id, name, file: `src/${name}.ts`, line: 1, signature: '', kind: 'calls' });
    const model = buildCallModel(
      { id: 'c', name: 'repoMap', kind: 'function', file: 'server/query.js', line: 372 },
      [ref('r1', 'route'), ref('r2', 'tool')],
      [ref('d1', 'renderRepoMap'), ref('d2', 'map'), ref('d3', 'getCodeDb')],
      { hideCommon: true },
    );
    assert.deepEqual(model.columns.get(-1), ['r1', 'r2']);
    assert.deepEqual(model.columns.get(1), ['d1', 'd3']);
    assert.equal(model.hiddenCommon, 1);
    const layout = layoutCalls(model);
    assert.ok(layout.boxes.get('r1')!.x < layout.boxes.get('c')!.x);
    assert.ok(layout.boxes.get('c')!.x < layout.boxes.get('d1')!.x);
    assert.equal(model.links.length, 4);
  });
});

describe('code map icons', () => {
  it('matches folder names to glyphs, whole name first then words', () => {
    assert.deepEqual(moduleIcon('ui'), { kind: 'glyph', cls: 'fi-rr-browser' });
    assert.deepEqual(moduleIcon('__tests__'), { kind: 'glyph', cls: 'fi-rr-flask' });
    assert.deepEqual(moduleIcon('code-index'), { kind: 'glyph', cls: 'fi-rr-search' });
    assert.deepEqual(moduleIcon('zebra'), { kind: 'mono', text: 'Ze' });
  });

  it('builds two-letter monograms', () => {
    assert.equal(monogram('orchestrator'), 'Or');
    assert.equal(monogram('agent-browser'), 'AB');
    assert.equal(monogram('superPlan'), 'SP');
    assert.equal(monogram('@scope/left-pad'), 'LP');
  });

  it('categorises packages, tags languages and badges symbol kinds', () => {
    assert.deepEqual(packageIcon('better-sqlite3'), { kind: 'glyph', cls: 'fi-rr-database' });
    assert.deepEqual(packageIcon('@xterm/xterm'), { kind: 'glyph', cls: 'fi-rr-terminal' });
    assert.equal(packageIcon('lodash').kind, 'mono');
    assert.equal(languageTag('query.js'), 'JS');
    assert.equal(languageTag('view.tsx'), 'TSX');
    assert.equal(languageTag('Makefile'), '');
    assert.equal(kindBadge('function'), 'fn');
    assert.equal(kindBadge('Class'), 'C');
  });
});
