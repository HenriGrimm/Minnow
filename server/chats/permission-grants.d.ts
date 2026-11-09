export function getChatPermissionGrants(chatId: string): string[];
export function addChatPermissionGrant(chatId: string, key: string): void;
export function clearChatPermissionGrants(chatId: string): void;
export function resetChatPermissionGrantsForTests(): void;
