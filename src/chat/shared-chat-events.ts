import type { TurnEvent } from '../../server/runner/run-turn';

let listener: ((chatId: string, event?: TurnEvent, running?: boolean) => Promise<void>) | undefined;

export function setSharedChatPublisher(publish: typeof listener): void { listener = publish; }

export function notifySharedChatEvent(chatId: string, event?: TurnEvent): void {
  void listener?.(chatId, event).catch(() => {});
}

export async function flushSharedChat(chatId: string, running: boolean): Promise<void> {
  await listener?.(chatId, undefined, running).catch(() => {});
}
