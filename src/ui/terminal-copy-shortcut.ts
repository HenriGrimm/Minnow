import { createTextarea } from './components';
type TerminalShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export function isTerminalCopyShortcut(event: TerminalShortcutEvent): boolean {
  const key = event.key.toLowerCase();
  if (key !== 'c') return false;
  if (event.shiftKey || event.altKey) return false;
  return (event.ctrlKey && !event.metaKey) || (event.metaKey && !event.ctrlKey);
}

/**
 * Ctrl+V (Windows/Linux). xterm maps this chord to SYN (`^V`) and cancel()s the
 * browser paste, so the PTY would print a literal caret-V without this intercept.
 * Cmd+V on macOS is left alone — xterm does not emit a control char, and the
 * native paste event already inserts clipboard text.
 */
export function isTerminalPasteShortcut(event: TerminalShortcutEvent): boolean {
  const key = event.key.toLowerCase();
  if (key !== 'v') return false;
  if (event.shiftKey || event.altKey || event.metaKey) return false;
  return event.ctrlKey;
}

/** Whether xterm should handle copy instead of sending Ctrl/Cmd+C to the PTY. */
export function shouldCopyTerminalSelectionOnKeydown(
  event: { type: string } & TerminalShortcutEvent,
  hasSelection: boolean,
): boolean {
  if (event.type !== 'keydown') return false;
  if (!hasSelection) return false;
  return isTerminalCopyShortcut(event);
}

/** Whether to read the clipboard and paste instead of sending Ctrl+V to the PTY. */
export function shouldPasteTerminalOnKeydown(
  event: { type: string } & TerminalShortcutEvent,
): boolean {
  if (event.type !== 'keydown') return false;
  return isTerminalPasteShortcut(event);
}

/** Write plain text to the clipboard when available. */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = createTextarea({ appearance: 'surface' });
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

/** Read plain text from the clipboard; empty string when unavailable or denied. */
export async function readTextFromClipboard(): Promise<string> {
  if (!navigator.clipboard?.readText) return '';
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}
