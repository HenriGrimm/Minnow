import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assignCommitVisuals,
  buildMainlineSet,
  computeCollapsedRows,
  computeCollapsedMainlineLayout,
  computeGraphLayout,
  computeSquashLinks,
  detectTrunkBranch,
  extractLocalBranchRefs,
  graphMarkerWidthPx,
  maxLaneIndex,
  maxLaneIndexForRow,
} from '../../src/ui/git-graph.ts';
import type { GitCommitEntry } from '../../src/state/git-api.ts';

function commit(
  hash: string,
  parents: string[],
  overrides: Partial<GitCommitEntry> = {},
): GitCommitEntry {
  return {
    hash,
    parents,
    subject: overrides.subject ?? hash.slice(0, 7),
    author: overrides.author ?? 'author',
    relativeTime: overrides.relativeTime ?? '1 day ago',
    refs: overrides.refs ?? [],
  };
}

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccccccccccc';
const D = 'dddddddddddddddddddddddddddddddddddddddd';
const E = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const M = '1111111111111111111111111111111111111111';

// ── detectTrunkBranch ────────────────────────────────────────────────────────

describe('detectTrunkBranch', () => {
  it('prefers main when present in refs', () => {
    const trunk = detectTrunkBranch([
      commit(C, [], { refs: ['HEAD -> main', 'origin/main'] }),
    ]);
    assert.equal(trunk, 'main');
  });
});

// ── assignCommitVisuals ──────────────────────────────────────────────────────

describe('assignCommitVisuals', () => {
  it('marks mainline commits with the accent color', () => {
    const commits = [
      commit(C, [B], { refs: ['HEAD -> main'] }),
      commit(B, [A]),
      commit(A, []),
    ];

    const visuals = assignCommitVisuals(commits, 'main');
    assert.equal(visuals[0].isMain, true);
    assert.equal(visuals[0].colorIndex, 0);
    assert.equal(visuals[1].isMain, true);
    assert.equal(visuals[2].isMain, true);
  });

  it('gives side-branch commits their own branch key and color', () => {
    const commits = [
      commit(D, [C], { refs: ['feature/test'] }),
      commit(C, [B], { refs: ['HEAD -> main'] }),
      commit(B, [A]),
      commit(A, []),
    ];

    const visuals = assignCommitVisuals(commits, 'main');
    assert.equal(visuals[0].isMain, false);
    assert.equal(visuals[0].branchKey, 'feature/test');
    assert.notEqual(visuals[0].colorIndex, 0);
    assert.equal(visuals[1].isMain, true);
  });
});

// ── computeGraphLayout ───────────────────────────────────────────────────────

