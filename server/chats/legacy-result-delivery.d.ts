import type { ChatRepository } from './repository.js';
import type { ChatContext } from './context.js';
import type { ChatCommandService } from './service.js';
import type { DeliveryJournal, DeliveryMeta, CanonicalDeliveryAcceptance } from '../sub-agents/delivery.js';
export function createLegacyResultDelivery(options: {
  repository: ChatRepository; context: Pick<ChatContext, 'resolveTarget'>; service: Pick<ChatCommandService, 'admitLegacyCompletion'>;
  journal?: DeliveryJournal; isReady?: () => boolean; isBusy?: (chatId: string) => boolean; onChange?: (chatId: string) => void;
}): { deliver(parentChatId: string, meta: DeliveryMeta): Promise<CanonicalDeliveryAcceptance | null>; dispose(): Promise<void> };
