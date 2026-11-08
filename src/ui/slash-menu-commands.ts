/**
 * App commands for the `/` menu: Review, Model, Permissions, Reasoning and MCP.
 * They open in-place submenus (or the existing pickers) and show the current
 * value on the right, so the menu doubles as a status panel.
 */

import { PERMISSION_LEVELS, PERMISSION_LEVEL_META, type PermissionLevel } from '../lib/permissions.mjs';
import { getPermissionLevelCached } from '../config/tool-security-meta';
import { registerCoreSlashCommand, type SlashSubmenuItem } from '../chat/slash-commands/registry';
import { getActiveChat } from '../state/sessions';
import { choosePermissionLevel, PERMISSION_LEVEL_ICON } from './permission-level';
import { getComposerReasoningState, setComposerReasoningChoice } from './composer-reasoning-effort';
import { openActiveChatModelSelect } from './composer-model-trigger';

let registered = false;

/** Short model label for the value column (last path segment, no quant suffix). */
export function shortModelLabel(modelId: string | undefined | null): string {
  const id = modelId?.trim() ?? '';
  if (!id) return 'None';
  const tail = id.split('/').pop() ?? id;
  return tail.length > 28 ? `${tail.slice(0, 27)}…` : tail;
}

export function permissionSubmenu(current: PermissionLevel = getPermissionLevelCached()): SlashSubmenuItem[] {
  return PERMISSION_LEVELS.map((level) => ({
    id: level,
    label: PERMISSION_LEVEL_META[level].label,
    description: PERMISSION_LEVEL_META[level].description,
    icon: PERMISSION_LEVEL_ICON[level],
    selected: level === current,
    run: () => { void choosePermissionLevel(level); },
  }));
}

function reasoningSubmenu(): SlashSubmenuItem[] {
  const state = getComposerReasoningState();
  return state.choices.map((choice) => ({
    id: choice.value,
    label: choice.label,
    selected: choice.value === state.selected,
    disabled: state.disabled,
    run: () => setComposerReasoningChoice(choice.value),
  }));
}

const REVIEW_TARGETS: SlashSubmenuItem[] = [
  {
    id: 'uncommitted',
    label: 'Uncommitted changes',
    description: 'Staged and unstaged edits in the working tree',
    insertion: '/code-review review my uncommitted changes',
  },
  {
    id: 'branch',
    label: 'This branch',
    description: 'Every commit on this branch compared with main',
    insertion: '/code-review review this branch against main',
  },
  {
    id: 'commit',
    label: 'Last commit',
    description: 'Only the most recent commit',
    insertion: '/code-review review the last commit',
  },
];

/** Register once at boot (idempotent). */
export function registerSlashMenuCommands(): void {
  if (registered) return;
  registered = true;

  registerCoreSlashCommand({
    id: 'review',
    label: 'Review',
    description: 'Review uncommitted changes, this branch or the last commit',
    insertion: '',
    icon: 'slashReview',
    order: 4,
    submenu: () => REVIEW_TARGETS,
  });
  registerCoreSlashCommand({
    id: 'model',
    label: 'Model',
    description: 'Switch the model for this chat',
    insertion: '',
    icon: 'appModels',
    order: 20,
    value: () => shortModelLabel(getActiveChat()?.modelId),
    run: () => { openActiveChatModelSelect(); },
  });
  registerCoreSlashCommand({
    id: 'permissions',
    label: 'Permissions',
    description: 'What the agent may do without asking (everywhere)',
    insertion: '',
    icon: 'permAuto',
    order: 21,
    value: () => PERMISSION_LEVEL_META[getPermissionLevelCached()].label,
    submenu: () => permissionSubmenu(),
  });
  registerCoreSlashCommand({
    id: 'reasoning',
    label: 'Reasoning',
    description: 'How hard the model thinks before answering',
    insertion: '',
    icon: 'reasoning',
    order: 22,
    value: () => getComposerReasoningState().label || 'Not supported',
    submenu: () => reasoningSubmenu(),
  });
  registerCoreSlashCommand({
    id: 'mcp',
    label: 'MCP',
    description: 'Connected MCP servers and their status',
    insertion: '',
    icon: 'slashMcp',
    order: 23,
    run: () => {
      void import('./settings-page').then((m) => m.openSettings('mcp'));
    },
  });
}
