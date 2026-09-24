/**
 * Deterministic compactor (context compaction v2, Phase 1): segmentation,
 * extraction, summary format, merge, elision, projection.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  COMPACTION_HEADER_PREFIX,
  COMPACTION_MERGE_MARK,
  compactMessages,
  compactionFoldView,
  defaultSummaryBudgetTokens,
  formatCompactionSummary,
  ingestRows,
  isElidedToolStub,
  latestCompactionCheckpoint,
  normalizeCompactionCheckpoint,
  projectMessages,
  resolveCompactionConfig,
  segmentTurns,
  toPersistedCompaction,
  transcriptRowsWithIds,
} from '../../server/runner/compaction/index.js';
import {
  applyContextBudget,
  estimateApiMessagesTokens,
  normalizeContextEnforcementPolicy,
  sanitizeToolPairing,
} from '../../server/runner/context-budget.js';
import { charsPerTokenFor } from '../../server/runner/token-estimate-core.js';
import { browserSession, debugSession, hugeSession, refactorSession } from './compaction-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(HERE, '__golden__');

/** @param {string} name @param {string} actual */
function assertGolden(name, actual) {
  const file = path.join(GOLDEN_DIR, `${name}.txt`);
  if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(file)) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, actual);
  }
  assert.equal(actual, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `golden ${name} drifted (UPDATE_GOLDEN=1 to accept)`);
}

/** Fold everything but the last turn, the way `/compact` does. */
function manualSummary(rows) {
  const out = compactMessages({ messages: rows, limit: 1_000_000, window: 128_000, trigger: 'manual', config: resolveCompactionConfig({ minRecentTurns: 1 }, 128_000) });
  assert.equal(out.changed, true);
  return out;
}

function rolesOf(messages) {
  return messages.map((m) => (m.role === 'user' && m.toolImageFollowUp ? 'i' : m.role[0])).join(' ');
}

describe('segmentTurns', () => {
  it('turns open on real user rows; screenshot follow-ups stay inside the round', () => {
    const rows = browserSession(3);
    const turns = segmentTurns(rows, 1);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].userIndex, 1);
    // user row, then 3 screenshot rounds (assistant + tool + follow-up), one edit round
    assert.deepEqual(turns[0].rounds.map((r) => r.end - r.start), [1, 3, 3, 3, 2]);
  });
});

describe('golden summaries', () => {
  it('refactor session', () => {
    assertGolden('compaction-refactor', manualSummary(refactorSession()).checkpoint.summary);
  });
  it('debug session', () => {
    assertGolden('compaction-debug', manualSummary(debugSession()).checkpoint.summary);
  });
  it('browser session', () => {
    const rows = [...browserSession(9), { role: 'assistant', content: 'Overflow fixed at 400px.' }, { role: 'user', content: 'Thanks' }];
    assertGolden('compaction-browser', manualSummary(rows).checkpoint.summary);
  });
});

describe('extract', () => {
  it('retains every file affected by a multi-file patch', () => {
    const patch = '*** Begin Patch\n*** Add File: a.ts\n+a\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-old\n+new\n*** Delete File: gone.ts\n*** End Patch';
    const rows = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'patch-1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch }) } }] },
      { role: 'tool', tool_call_id: 'patch-1', content: 'Applied patch' },
    ];
    const state = ingestRows(null, rows.map((row, id) => ({ id, row })));
    for (const [path, op] of [['a.ts', 'created'], ['old.ts', 'moved'], ['new.ts', 'created'], ['gone.ts', 'deleted']]) {
      assert.ok(state.files.find(file => file.path === path)?.ops.includes(op));
    }
  });
  it('captures goal, notes, scope changes, files with stats, commits, todos and resolved problems', () => {
    const rows = refactorSession();
    const state = ingestRows(null, rows.slice(1).map((row, i) => ({ id: i + 1, row })));
    assert.match(state.goal, /^Refactor the session store/);
    assert.ok(state.notes.some((n) => /Always keep the public API unchanged/.test(n)));
    assert.equal(state.scopeChanges.length, 1);
    assert.match(state.scopeChanges[0].text, /microtask queue/);
    const store = state.files.find((f) => f.path === 'src/state/store.ts');
    assert.deepEqual(store.ops, ['modified', 'read']);
    assert.equal(store.additions, 30);
    assert.equal(store.deletions, 13);
    assert.deepEqual(state.files.find((f) => f.path === 'src/state/queue.ts').ops, ['created']);
    assert.deepEqual(state.commits.map((c) => [c.hash, c.subject]), [['4f2a9c1', 'Batch session store writes']]);
    assert.deepEqual(state.todos, ['[~] Write flush-on-quit test', '[ ] Run the full store suite']);
    const testRun = state.problems.find((p) => p.key.startsWith('execute_command:npm test -- store'));
    assert.equal(testRun.status, 'resolved', 'a later passing run resolves the failing one');
    assert.equal(state.status.lastFileAction, 'created test/state/flush-quit.test.ts');
  });

  it('keeps an unresolved tool error open', () => {
    const state = ingestRows(null, debugSession().map((row, i) => ({ id: i, row })));
    const open = state.problems.filter((p) => p.status === 'open').map((p) => p.text);
    assert.ok(open.some((t) => /part-5\.js: Error: search text not found/.test(t)), open.join('\n'));
    assert.ok(state.problems.some((p) => p.key.startsWith('execute_command:npm run package:dir') && p.status === 'resolved'));
    assert.equal(state.subAgents[0].type, 'explorer');
  });

  it('incremental ingest equals one-shot ingest', () => {
    const entries = debugSession().map((row, i) => ({ id: i, row }));
    const cut = entries.findIndex((e, i) => i > 20 && e.row.role === 'user');
    const incremental = ingestRows(ingestRows(null, entries.slice(0, cut)), entries.slice(cut));
    assert.deepEqual(incremental, ingestRows(null, entries));
  });
});

