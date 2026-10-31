import type { ChatWorkspaceResolver, createChatWorkspaceResolver } from './workspace';
export function installChatWorkspaces(runtime: any, options?: Parameters<typeof createChatWorkspaceResolver>[0]): ChatWorkspaceResolver;
