import type { IncomingMessage, ServerResponse } from 'node:http';
export function createAgentChatToolsMiddleware(options: { getRuntime(): any | Promise<any>; approvalTimeoutMs?: number }):
  (request: IncomingMessage, response: ServerResponse, next: () => unknown) => Promise<unknown>;
