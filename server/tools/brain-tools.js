import { clearCodeIndex } from '../brain/code/schema.js';

export async function toolManageBrain(args) {
  const action = String(args?.action ?? '').trim();
  if (!action) {
    return 'Error: action is required.';
  }

  const confirmed =
    args?.confirmed === true ||
    args?.confirm === true ||
    args?.confirmed === 'true' ||
    args?.confirm === 'true';
  if (action === 'clear_code_index' && !confirmed) {
    return 'Deletion requires confirmation. Re-run with confirmed: true after user approval.';
  }

  if (action === 'clear_code_index') {
    const result = clearCodeIndex({
      all: args?.all === true,
      workspaceKey:
        args?.workspaceKey !== undefined ? String(args.workspaceKey) : undefined,
    });
    const keys = result.workspaceKeys.length
      ? result.workspaceKeys.join(', ')
      : 'none';
    return `Reset code index for ${result.removed} workspace(s): ${keys}.`;
  }

  return `Error: unknown action "${action}".`;
}
