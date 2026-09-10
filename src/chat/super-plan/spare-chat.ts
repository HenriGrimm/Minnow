/**
 * Rules for reusing an empty Plan / Super Plan chat as a composer spare.
 *
 * A live Super Plan often still has `history: []` (lazy summaries, or the
 * interview has not pushed a turn yet). Treating that as "empty" reused the
 * in-flight chat, replaced `superPlan`, and mixed Activity ledgers.
 */

import { normalizeModeId } from '../modes/types';
import type { Chat } from '../../types';

export type PlanComposerModeId = 'plan' | 'super-plan';

/**
 * True when this chat is a blank composer we may reuse for a new plan.
 * Any `superPlan` blob (including cancelled/finished) is a real run, not a spare.
 */
export function isReusableEmptyPlanChat(
  chat: Chat,
  modeId: PlanComposerModeId,
): boolean {
  if (normalizeModeId(chat.modeId) !== modeId) return false;
  // Pipeline state means this row already belongs to a run — never hijack it.
  if (chat.superPlanView) return false;
  if (chat.historyLoaded === false) {
    // Lazy boot inflates `history: []`; honor denormalized counts so a live
    // transcript is not treated as a spare composer.
    return (chat.messageCount ?? 0) === 0;
  }
  if ((chat.history?.length ?? 0) > 0) return false;
  if ((chat.messageCount ?? 0) > 0) return false;
  return true;
}