describe('format', () => {
  it('orders stable sections before volatile ones', () => {
    const summary = manualSummary(refactorSession()).checkpoint.summary;
    assert.ok(summary.startsWith(COMPACTION_HEADER_PREFIX));
    const order = ['[Session goal]', '[User notes]', '[Files]', '[Commits]', '[Earlier turns]', '[Open problems]', '[Current status]']
      .map((title) => summary.indexOf(title));
    assert.ok(order.every((at) => at >= 0), summary);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  it('honors the budget by dropping whole lines', () => {
    const state = ingestRows(null, hugeSession(60).map((row, i) => ({ id: i, row })));
    for (const budget of [400, 900, 3000]) {
      const text = formatCompactionSummary(state, { budgetTokens: budget });
      assert.ok(text.length <= Math.floor(budget * charsPerTokenFor('prose')), `budget ${budget}: ${text.length}`);
      assert.ok(text.includes('[Session goal]'));
    }
  });

  it('defaults to min(6k, 12% of window)', () => {
    assert.equal(defaultSummaryBudgetTokens(16_000), 1920);
    assert.equal(defaultSummaryBudgetTokens(200_000), 6000);
    assert.equal(defaultSummaryBudgetTokens(2000), 400);
  });
});

describe('compactMessages', () => {
  it('is deterministic: same rows → same bytes', () => {
    const a = compactMessages({ messages: debugSession(), limit: 20_000, window: 24_000 });
    const b = compactMessages({ messages: debugSession(), limit: 20_000, window: 24_000 });
    assert.equal(a.changed, true);
    assert.equal(JSON.stringify(a.messages), JSON.stringify(b.messages));
    assert.equal(JSON.stringify(a.checkpoint), JSON.stringify(b.checkpoint));
  });

  it('keeps the latest user request verbatim and tool pairing valid at every window', () => {
    const rows = refactorSession();
    const request = 'Now add a test for the flush-on-quit path.';
    for (const limit of [3000, 6000, 9000, 14_000]) {
      const out = compactMessages({ messages: rows, limit, window: limit });
      assert.ok(out.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.endsWith(request)), `limit ${limit}`);
      assert.deepEqual(sanitizeToolPairing(out.messages), out.messages, `pairing at ${limit}`);
      assert.equal(out.messages[0].role, 'system');
      assert.ok(out.tokensAfter <= limit, `limit ${limit}: ${out.tokensAfter}`);
    }
  });

  it('merges the summary into a following user row so roles alternate', () => {
    const out = compactMessages({ messages: debugSession(), limit: 2500, window: 4000 });
    for (let i = 1; i < out.messages.length; i += 1) {
      const both = out.messages[i].role === 'user' && out.messages[i - 1].role === 'user' && !out.messages[i].toolImageFollowUp;
      assert.equal(both, false, `consecutive user rows at ${i}: ${rolesOf(out.messages)}`);
    }
    const merged = out.messages.find((m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_HEADER_PREFIX));
    assert.ok(merged.content.includes(COMPACTION_MERGE_MARK));
  });

  it('elides old tool bodies before folding when that is enough', () => {
    const rows = refactorSession();
    const total = estimateApiMessagesTokens(rows);
    const out = compactMessages({ messages: rows, limit: Math.ceil(total * 1.15), window: 64_000 });
    assert.equal(out.changed, true);
    assert.equal(out.checkpoint.foldThroughRow, null, 'nothing folded');
    assert.ok(out.elidedRows > 0);
    assert.ok(out.messages.some((m) => m.role === 'tool' && isElidedToolStub(m.content)));
  });

  it('merges into the previous checkpoint instead of rescanning', () => {
    const rows = debugSession(20);
    const first = compactMessages({ messages: rows, limit: 3000, window: 24_000 });
    const grown = [...first.messages, ...debugSession(4).slice(2)];
    const ids = [...first.ids, ...debugSession(4).slice(2).map((_, i) => rows.length + i)];
    const originals = new Map(rows.map((row, i) => [i, row]));
    const second = compactMessages({
      messages: grown,
      limit: 2000,
      window: 24_000,
      prev: first.checkpoint,
      idOf: (_row, i) => ids[i],
      originalOf: (id) => originals.get(id),
    });
    assert.equal(second.changed, true);
    assert.ok(second.checkpoint.foldThroughRow > first.checkpoint.foldThroughRow);
    assert.equal(second.checkpoint.state.goal, first.checkpoint.state.goal, 'sticky goal survives the merge');
    assert.ok(second.checkpoint.state.folded.turns > first.checkpoint.state.folded.turns);
  });

  it('compacts a 3 MB history in under 100 ms', () => {
    const rows = hugeSession(340);
    assert.ok(JSON.stringify(rows).length > 3_000_000);
    let best = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      const out = compactMessages({ messages: rows, limit: 100_000, window: 128_000 });
      best = Math.min(best, performance.now() - t0);
      assert.ok(out.tokensAfter <= 100_000);
    }
    assert.ok(best < 100, `best of 3: ${best.toFixed(1)} ms`);
  });
});