describe('computeGraphLayout', () => {
  it('keeps a linear history on one continuous lane', () => {
    const rows = computeGraphLayout(
      assignCommitVisuals(
        [commit(C, [B], { refs: ['HEAD -> main'] }), commit(B, [A]), commit(A, [])],
        'main',
      ),
    );

    assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
    assert.deepEqual(rows[0].rails.map((r) => r.kind), ['down']);
    assert.deepEqual(rows[1].rails.map((r) => r.kind), ['up', 'down']);
    assert.deepEqual(rows[2].rails.map((r) => r.kind), ['up']);
    assert.equal(maxLaneIndex(rows), 0);
  });

  it('puts a side branch on its own lane and curves it into the fork commit', () => {
    // D (feature) forks from A; main is C -> B -> A.
    const rows = computeGraphLayout(
      assignCommitVisuals(
        [
          commit(D, [A], { refs: ['feature/test'] }),
          commit(C, [B], { refs: ['HEAD -> main'] }),
          commit(B, [A]),
          commit(A, []),
        ],
        'main',
      ),
    );

    // Newest commit claims lane 0; main runs beside it on lane 1.
    assert.equal(rows[0].lane, 0);
    assert.equal(rows[1].lane, 1);
    assert.equal(rows[2].lane, 1);
    assert.equal(rows[3].lane, 0);

    // Feature lane passes through the main rows without breaking.
    assert.ok(rows[1].rails.some((r) => r.lane === 0 && r.kind === 'through'));
    assert.ok(rows[2].rails.some((r) => r.lane === 0 && r.kind === 'through'));

    // At the fork commit, main's lane curves into the dot.
    assert.deepEqual(rows[3].curves, [
      { kind: 'in', fromLane: 1, toLane: 0, colorIndex: rows[2].colorIndex },
    ]);
    assert.equal(maxLaneIndex(rows), 1);
  });

  it('swings merge parents out to a branch lane and back into the fork point', () => {
    // M merges feature E into main: M(B, E), E branches from A, B -> A.
    const rows = computeGraphLayout(
      assignCommitVisuals(
        [
          commit(M, [B, E], { refs: ['HEAD -> main'] }),
          commit(E, [A], { refs: ['feature/test'] }),
          commit(B, [A]),
          commit(A, []),
        ],
        'main',
      ),
    );

    const featureColor = rows[1].colorIndex;

    // Merge row: dot on lane 0, curve out to the feature lane in its color.
    assert.equal(rows[0].lane, 0);
    assert.deepEqual(rows[0].curves, [
      { kind: 'out', fromLane: 0, toLane: 1, colorIndex: featureColor },
    ]);

    // Feature commit sits on lane 1 with main passing through, and bends
    // back into main's lane right at its last commit (squash simplification).
    assert.equal(rows[1].lane, 1);
    assert.ok(rows[1].rails.some((r) => r.lane === 0 && r.kind === 'through'));
    assert.ok(rows[1].rails.some((r) => r.lane === 1 && r.kind === 'up'));
    assert.deepEqual(rows[1].curves, [
      { kind: 'out', fromLane: 1, toLane: 0, colorIndex: featureColor, joins: true },
    ]);

    // The fork commit needs no extra connector — the branch already rejoined.
    assert.equal(rows[3].lane, 0);
    assert.deepEqual(rows[3].curves, []);
  });

  it('reuses a lane that already expects the same merge parent', () => {
    // Two merges of the same branch tip: M(B, E) then B(A, E).
    const rows = computeGraphLayout(
      assignCommitVisuals(
        [
          commit(M, [B, E], { refs: ['HEAD -> main'] }),
          commit(B, [A, E]),
          commit(E, [A], { refs: ['feature/test'] }),
          commit(A, []),
        ],
        'main',
      ),
    );

    // Second merge curves out to the existing feature lane instead of a new one.
    assert.deepEqual(rows[1].curves.map((c) => ({ kind: c.kind, toLane: c.toLane })), [
      { kind: 'out', toLane: 1 },
    ]);
    assert.equal(rows[2].lane, 1);
    assert.equal(maxLaneIndex(rows), 1);
  });

  it('lands a commit on the lane already heading to it', () => {
    // D (feature/a) sits directly on top of main's C; E (feature/b) forks from B.
    const rows = computeGraphLayout(
      assignCommitVisuals(
        [
          commit(D, [C], { refs: ['feature/a'] }),
          commit(C, [B], { refs: ['HEAD -> main'] }),
          commit(E, [B], { refs: ['feature/b'] }),
          commit(B, [A]),
          commit(A, []),
        ],
        'main',
      ),
    );

    // C lands on lane 0 because D's edge points at it; main continues there.
    assert.equal(rows[0].lane, 0);
    assert.equal(rows[1].lane, 0);
    // feature/b takes the next free lane and immediately bends back into main.
    assert.equal(rows[2].lane, 1);
    assert.deepEqual(
      rows[2].curves.map((c) => ({
        kind: c.kind,
        fromLane: c.fromLane,
        toLane: c.toLane,
        ...(c.joins ? { joins: true } : {}),
      })),
      [{ kind: 'out', fromLane: 1, toLane: 0, joins: true }],
    );
    assert.equal(rows[3].lane, 0);
    assert.deepEqual(rows[3].curves, []);
  });
});

// ── computeSquashLinks ───────────────────────────────────────────────────────

