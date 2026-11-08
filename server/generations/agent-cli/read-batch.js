import { isParallelSafeTool, MAX_PARALLEL_READ_TOOLS } from '../../runner/parallel-tool-policy.js';

export const CLI_READ_BATCH = 'mn_read_batch';
export const CLI_TOOL_TRANSPORT_VERSION = 2;

/** Transport-only fan-out: every member still executes as an ordinary Minnow call. */
export function cliReadBatchTool(tools, choice) {
  if (choice && choice !== 'auto') return null;
  const reads = tools.filter(tool => isParallelSafeTool(tool.originalName));
  if (!reads.length || tools.some(tool => tool.name === CLI_READ_BATCH)) return null;
  return { name: CLI_READ_BATCH, originalName: '__minnow_read_batch',
    description: 'Use this tool for independent read-only Minnow lookups together in one request, before waiting for results. Separate native tool calls can be serialized even inside Promise.all. Results retain input order. Never batch dependent work. Available lookups and their arguments are specified below.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['calls'], properties: {
      calls: { type: 'array', minItems: 1, maxItems: MAX_PARALLEL_READ_TOOLS, items: {
        type: 'object', additionalProperties: false, required: ['name', 'arguments'], properties: {
          name: { type: 'string', enum: reads.map(tool => tool.originalName) }, arguments: { type: 'object', additionalProperties: true },
        },
        anyOf: reads.map((tool, index) => ({ properties: {
          name: { const: tool.originalName, description: tool.description },
          arguments: nestSchema(tool.inputSchema ?? { type: 'object' }, `#/properties/calls/items/anyOf/${index}/properties/arguments`),
        } })),
      } },
    } } };
}

// Keep local references pointing into the member's schema after embedding it.
function nestSchema(value, prefix) {
  if (Array.isArray(value)) return value.map(item => nestSchema(item, prefix));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === '$ref' && typeof item === 'string' && (item === '#' || item.startsWith('#/'))
      ? prefix + item.slice(1) : nestSchema(item, prefix)]));
}

export function expandCliReadBatch(args, tools) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'calls') || !Array.isArray(args.calls)
    || args.calls.length < 1 || args.calls.length > MAX_PARALLEL_READ_TOOLS) throw new Error('Invalid CLI read batch.');
  const allowed = new Set([...tools.values()].filter(tool => isParallelSafeTool(tool.originalName)).map(tool => tool.originalName));
  return args.calls.map(call => {
    if (!call || Object.keys(call).some(key => !['name', 'arguments'].includes(key)) || !allowed.has(call.name)
      || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new Error('CLI read batch requested an unavailable or non-read-only tool.');
    }
    return { name: call.name, arguments: JSON.stringify(call.arguments) };
  });
}
