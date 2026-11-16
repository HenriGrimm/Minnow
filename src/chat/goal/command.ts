import type { Chat } from '../../types';
import {
  clearActiveGoal,
  getActiveGoal,
  hasActiveLoops,
  setActiveGoal,
} from '../../state/sessions';
import { syncGoalActiveHint } from '../../ui/goal-active-hint';
import { syncLoopActiveHint } from '../../ui/loop-active-hint';
import { parseGoalSlashInput } from './parse-command';

export type GoalCommandDispatch = 'handled' | 'set' | null;

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

function formatGoalStatus(chat: Chat): string {
  const goal = getActiveGoal(chat);
  if (!goal) {
    return 'No active goal. Use /goal <condition> to set one.';
  }

  const tokensSince = Math.max(
    0,
    (chat.tokenLedger?.totals.totalTokens ?? chat.tokenLedgerTotals?.totalTokens ?? 0) - goal.tokenBaseline,
  );
  const elapsed = formatElapsed(Date.now() - goal.startedAt);
  const achievedLine = goal.achieved ? ' · achieved' : '';
  const reasonLine = goal.lastReason ? ` Last evaluator: ${goal.lastReason}` : '';
  return `Goal${achievedLine}: ${goal.conditionText} · ${elapsed} · ${goal.turnCount} turn(s) evaluated · ~${tokensSince} tokens.${reasonLine}`;
}

export function handleGoalCommand(
  chat: Chat,
  rawText: string,
  reportStatus: (level: 'ok' | 'err', message: string) => void,
): GoalCommandDispatch {
  const parsed = parseGoalSlashInput(rawText);
  if (!parsed) return null;

  if (parsed.kind === 'clear') {
    clearActiveGoal(chat);
    syncGoalActiveHint();
    syncLoopActiveHint();
    reportStatus('ok', 'Goal cleared');
    return 'handled';
  }

  if (parsed.kind === 'status') {
    reportStatus('ok', formatGoalStatus(chat));
    return 'handled';
  }

  if (!parsed.conditionText) {
    reportStatus('err', 'Add a completion condition after /goal');
    return 'handled';
  }

  if (hasActiveLoops(chat)) {
    reportStatus('err', 'Stop active loops first (/loop stop) before starting a goal');
    return 'handled';
  }

  setActiveGoal(chat, parsed.conditionText);
  syncGoalActiveHint();
  syncLoopActiveHint();
  reportStatus('ok', 'Goal active — working toward completion…');
  return 'set';
}
