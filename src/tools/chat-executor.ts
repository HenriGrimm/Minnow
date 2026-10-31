import type { ExecuteToolContext } from './client';
import type { ToolExecutionResult } from '../types';
import { getChatTurnOwnerId } from '../chat/turn-ownership';

/** Model JSON supplies only tool arguments; the current lease supplies sender identity. */
export async function executeChatTool(name: string, args: Record<string, unknown>, context: ExecuteToolContext): Promise<ToolExecutionResult> {
  const ownerId = context.chatId ? getChatTurnOwnerId(context.chatId) : undefined;
  if (!context.chatId || !ownerId || !context.toolCallId) return { content: 'Error: conversation tools require the active owning chat execution.' };
  const response = await fetch('/api/chats/agent-commands', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceChatId: context.chatId, ownerId, toolCallId: context.toolCallId, name, args }), signal: context.signal });
  const body = await response.json() as { result?: unknown; error?: { code?: string; message?: string } };
  return response.ok ? { content: JSON.stringify(body.result) }
    : { content: `Error: ${body.error?.code ?? 'chat_tool_failed'}: ${body.error?.message ?? 'Conversation operation failed'}` };
}
