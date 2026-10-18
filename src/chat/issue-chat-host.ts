const hosts = new Map<string, Set<HTMLElement>>();
const pending = new Set<string>();
const listeners = new Set<() => void>();

export function registerIssueChatHost(chatId: string, host: HTMLElement): () => void {
  const entries = hosts.get(chatId) ?? new Set<HTMLElement>();
  entries.add(host);
  hosts.set(chatId, entries);
  return () => { entries.delete(host); if (!entries.size) hosts.delete(chatId); };
}

export function resolveIssueChatQuestionHost(chatId: string): HTMLElement | null {
  for (const host of hosts.get(chatId) ?? []) {
    if (!host.isConnected) continue;
    let visible = true;
    // The question modal hides its empty host after answering; the enclosing tab
    // determines whether another question can mount here.
    for (let node: HTMLElement | null = host.parentElement; node; node = node.parentElement) {
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (node.hidden || node.inert || style?.display === 'none' || style?.visibility === 'hidden') { visible = false; break; }
    }
    if (visible) return host;
  }
  return null;
}

export function setIssueChatQuestionPending(chatId: string, value: boolean): void {
  if (value) pending.add(chatId); else pending.delete(chatId);
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.error('[issue-chat-host] subscriber failed', error); }
  }
}
export const isIssueChatQuestionPending = (chatId: string): boolean => pending.has(chatId);
export function subscribeIssueChatQuestions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