describe('computeSquashLinks', () => {
  const squashHistory = [
    commit(M, [B], { refs: ['HEAD -> main'], subject: 'Add feature (#12)' }),
    commit(E, [D], { refs: ['feature/test'], subject: 'Polish feature' }),
    commit(D, [B], { subject: 'Add feature' }),
    commit(B, [A], { subject: 'base work' }),
    commit(A, [], { subject: 'root' }),
  ];

  it('links a squash commit to the newest commit of the branch with its PR title', () => {
    const links = computeSquashLinks(assignCommitVisuals(squashHistory, 'main'));
    assert.deepEqual([...links.entries()], [[M, E]]);
  });

  it('links nothing without a (#N) suffix or a matching branch commit', () => {
    const links = computeSquashLinks(
      assignCommitVisuals(
        [
          commit(M, [B], { refs: ['HEAD -> main'], subject: 'Add feature' }),
          commit(E, [B], { refs: ['feature/test'], subject: 'Unrelated work' }),
          commit(B, [A], { subject: 'base work' }),
          commit(A, [], { subject: 'root' }),
        ],
        'main',
      ),
    );
    assert.equal(links.size, 0);
  });

  it('draws squash links as phantom merge edges in the layout', () => {
    const visuals = assignCommitVisuals(squashHistory, 'main');
    const rows = computeGraphLayout(visuals, computeSquashLinks(visuals));

    // Squash commit swings out to the branch lane like a merge.
    assert.deepEqual(
      rows[0].curves.map((c) => ({ kind: c.kind, toLane: c.toLane })),
      [{ kind: 'out', toLane: 1 }],
    );
    // The branch tip lands on that lane, and its oldest commit hooks back.
    assert.equal(rows[1].lane, 1);
    assert.ok(rows[1].rails.some((r) => r.lane === 1 && r.kind === 'up'));
    assert.deepEqual(
      rows[2].curves.map((c) => ({
        kind: c.kind,
        fromLane: c.fromLane,
        toLane: c.toLane,
        ...(c.joins ? { joins: true } : {}),
      })),
      [{ kind: 'out', fromLane: 1, toLane: 0, joins: true }],
    );
  });
});

// ── computeCollapsedRows ─────────────────────────────────────────────────────

describe('computeCollapsedRows', () => {
  it('keeps only mainline rows and clusters branch commits on their fork base', () => {
    // feature: E -> D forking from main's B; main: C -> B -> A.
    const rows = computeCollapsedRows(
      assignCommitVisuals(
        [
          commit(E, [D], { refs: ['feature/test'] }),
          commit(D, [B]),
          commit(C, [B], { refs: ['HEAD -> main'] }),
          commit(B, [A]),
          commit(A, []),
        ],
        'main',
      ),
    );

    assert.deepEqual(
      rows.map((row) => row.visual.commit.hash),
      [C, B, A],
    );
    assert.equal(rows[0].clusters.length, 0);
    assert.equal(rows[1].clusters.length, 1);
    assert.equal(rows[1].clusters[0].branchKey, 'feature/test');
    assert.equal(rows[1].clusters[0].count, 2);
    assert.equal(rows[2].clusters.length, 0);
  });

  it('clusters merged branch commits onto the mainline commit they forked from', () => {
    // M merges feature E; both fork from A.
    const rows = computeCollapsedRows(
      assignCommitVisuals(
        [
          commit(M, [B, E], { refs: ['HEAD -> main'] }),
          commit(E, [A], { refs: ['feature/test'] }),
          commit(B, [A]),
          commit(A, []),
        ],
        'main',
      ),
    );

    assert.deepEqual(
      rows.map((row) => row.visual.commit.hash),
      [M, B, A],
    );
    assert.equal(rows[2].clusters.length, 1);
    assert.equal(rows[2].clusters[0].branchKey, 'feature/test');
  });

  it('caps shown clusters and counts the overflow', () => {
    const tips = ['1010101010101010101010101010101010101010',
      '2020202020202020202020202020202020202020',
      '3030303030303030303030303030303030303030',
      '4040404040404040404040404040404040404040'];
    const rows = computeCollapsedRows(
      assignCommitVisuals(
        [
          ...tips.map((tip, i) => commit(tip, [B], { refs: [`feature/${i}`] })),
          commit(B, [A], { refs: ['HEAD -> main'] }),
          commit(A, []),
        ],
        'main',
      ),
    );

    assert.equal(rows[0].visual.commit.hash, B);
    assert.equal(rows[0].clusters.length, 3);
    assert.equal(rows[0].extraCount, 1);
  });
});