describe('projection and checkpoints', () => {
  it('reprojects persisted history to the same bytes the compaction produced', () => {
    const history = debugSession();
    const out = compactMessages({ messages: history, limit: 2500, window: 4000 });
    // Persist: rows stay, a context row carries the checkpoint.
    const withRow = [...history, { role: 'context', policy: 'compact', droppedTurns: 1, createdAt: 1, compaction: toPersistedCompaction(out.checkpoint) }];
    const latest = latestCompactionCheckpoint(withRow);
    assert.equal(latest.index, history.length);
    const { rows, ids } = transcriptRowsWithIds(withRow);
    const projected = projectMessages(rows, ids, latest.checkpoint);
    assert.equal(JSON.stringify(sanitizeToolPairing(projected.messages)), JSON.stringify(out.messages));
  });

  it('normalizes a persisted payload', () => {
    const cp = normalizeCompactionCheckpoint({ version: 1, foldThroughIndex: 12, summary: 's', state: { goal: 'g' }, trigger: 'manual' });
    assert.equal(cp.foldThroughRow, 12);
    assert.equal(cp.elideThroughRow, null);
    assert.equal(cp.state.goal, 'g');
    assert.deepEqual(cp.state.files, []);
    assert.equal(normalizeCompactionCheckpoint({ summary: 'x' }), null);
  });

  it('fold view marks folded history rows and pins a request the cut went through', () => {
    const cp = (fold) => ({ role: 'context', policy: 'compact', droppedTurns: 1, createdAt: 1, compaction: { version: 1, foldThroughIndex: fold, summary: 's', state: {}, trigger: 'auto', tokensBefore: 1, tokensAfter: 1 } });
    const history = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second request' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'x' },
      { role: 'assistant', content: 'second answer' },
    ];
    assert.equal(compactionFoldView(history), null);
    // Fold on a turn boundary: nothing is pinned.
    assert.deepEqual(compactionFoldView([...history, cp(1)]), { checkpointIndex: 6, foldThrough: 1, pinnedIndex: -1 });
    // Fold through a round of turn 2: its request stays in context.
    assert.deepEqual(compactionFoldView([...history, cp(4)]), { checkpointIndex: 6, foldThrough: 4, pinnedIndex: 2 });
    // The latest checkpoint wins.
    assert.equal(compactionFoldView([...history, cp(1), cp(4)]).checkpointIndex, 7);
  });
});

describe('policy normalization', () => {
  it('retired policies read as compact', () => {
    for (const legacy of ['summarize', 'dropMiddle', 'archive']) {
      assert.equal(normalizeContextEnforcementPolicy(legacy), 'compact');
    }
    assert.equal(normalizeContextEnforcementPolicy('slide'), 'slide');
    assert.equal(normalizeContextEnforcementPolicy('bogus'), null);
  });

  it('applyContextBudget compacts under the legacy summarize policy (sync server path)', () => {
    const rows = debugSession();
    const out = applyContextBudget(rows, { effectiveLimit: 2500, modelLimit: 4000, policy: 'summarize', reservedTokens: 0 }, { enforcementPolicy: 'summarize' });
    assert.equal(out.applied, true);
    assert.equal(out.policy, 'compact');
    assert.ok(out.tokensAfter <= 2500);
    assert.ok(out.summaryText?.startsWith(COMPACTION_HEADER_PREFIX));
  });
});
