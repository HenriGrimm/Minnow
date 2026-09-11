/**
 * Residual `window` augmentations (dev tooling only).
 * MIN-387 retires UI globals that backed inline index.html handlers.
 */
export {};

import type { ThemeId } from './theme';
import type { MinnowElectronBridge } from './electron';
import type { AppearanceFonts } from './appearance/types';

declare global {
  /** Electron preload bridge (`globalThis.minnow` / `window.minnow`). */
  var minnow: MinnowElectronBridge | undefined;

  interface Window {
    /** Dev-only: `initTheme` assigns `applyTheme` when `import.meta.env.DEV`. */
    __setTheme?: (id: ThemeId) => void;
    /** Injected by spa-auth-html from ~/.minnow/appearance.json before FOUC. */
    __MINNOW_APPEARANCE_BOOT__?: {
      chatView?: 'compact' | 'full';
      followSystem?: boolean;
      family?: string;
      themeId?: string;
      customEnabled?: boolean;
      customAdvanced?: boolean;
      customTokens?: Record<string, string>;
      fonts?: AppearanceFonts;
    };
  }
}
