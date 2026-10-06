/**
 * `/followup` composer command (MIN-206).
 *
 * Arming never sends text to the model: it records a chain on the chat and the runner
 * spawns the next chat when this one goes idle. Mirrors `src/chat/loop/command.ts`.
 */

import { normalizeModeId } from '../modes/types';
import {
  getChatMessageCount,
  hasActiveLoops,
  hasFollowupChain,
  isGoalLoopActive,
  newChatId,
  setFollowupChain,
  clearFollowupChain,
} from '../../state/sessions';
import { syncFollowupActiveHint } from '../../ui/followup-active-hint';
import type { Chat } from '../../types';
import { isNestedFollowupPrompt, parseFollowupSlashInput } from './parse-command';
import { notifyFollowupScheduleChanged } from './runner';

export type FollowupCommandDispatch = 'handled' | 'armed' | null;

export function handleFollowupCommand(
  chat: Chat,
  rawText: string,
  reportStatus: (level: 'ok' | 'err', message: string) => void,
  now = Date.now(),
): FollowupCommandDispatch {
  const parsed = parseFollowupSlashInput(rawText);
  if (!parsed) return null;

  if (parsed.kind === 'clear') {
    clearFollowupChain(chat);
    syncFollowupActiveHint();
    reportStatus('ok', 'Follow-up chain cleared');
    return 'handled';
  }

  if (parsed.kind === 'invalid') {
    reportStatus('err', parsed.message);
    return 'handled';
  }

  if (hasFollowupChain(chat)) {
    reportStatus('err', 'A follow-up chain is already armed on this chat (/followup stop to clear it)');
    return 'handled';
  }

  if (isGoalLoopActive(chat) || hasActiveLoops(chat)) {
    reportStatus('err', 'Stop the active goal or loop first (/goal clear, /loop stop)');
    return 'handled';
  }

  if (getChatMessageCount(chat) === 0) {
    reportStatus('err', 'Nothing to follow up yet — send a message first');
    return 'handled';
  }

  if (isNestedFollowupPrompt(parsed.promptText)) {
    reportStatus('err', 'Follow-up tasks cannot start another /followup');
    return 'handled';
  }

  setFollowupChain(chat, {
    chainId: newChatId(),
    total: parsed.count,
    index: 0,
    remaining: parsed.count,
    promptText: parsed.promptText,
    modeId: normalizeModeId(chat.modeId),
    rootChatId: chat.id,
    parentChatId: chat.id,
    createdAt: now,
  });

  syncFollowupActiveHint();
  notifyFollowupScheduleChanged();
  reportStatus('ok', `Follow-up chain armed · ${parsed.count} task(s)`);
  return 'armed';
}
