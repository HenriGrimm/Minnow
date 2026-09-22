import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ingestRows, formatCompactionSummary, cloneCompactionState } from '../../server/runner/compaction/index.js';
import { elideToolRow } from '../../server/runner/compaction/elide.js';

const read = [
  { id: 1, row: { role: 'assistant', content: 'Hypothesis: drive overwrites pushback\nAcceptance check: a collision carries the opponent past the edge', tool_calls: [{ id: 'r', function: { name: 'read_file', arguments: '{"path":"robot.ts"}' } }] } },
  { id: 2, row: { role: 'tool', tool_call_id: 'r', content: '40: export function drive() {\n41: const impulse = 3;\n42: }' } },
];

test('findings and source references survive multiple folds without mutating previous state', () => {
  const first = ingestRows(null, read);
  const second = ingestRows(first, [{ id: 3, row: { role: 'assistant', content: 'Check result: build passes; edge behavior still unverified' } }]);
  assert.equal(first.findings.length, 2);
  assert.equal(second.findings.length, 3);
  const summary = formatCompactionSummary(second, { budgetTokens: 6000 });
  assert.match(summary, /robot.ts #2: lines 40–42/);
  assert.match(summary, /Hypothesis: drive overwrites/);
  assert.match(summary, /still unverified/);
  assert.deepEqual(cloneCompactionState({ version: 1 }).findings, []);
  const changed = ingestRows(second, [
    { id: 4, row: { role: 'assistant', tool_calls: [{ id: 'w', function: { name: 'replace_text_in_file', arguments: '{"path":"robot.ts"}' } }] } },
    { id: 5, row: { role: 'tool', tool_call_id: 'w', content: 'Done' } },
  ]);
  assert.deepEqual(changed.files[0].observations, []);
  assert.equal(second.files[0].observations.length, 1);
});

test('elision retains bounded source clues and recall coordinates', () => {
  const row = { role: 'tool', content: read[1].row.content + '\n43: ' + 'x'.repeat(8000) };
  const stub = elideToolRow(row, { rowId: 2, toolName: 'read_file' });
  assert.match(stub.content, /export function drive/);
  assert.match(stub.content, /rows "2"/);
  assert.ok(stub.content.length < 700);
});

test('working findings stay bounded and both chat/board profiles require outcome checks', () => {
  const state = ingestRows(null, Array.from({ length: 40 }, (_, id) => ({ id, row: { role: 'assistant', content: `Finding: observation ${id}` } })));
  assert.equal(state.findings.length, 12);
  for (const file of ['src/chat/prompts/tool-usage/default.full.md', 'src/chat/prompts/tool-usage/default.lite.md', 'server/orchestrator/prompts/builder/agent.full.md', 'server/orchestrator/prompts/builder/agent.lite.md']) {
    const prompt = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    for (const phrase of ['Hypothesis:', 'Acceptance check:', 'recall_history', 'observable pass condition', 'Honor required tests']) assert.ok(prompt.includes(phrase), file + ': ' + phrase);
  }
});
