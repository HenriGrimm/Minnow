/**
 * "Allow for this chat" grants for server-run chats. Grants are deliberately
 * in memory: they live as long as the chat's session on this server and are
 * never written to disk, so a restart asks again (the safe direction).
 */

/** @type {Map<string, Set<string>>} */
const grants = new Map();

/** @param {string} chatId */
export function getChatPermissionGrants(chatId) {
  return [...(grants.get(chatId) ?? [])];
}

/** @param {string} chatId @param {string} key */
export function addChatPermissionGrant(chatId, key) {
  if (!chatId || typeof key !== 'string' || !key) return;
  let set = grants.get(chatId);
  if (!set) grants.set(chatId, (set = new Set()));
  set.add(key);
}

/** @param {string} chatId */
export function clearChatPermissionGrants(chatId) {
  grants.delete(chatId);
}

/** Tests only. */
export function resetChatPermissionGrantsForTests() {
  grants.clear();
}
