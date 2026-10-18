/**
 * Global quick-capture chord.
 *
 * The menubar capture button was removed (MIN-546). Capture remains reachable
 * from anywhere with Ctrl/Cmd + I, from the command palette ("New issue from
 * here"), and by dropping onto the Issues rail tile.
 */

import { openQuickCapture } from '../ui/issue-capture';
import { isTypingTarget } from '../ui/a11y/typing-target';

/** Ctrl/Cmd + I opens capture from anywhere; `C` alone files inside Issues. */
function isQuickCaptureChord(event: KeyboardEvent): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.code === 'KeyI' || event.key.toLowerCase() === 'i';
}

/**
 * Register the global chord. Returns cleanup for shell teardown.
 */
export function initQuickCaptureChord(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (!isQuickCaptureChord(event)) return;
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    openQuickCapture();
  };
  document.addEventListener('keydown', onKeyDown);

  return () => document.removeEventListener('keydown', onKeyDown);
}
