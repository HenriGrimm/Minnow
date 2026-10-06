let chatId: string | null = null;

export function setCodeMapChatId(id: string | null): void {
  chatId = id;
}

export function queryCodeMapChatHost(id?: string): HTMLElement | null {
  if (!chatId || (id !== undefined && id !== chatId)) return null;
  return document.getElementById('codeMapChatTranscript');
}

export function isCodeMapChatOpenForChat(id: string): boolean {
  return queryCodeMapChatHost(id) !== null;
}
