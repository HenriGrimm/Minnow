import type { IncomingMessage, ServerResponse } from 'node:http';
export function createChatMiddleware(options: { getRuntime: () => any | Promise<any>; feature?: () => import('./contracts.js').AgentConversationsFeature }): (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>;
