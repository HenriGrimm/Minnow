import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';
import { getProjectRoot } from './server-import.js';

const scrollbarCss = readFileSync(path.join(getProjectRoot(), 'src/styles/scrollbars.css'), 'utf8');

/** Update a guest's scrollbar sheet on navigation and when its owning window changes accent. */
export function wirePreviewScrollbars(guest: WebContents, getAccent: () => string): () => Promise<void> {
  let documentVersion = 0;
  let cssKey: string | undefined;
  let appliedAccent: string | undefined;
  let pending = Promise.resolve();

  const sync = (): Promise<void> => {
    const version = documentVersion;
    pending = pending.then(async () => {
      if (!version || version !== documentVersion || guest.isDestroyed()) return;
      const accent = getAccent();
      if (accent === appliedAccent) return;
      const accentCss = accent
        ? `@layer minnow-scrollbars { :root { --mn-scrollbar-thumb-active: ${accent}; } }`
        : '';
      const key = await guest.insertCSS(scrollbarCss + accentCss);
      if (version !== documentVersion || guest.isDestroyed()) return;
      const previousKey = cssKey;
      cssKey = key;
      appliedAccent = accent;
      if (previousKey) await guest.removeInsertedCSS(previousKey);
    }).catch(() => {
      // Navigation or a disappearing guest can invalidate the insertion.
    });
    return pending;
  };

  guest.on('dom-ready', () => {
    documentVersion++;
    cssKey = undefined;
    appliedAccent = undefined;
    void sync();
  });

  return sync;
}
