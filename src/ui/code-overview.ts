/** Compatibility entry points for the retired overview. */
import { navigateToCodeChat } from '../os/router';

export function isCodeOverviewOpen(): boolean { return false; }
export function dismissCodeOverviewForNavigation(): boolean { return false; }
export async function openCodeOverview(): Promise<void> { navigateToCodeChat(); }
export function closeCodeOverview(_options?: { skipNavigate?: boolean; restoreChat?: boolean }): void {}
export function initCodeOverview(): void {}
