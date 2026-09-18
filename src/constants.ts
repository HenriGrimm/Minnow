import type { SystemPromptPreset } from './types';
import { SESSION_SCHEMA_VERSION } from './types';
import { MINNOW_GLYPH_EMPTY_HTML } from './ui/minnow-glyph';
import { iconHtml } from './ui/icon';

/** Persisted `SessionState.version` — must match `SESSION_SCHEMA_VERSION` in types. */
export const SESSION_STATE_VERSION = SESSION_SCHEMA_VERSION;

/** Uicons chevrons for sidebar collapse control. */
export const ICON_CHEVRON_LEFT = iconHtml('chevronLeft');
export const ICON_CHEVRON_RIGHT = iconHtml('chevronRight');

/** Uicons magnifier for chat search buttons (sidebar + desktop rail). */
export const ICON_SEARCH = iconHtml('search');

/** Folder icon for the file sidebar Files pane button (MIN-655). */
export const ICON_FILE_TREE = iconHtml('fileTree');

/** Named layout icons (sidebar chevrons). Stats-strip SVGs stay in HTML markup. */
export const icons = {
  chevronLeft: ICON_CHEVRON_LEFT,
  chevronRight: ICON_CHEVRON_RIGHT,
  fileTree: ICON_FILE_TREE,
} as const;

/** Empty chat area placeholder markup. */
export const EMPTY_STATE_HTML =
  `<div class="empty-icon" aria-hidden="true">${MINNOW_GLYPH_EMPTY_HTML}</div>` +
  '<p class="empty-title">No messages yet</p>' +
  '<p class="empty-hint">Pick a model above, then type below. LM Studio must be running at the server URL in Settings.</p>';

/** @deprecated Use config API / ~/.minnow — kept for migration and Vite-only fallback. */
export const STORAGE_KEY = 'minnow-sessions-v1';
export const SAVE_DEBOUNCE_MS = 300;
/** Cap how long a reset-debounce save can be postponed under continuous activity (MIN-584). */
export const SAVE_MAX_WAIT_MS = 2000;
export const PLACEHOLDER_CHAT_NAME = 'New chat';
export const AUTO_TITLE_MAX_LEN = 40;
/** @deprecated Use config API / ~/.minnow — kept for migration and Vite-only fallback. */
export const PRESET_STORAGE_KEY = 'minnow.systemPrompt';
/** Whether the inference metrics strip is visible (`'1'` / `'0'`). */
export const STATS_STRIP_OPEN_KEY = 'minnow.statsStripOpen';
/** Whether the agent activity panel is open (`'1'` / `'0'`). */
export const AGENT_ACTIVITY_OPEN_KEY = 'minnow.agentActivityOpen';

/** @deprecated Import from `src/theme.ts` — re-exported for legacy imports. */
export {
  THEME_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_KEY,
  THEME_FAMILY_KEY,
  type LegacyThemePreference as ThemePreference,
} from './theme';
export const ASSISTANT_RENDER_DEBOUNCE_MS = 100;

/** Built-in system prompt preset for the legacy settings drawer fallback. */
export const SYSTEM_PROMPT_PRESETS: SystemPromptPreset[] = [
  {
    id: 'general-assistant',
    label: 'General assistant',
    text: 'You are a helpful, concise assistant. Respond clearly and directly. Avoid unnecessary preamble.',
  },
];
