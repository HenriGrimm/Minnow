import {
  getAllowUnsandboxedShellFromConfig,
  getShellSandboxFromConfig,
} from '../../config/tool-security.js';
import {
  resolveChatWorktreeContext,
  useJsonSessionsStore,
} from '../../config/sessions-repo.js';
import { readConfigJson } from '../../config/store.js';
import { validateSessionState } from '../../config/validators.js';
import { resolveEffectiveShellSandboxMode } from './mode.js';
import { pathAccessStore } from '../../runtime/path-access.js';

/**
 * @param {string} chatId
 * @returns {Promise<{ onBoard: boolean, boardMode: string | undefined, groupId?: string }>}
 */
async function resolveBoardSandboxContext(chatId) {
  const trimmedId = typeof chatId === 'string' ? chatId.trim() : '';
  if (!trimmedId) return { onBoard: false, boardMode: undefined };

  try {
    if (!useJsonSessionsStore()) {
      const ctx = await resolveChatWorktreeContext(trimmedId);
      if (!ctx.groupId) return { onBoard: false, boardMode: undefined };
      return { onBoard: true, boardMode: undefined, groupId: ctx.groupId };
    }

    const raw = (await readConfigJson('sessions/state.json')) ?? {
      version: 5,
      chats: [],
    };
    const state = validateSessionState(raw);
    const chat = state.chats.find((c) => c.id === trimmedId);
    if (!chat?.boardGroupId?.trim()) {
      return { onBoard: false, boardMode: undefined };
    }
    const groupId = chat.boardGroupId.trim();
    const group = state.groups?.find((g) => g.id === groupId);
    const boardMode = group?.orchestrateBoard?.shellSandboxMode;
    return {
      onBoard: true,
      boardMode: typeof boardMode === 'string' ? boardMode : undefined,
      groupId,
    };
  } catch {
    return { onBoard: false, boardMode: undefined };
  }
}

/**
 * @param {object} [params]
 * @param {string} [params.chatId]
 * @param {'off'|'prefer'|'require'} [params.modeOverride]
 * @param {boolean} [params.allowUnsandboxed]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {Promise<{ mode: 'off'|'prefer'|'require', allowUnsandboxed: boolean, onBoard: boolean, groupId?: string }>}
 */
export async function resolveShellSandboxForRun({
  chatId,
  modeOverride,
  allowUnsandboxed,
  env = process.env,
} = {}) {
  const board = await resolveBoardSandboxContext(chatId ?? '');
  const [globalMode, alwaysAllow] = await Promise.all([
    getShellSandboxFromConfig(),
    getAllowUnsandboxedShellFromConfig(),
  ]);

  let mode =
    modeOverride != null
      ? resolveEffectiveShellSandboxMode({
          globalMode: modeOverride,
          onBoard: false,
          platform: process.platform,
          env,
        })
      : resolveEffectiveShellSandboxMode({
          globalMode,
          boardMode: board.boardMode,
          onBoard: board.onBoard,
          platform: process.platform,
          env,
        });

  const ceiling = pathAccessStore.getStore()?.shellSandboxMode;
  const ranks = ['off', 'prefer', 'require'];
  if (ranks.includes(ceiling) && ranks.indexOf(ceiling) > ranks.indexOf(mode)) mode = ceiling;
  return {
    mode,
    allowUnsandboxed: mode === 'require' ? false : allowUnsandboxed === true || alwaysAllow === true,
    onBoard: board.onBoard,
    ...(board.groupId ? { groupId: board.groupId } : {}),
  };
}
