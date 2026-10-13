import { USER_INPUT_BLOCKING_TOOLS } from '../chat/incomplete-tool-batch.ts';
import { TOOL_GROUP_IDS } from '../chat/modes/tool-groups.ts';
import {
  BRAIN_DESTRUCTIVE_TOOL_ID_SET,
  BRAIN_WIKI_TOOL_IDS,
} from './brain-tool-ids.ts';
import { getCachePolicyForTool } from './tool-cache-policy.ts';
import type { ToolCall } from '../types.ts';

/** Max concurrent read-only tool executions per parallel segment. */
export const MAX_PARALLEL_READ_TOOLS = 6;

/** Extra read utilities not yet marked cacheable in result-cache. */
const PARALLEL_EXTRA_WHITELIST = new Set([
  'get_datetime',
  'calculate',
  'get_system_info',
  'wikipedia_search',
  'list_sub_agents',
  'get_sub_agent_status',
  // Code navigation reads are parallel-safe without opting into result caching.
  'repo_map',
  'find_symbol',
  'who_calls',
  'read_symbol',
]);

/** Brain wiki tools that mutate persisted state (always sequential). */
const BRAIN_MUTATOR_TOOL_IDS = new Set(
  BRAIN_WIKI_TOOL_IDS.filter(
    (id) =>
      id === 'brain_write_page' ||
      id === 'brain_append_log' ||
      id === 'brain_ingest_source' ||
      id === 'save_memory',
  ),
);

/** Tool groups whose members always run sequentially (spawn/cancel handled separately). */
const SEQUENTIAL_TOOL_GROUP_IDS = [
  'files-write',
  'git-write',
  'code-exec',
  'browser',
  'issues',
  'mode-mgmt',
] as const;

function buildSequentialDenySet(): Set<string> {
  const deny = new Set<string>(USER_INPUT_BLOCKING_TOOLS);
  deny.add('read_clipboard');
  deny.add('write_clipboard');
  deny.add('spawn_sub_agent');
  deny.add('cancel_sub_agent');

  for (const groupId of SEQUENTIAL_TOOL_GROUP_IDS) {
    for (const toolId of TOOL_GROUP_IDS[groupId]) {
      deny.add(toolId);
    }
  }

  for (const id of BRAIN_MUTATOR_TOOL_IDS) {
    deny.add(id);
  }
  for (const id of BRAIN_DESTRUCTIVE_TOOL_ID_SET) {
    deny.add(id);
  }

  return deny;
}

const SEQUENTIAL_DENY = buildSequentialDenySet();

/** True when a tool may run concurrently with other parallel-safe tools in the same turn. */
export function isParallelSafeTool(name: string): boolean {
  if (
    name.startsWith('browser_') ||
    name.startsWith('mcp__') ||
    name.startsWith('plugin__')
  ) {
    return false;
  }

  if (SEQUENTIAL_DENY.has(name)) {
    return false;
  }

  if (PARALLEL_EXTRA_WHITELIST.has(name)) {
    return true;
  }

  return getCachePolicyForTool(name).cacheable;
}

export type ToolCallSegment =
  | { kind: 'parallel'; calls: ToolCall[] }
  | { kind: 'sequential'; calls: ToolCall[] };

export function partitionToolCalls(toolCalls: ToolCall[]): ToolCallSegment[] {
  if (toolCalls.length === 0) {
    return [];
  }

  const segments: ToolCallSegment[] = [];
  let parallelBuffer: ToolCall[] = [];

  function flushParallel(): void {
    if (parallelBuffer.length === 0) {
      return;
    }
    segments.push({ kind: 'parallel', calls: parallelBuffer });
    parallelBuffer = [];
  }

  for (const tc of toolCalls) {
    if (isParallelSafeTool(tc.function.name)) {
      parallelBuffer.push(tc);
      continue;
    }
    flushParallel();
    segments.push({ kind: 'sequential', calls: [tc] });
  }

  flushParallel();
  return segments;
}

/** Activity label for parallel read segments in the main chat turn strip. */
export function parallelToolsActivityLabel(count: number): string {
  if (count <= 1) {
    return '';
  }
  return `Running ${count} read tools…`;
}
