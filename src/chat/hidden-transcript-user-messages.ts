import { apiMessageContentToText } from '../api/message-content';
import type { UserMessage } from '../types';
import { isSuperPlanPipelineUserMessage } from './super-plan/hidden-user-messages';

const SUB_AGENT_RESUME_PREFIXES = [
  '[Sub-agent finished]',
  '[Sub-agent check-in]',
  '[Sub-agent] No terminal',
] as const;

/**
 * History `content` is typed as a string, but leaked API rows may store
 * multimodal `ContentPart[]`. Prefix checks must not call string methods on that.
 */
function userMessageText(msg: UserMessage): string {
  return apiMessageContentToText(msg.content);
}

/** True when this user row is an ephemeral VLM screenshot follow-up that leaked into history. */
function isLeakedToolImageFollowUp(msg: UserMessage): boolean {
  return (msg as { toolImageFollowUp?: unknown }).toolImageFollowUp === true;
}

/** True when a user row is an automatic sub-agent completion or check-in resume prompt. */
export function isSubAgentResumeUserMessage(msg: UserMessage): boolean {
  const trimmed = userMessageText(msg).trimStart();
  return SUB_AGENT_RESUME_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** True when a user row should be omitted from transcript rendering. */
export function isHiddenTranscriptUserMessage(msg: UserMessage): boolean {
  if (msg.hiddenFromTranscript) return true;
  // Runner persist can write screenshot follow-ups into chat.history (array content).
  if (isLeakedToolImageFollowUp(msg)) return true;
  if (msg.provenance?.version === 1 && (msg.provenance.kind === 'peer_message' || msg.provenance.kind === 'delegation_result')) return false;
  if (isSuperPlanPipelineUserMessage(msg)) return true;
  if (isSubAgentResumeUserMessage(msg)) return true;
  return false;
}

/** Stamp a pushed user row as hidden from the chat transcript UI. */
export function hiddenTranscriptUserMessage(content: string): UserMessage {
  return { role: 'user', content, hiddenFromTranscript: true };
}