// ── computeCollapsedMainlineLayout ───────────────────────────────────────────

describe('computeCollapsedMainlineLayout', () => {
  it('uses a single lane with no merge curves', () => {
    const main = assignCommitVisuals(
      [
        commit(C, [B], { refs: ['HEAD -> main'] }),
        commit(B, [A]),
        commit(A, []),
      ],
      'main',
    ).filter((v) => v.isMain);

    const laidOut = computeCollapsedMainlineLayout(main);

    assert.equal(laidOut.length, 3);
    assert.ok(laidOut.every((v) => v.lane === 0 && v.curves.length === 0));
    assert.deepEqual(
      laidOut.map((v) => v.rails.map((r) => r.kind)),
      [['down'], ['through'], ['up']],
    );
  });
});

// ── buildMainlineSet ─────────────────────────────────────────────────────────

describe('buildMainlineSet', () => {
  it('follows first parents from the trunk tip', () => {
    const commits = [
      commit(C, [B], { refs: ['HEAD -> main'] }),
      commit(B, [A]),
      commit(A, []),
    ];

    const mainline = buildMainlineSet(commits, 'main');
    assert.equal(mainline.size, 3);
  });
});

// ── extractLocalBranchRefs ───────────────────────────────────────────────────

describe('extractLocalBranchRefs', () => {
  it('handles canonical local refs without treating arbitrary remotes or detached HEAD as branches', () => {
    assert.deepEqual(extractLocalBranchRefs(['HEAD -> refs/heads/feature/a', 'refs/heads/feature/a', 'refs/remotes/upstream/feature/a', 'refs/remotes/mirror/main', 'HEAD', 'tag: refs/tags/v1']), ['feature/a']);
  });
  it('keeps local branches and HEAD pointers', () => {
    const refs = extractLocalBranchRefs([
      'HEAD -> main',
      'feature/foo',
      'origin/main',
      'remotes/origin/dev',
      'tag: v1.0',
    ]);
    assert.deepEqual(refs, ['main', 'feature/foo']);
  });

  it('deduplicates branch names', () => {
    const refs = extractLocalBranchRefs(['main', 'HEAD -> main']);
    assert.deepEqual(refs, ['main']);
  });
});

// ── graphMarkerWidthPx ───────────────────────────────────────────────────────

describe('graphMarkerWidthPx', () => {
  it('uses only lanes active on the row, not the global graph width', () => {
    const rows = computeGraphLayout(
      assignCommitVisuals(
        [
          commit(E, [D], { refs: ['feature/test'] }),
          commit(D, [B]),
          commit(C, [B], { refs: ['HEAD -> main'] }),
          commit(B, [A]),
          commit(A, []),
        ],
        'main',
      ),
    );
    const step = 14;
    const globalMaxLane = maxLaneIndex(rows);
    const globalWidth = Math.max(step, step * (globalMaxLane + 1));

    const lane0Only = rows.find((r) => maxLaneIndexForRow(r) === 0);
    assert.ok(lane0Only);
    assert.equal(graphMarkerWidthPx(lane0Only!, step), step);

    const widestRow = rows.find((r) => maxLaneIndexForRow(r) === globalMaxLane);
    assert.ok(widestRow);
    assert.equal(graphMarkerWidthPx(widestRow!, step), globalWidth);
    if (globalMaxLane > 0) {
      assert.ok(graphMarkerWidthPx(lane0Only!, step) < graphMarkerWidthPx(widestRow!, step));
    }
  });
});
