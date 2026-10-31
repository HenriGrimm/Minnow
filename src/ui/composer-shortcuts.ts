export function isMacComposerPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
}

export function isComposerQueueShortcut(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) return false;
  return isMacComposerPlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function composerFollowUpPlaceholder(): string {
  const modifier = isMacComposerPlatform() ? '⌘' : 'Ctrl+';
  return `↵ to send, ${modifier}↵ to queue for later`;
}
