let cleanup: (() => void) | undefined;
export function setShortcutSettingsCleanup(next: () => void): void { cleanup = next; }
export function disposeShortcutSettings(): void { cleanup?.(); cleanup = undefined; }
