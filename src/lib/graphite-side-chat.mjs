export const GRAPHITE_SIDE_CHAT_ROLE = 'graphite-side-chat';

export function graphiteSideChatKey(parentChatId) {
  return `${GRAPHITE_SIDE_CHAT_ROLE}:${parentChatId}`;
}

export function isGraphiteSideChat(chat) {
  return chat?.background === true && chat.backgroundKey?.startsWith(`${GRAPHITE_SIDE_CHAT_ROLE}:`) === true;
}
