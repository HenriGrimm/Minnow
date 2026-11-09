import { getPermissionLevelFromConfig } from '../config/tool-security.js';
import { getChatPermissionGrants } from '../chats/permission-grants.js';
import { getMcpToolHint } from '../mcp/registry.js';
import { classifyToolCall, decidePermission, minPermissionLevel } from '../../src/lib/permissions.mjs';

/** Capture an agent attempt's global ceiling without widening its caller. */
export async function captureAgentPermissionLevel(ceiling = 'full') {
  return minPermissionLevel(ceiling, await getPermissionLevelFromConfig());
}

/** Node adapter for the same classifier and decision table used by chat and CLI. */
export async function checkAgentToolPermission(name, args, { workspaceRoot, permissionLevel, chatId, clamp }) {
  const level = await captureAgentPermissionLevel(permissionLevel);
  const action = classifyToolCall(name, args, {
    workspaceRoots: [workspaceRoot], toolHint: getMcpToolHint(name),
  });
  const verdict = decidePermission(level, action, {
    grants: chatId ? getChatPermissionGrants(chatId) : [], clamp,
  });
  return { level, action, verdict };
}
