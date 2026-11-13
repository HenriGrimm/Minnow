/**
 * Default persisted payloads when home dir or localStorage is empty.
 */

import { randomUUID } from '../lib/random-id.ts';
import type { ToolConfig } from '../tools/tool-settings-types';
import type { SessionState } from '../types';
import { defaultSkillConfig as buildDefaultSkillConfig } from '../skills/config';
import { DEFAULT_MAX_OUTPUT_CHARS } from '../../server/tools/output-cap.js';
import type { SkillConfig } from '../skills/config';
import type { UserRulesSettings } from './user-rules';

/** Default skill toggles (all enabled). */
export function defaultSkillConfig(): SkillConfig {
  return buildDefaultSkillConfig();
}

/** Default operational settings for tools.json. */
export function defaultToolConfig(): ToolConfig {
  return {
    keys: { braveApiKey: '', tavilyApiKey: '' },
    webSearchProvider: 'tavily',
    toolCache: { enabled: true },
    lazyTools: true,
    toolOutput: { enabled: true, maxChars: DEFAULT_MAX_OUTPUT_CHARS },
  };
}

/** Default ~/.minnow/rules.json contents. */
export function defaultUserRulesSettings(): UserRulesSettings {
  return {
    version: 2,
    enabled: false,
    groups: [{ id: 'general', name: 'General' }],
    rules: [],
  };
}

/** One empty chat session blob. */
export function defaultSessionState(): SessionState {
  const chatId = randomUUID();

  return {
    version: 6,
    groups: [],
    activeId: chatId,
    sidebarCollapsed: false,
    lastActiveChatIdByWorkspace: {},
    lastActiveChatIdByApp: {},
    chats: [
      {
        id: chatId,
        name: 'New chat',
        workspacePath: '',
        modelId: '',
        history: [],
        lastStats: null,
        modelInfo: {},
        updatedAt: Date.now(),
        lastMessageAt: Date.now(),
      },
    ],
  };
}
