import type { ToolDefinition } from '../../src/tools/definitions';
export const ACTION_READ_TOOLS: readonly ['action_inspect', 'release_inspect'];
export const ACTION_WRITE_TOOLS: readonly [
  'action_run',
  'action_cancel',
  'action_command',
  'release_manage',
  'release_asset',
];
export const ACTION_TOOLS: ToolDefinition[];
