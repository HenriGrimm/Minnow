import { getForegroundAppId } from '../os/instances';
let mounted: { chatId: string; host: HTMLElement } | null = null;
export function setHomeQuestionHost(chatId: string, host: HTMLElement): void { mounted = { chatId, host }; }
export function clearHomeQuestionHost(): void { mounted = null; }
export function resolveHomeQuestionHost(chatId: string): HTMLElement | null {
  if (getForegroundAppId() !== 'home' || mounted?.chatId !== chatId || !mounted.host.isConnected || mounted.host.parentElement?.closest('[hidden]')) return null;
  const conversation = mounted.host.closest('.home-conversation');
  return conversation && getComputedStyle(conversation).display === 'none' ? null : mounted.host;
}
