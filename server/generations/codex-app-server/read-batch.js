import { isParallelSafeTool, MAX_PARALLEL_READ_TOOLS } from '../../runner/parallel-tool-policy.js';

export const CODEX_READ_BATCH = 'mn_read_batch';

/** Transport-only fan-out: every member still executes as an ordinary Minnow call. */
export function codexReadBatchTool(tools, choice) {
  if (choice && choice !== 'auto') return null;
  const names = tools.filter(tool => isParallelSafeTool(tool.originalName)).map(tool => tool.originalName);
  if (!names.length) return null;
  return { name: CODEX_READ_BATCH, originalName: '__minnow_read_batch',
    description: 'Batch independent read-only Minnow lookups in one native request. Native dynamic calls are serialized even inside Promise.all; use this tool instead. Each result is returned in input order. Never batch dependent work.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['calls'], properties: {
      calls: { type: 'array', minItems: 1, maxItems: MAX_PARALLEL_READ_TOOLS, items: {
        type: 'object', additionalProperties: false, required: ['name', 'arguments'], properties: {
          name: { type: 'string', enum: names }, arguments: { type: 'object', additionalProperties: true },
        },
      } },
    } } };
}

export function expandCodexReadBatch(args, tools) {
  if (!args || Object.keys(args).some(key => key !== 'calls') || !Array.isArray(args.calls)
    || args.calls.length < 1 || args.calls.length > MAX_PARALLEL_READ_TOOLS) throw new Error('Invalid Codex read batch.');
  const allowed = new Set([...tools.values()].filter(tool => isParallelSafeTool(tool.originalName)).map(tool => tool.originalName));
  return args.calls.map(call => {
    if (!call || Object.keys(call).some(key => !['name', 'arguments'].includes(key)) || !allowed.has(call.name)
      || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new Error('Codex read batch requested an unavailable or non-read-only tool.');
    }
    return { name: call.name, arguments: JSON.stringify(call.arguments) };
  });
}
