/** The foreground issue surface borrows the one fully wired Code composer. */
interface SharedChatHost { chatId: string; transcript: HTMLElement; shell: HTMLElement; openPlan?: (path: string) => void }
let current: SharedChatHost | null = null;
export function getSharedChatHost(chatId?: string): SharedChatHost | null {
  return current && (chatId === undefined || current.chatId === chatId) ? current : null;
}
export function setSharedChatHost(host: SharedChatHost | null): void { current = host; }
