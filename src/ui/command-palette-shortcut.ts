let keyboardBound = false;
let paletteModule: Promise<typeof import('./command-palette')> | null = null;

function isPaletteChord(event: KeyboardEvent): boolean {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) return false;
  if (event.key === 'k' || event.key === 'K') return !event.shiftKey;
  return event.shiftKey && (event.key === 'p' || event.key === 'P');
}

/** Keep palette code and CSS out of boot until its shortcut is used. */
export function initLazyCommandPaletteShortcut(): void {
  if (keyboardBound) return;
  keyboardBound = true;
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || !isPaletteChord(event)) return;
    event.preventDefault();
    paletteModule ??= import('./command-palette');
    void paletteModule.then((palette) => {
      if (palette.isCommandPaletteOpen()) palette.closeCommandPalette();
      else palette.openCommandPalette();
    });
  });
}

export function resetLazyCommandPaletteShortcutForTests(): void {
  keyboardBound = false;
  paletteModule = null;
}
