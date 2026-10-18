import { getForegroundAppId } from '../os/instances';
let mounted: { chatId: string; host: HTMLElement } | null = null;
export function setHomeQuestionHost(chatId: string, host: HTMLElement): void { mounted = { chatId, host }; }
export function clearHomeQuestionHost(): void { mounted = null; }
export function resolveHomeQuestionHost(chatId: string): HTMLElement | null {
  return getForegroundAppId() === 'home' && mounted?.chatId === chatId && mounted.host.isConnected ? mounted.host : null;
}
