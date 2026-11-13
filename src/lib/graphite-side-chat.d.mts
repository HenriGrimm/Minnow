export const GRAPHITE_SIDE_CHAT_ROLE: 'graphite-side-chat';
export function graphiteSideChatKey(parentChatId: string): string;
export function isGraphiteSideChat(chat: { background?: boolean; backgroundKey?: string } | null | undefined): boolean;
