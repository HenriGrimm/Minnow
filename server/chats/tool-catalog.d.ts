export const AGENT_CHAT_TOOL_IDS: readonly string[];
export function projectAgentConversationTools<T extends { function: { name: string; parameters?: any } }>(tools: T[], options?: { creationEnabled?: boolean; includeRecoveryTools?: boolean }): T[];
