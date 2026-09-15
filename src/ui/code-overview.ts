/** Compatibility entry points for the overview moved to the Home app. */
import { launchApp } from '../os/router';

export function isCodeOverviewOpen(): boolean { return false; }
export function dismissCodeOverviewForNavigation(): boolean { return false; }
export async function openCodeOverview(): Promise<void> { launchApp('home'); }
export function closeCodeOverview(_options?: { skipNavigate?: boolean; restoreChat?: boolean }): void {}
export function initCodeOverview(): void {}
