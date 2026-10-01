import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';

/** CSS select pickers live in the renderer's top layer, below Electron's native
 * preview guest. Reuse the chrome-popover guard while a styled picker is open.
 * Delegation covers selects created by lazy apps without per-control wiring. */
export function installNativeSelectPreviewGuard(): () => void {
  if (!window.minnow?.preview || !CSS.supports('appearance', 'base-select')) return () => {};

  let registered = false;
  let frame = 0;
  const observer = new MutationObserver(() => schedule());
  const sync = (): void => {
    frame = 0;
    const open = [...document.querySelectorAll<HTMLSelectElement>('select:open')]
      .some((select) => getComputedStyle(select).appearance === 'base-select');
    if (open === registered) return;
    registered = open;
    if (open) {
      registerChromePopover();
      // Removing or hiding a control can close its picker without a focus event.
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    } else {
      observer.disconnect();
      unregisterChromePopover();
    }
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(sync);
  };

  // Focus moves into the options on opening and back to the select on close.
  // Pointer/key events also cover dismissal without a focus change.
  const events = ['focusin', 'focusout', 'pointerdown', 'keydown', 'change'] as const;
  for (const event of events) document.addEventListener(event, schedule, true);

  return () => {
    for (const event of events) document.removeEventListener(event, schedule, true);
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    if (registered) unregisterChromePopover();
  };
}
