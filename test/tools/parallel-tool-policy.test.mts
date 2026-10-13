/**
 * Unit tests for parallel-safe tool classification and batch segmentation.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isParallelSafeTool,
  partitionToolCalls,
} from '../../src/tools/parallel-tool-policy.ts';
import type { ToolCall } from '../../src/types.ts';

function tc(name: string, id = name): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  };
}

describe('isParallelSafeTool', () => {
  test('cacheable read tools are parallel-safe', () => {
    assert.equal(isParallelSafeTool('read_file'), true);
    assert.equal(isParallelSafeTool('grep'), true);
    assert.equal(isParallelSafeTool('git_status'), true);
    assert.equal(isParallelSafeTool('web_search'), true);
  });

  test('code navigation reads are parallel-safe; unknown tools stay sequential', () => {
    for (const name of ['repo_map', 'find_symbol', 'who_calls', 'read_symbol']) {
      assert.equal(isParallelSafeTool(name), true, name);
    }
    assert.equal(isParallelSafeTool('unknown_tool'), false);
  });

  test('extra read utilities are parallel-safe', () => {
    assert.equal(isParallelSafeTool('get_datetime'), true);
    assert.equal(isParallelSafeTool('calculate'), true);
    assert.equal(isParallelSafeTool('wikipedia_search'), true);
    assert.equal(isParallelSafeTool('list_sub_agents'), true);
    assert.equal(isParallelSafeTool('get_sub_agent_status'), true);
  });

  test('mutating and interactive tools are sequential', () => {
    assert.equal(isParallelSafeTool('save_file'), false);
    assert.equal(isParallelSafeTool('git_commit'), false);
    assert.equal(isParallelSafeTool('execute_command'), false);
    assert.equal(isParallelSafeTool('ask_question'), false);
    assert.equal(isParallelSafeTool('spawn_sub_agent'), false);
    assert.equal(isParallelSafeTool('issue_update'), false);
  });

  test('clipboard and unknown-prefix tools are sequential', () => {
    assert.equal(isParallelSafeTool('read_clipboard'), false);
    assert.equal(isParallelSafeTool('write_clipboard'), false);
    assert.equal(isParallelSafeTool('browser_navigate'), false);
    assert.equal(isParallelSafeTool('mcp__foo'), false);
    assert.equal(isParallelSafeTool('plugin__bar'), false);
  });

  test('brain mutators and destructive tools are sequential', () => {
    assert.equal(isParallelSafeTool('brain_write_page'), false);
    assert.equal(isParallelSafeTool('manage_brain'), false);
  });
});

describe('partitionToolCalls', () => {
  test('all parallel-safe calls form one parallel segment', () => {
    const calls = [tc('grep', 'a'), tc('read_file', 'b')];
    const segments = partitionToolCalls(calls);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.kind, 'parallel');
    assert.deepEqual(
      segments[0]!.calls.map((c) => c.id),
      ['a', 'b'],
    );
  });

  test('code navigation reads share a segment and respect write barriers', () => {
    const reads = ['repo_map', 'find_symbol', 'who_calls', 'read_symbol'].map((name) => tc(name));
    assert.deepEqual(partitionToolCalls(reads), [{ kind: 'parallel', calls: reads }]);
    const write = tc('apply_patch');
    const after = tc('read_symbol', 'after');
    assert.deepEqual(partitionToolCalls([...reads, write, after]), [
      { kind: 'parallel', calls: reads },
      { kind: 'sequential', calls: [write] },
      { kind: 'parallel', calls: [after] },
    ]);
  });

  test('mutator splits parallel runs and preserves order', () => {
    const calls = [
      tc('grep', 'a'),
      tc('read_file', 'b'),
      tc('save_file', 'c'),
      tc('git_status', 'd'),
    ];
    const segments = partitionToolCalls(calls);
    assert.equal(segments.length, 3);
    assert.equal(segments[0]!.kind, 'parallel');
    assert.deepEqual(
      segments[0]!.calls.map((c) => c.id),
      ['a', 'b'],
    );
    assert.equal(segments[1]!.kind, 'sequential');
    assert.equal(segments[1]!.calls[0]!.id, 'c');
    assert.equal(segments[2]!.kind, 'parallel');
    assert.equal(segments[2]!.calls[0]!.id, 'd');
  });

  test('single tool yields one segment', () => {
    const segments = partitionToolCalls([tc('save_file')]);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.kind, 'sequential');
  });

  test('empty input yields no segments', () => {
    assert.deepEqual(partitionToolCalls([]), []);
  });
});
