import type { DeliveryHandle, ParentStatus, DeliveryMeta, CanonicalDeliveryAcceptance } from './delivery';

export function getProductionDelivery(): DeliveryHandle;
export function bootAgentsRuntime(): Promise<void>;
export function resetProductionDelivery(): void;
export function setProductionCanonicalDelivery(fn: (parentChatId: string, meta: DeliveryMeta) => Promise<CanonicalDeliveryAcceptance | null>): () => void;
export function setProductionParentStatus(
  fn: ((parentChatId: string) => ParentStatus) | null,
): void;
