import { apiMessageContentToText } from '../../api/message-content';
import type { UserMessage } from '../../types';

const PIPELINE_USER_PREFIX = 'Super Plan pipeline —';

/**
 * True for a stage prompt the retired in-renderer Super Plan controller pushed
 * into a chat's history. Those rows only live in old sessions now; the
 * transcript keeps hiding them.
 */
export function isSuperPlanPipelineUserMessage(msg: UserMessage): boolean {
  if (typeof msg.superPlanStage === 'string' && msg.superPlanStage.trim()) return true;
  // Coerce leaked ContentPart[] so reload cannot throw `content.trimStart is not a function`.
  return apiMessageContentToText(msg.content).trimStart().startsWith(PIPELINE_USER_PREFIX);
}
