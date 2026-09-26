/**
 * Client bridge for outgoing webhook event notifications.
 */

/**
 * Notify the server that a new chat session was created (fire-and-forget).
 */
export function notifySessionCreated(chatId: string): void {
  if (!chatId.trim()) return;
  void fetch('/api/webhooks/events/session-created', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId }),
  }).catch(() => {
  });
}
