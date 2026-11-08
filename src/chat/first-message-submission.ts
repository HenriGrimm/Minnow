import type { Chat, QueuedComposerMessage } from '../types';

interface Submission {
  id: string;
  message: QueuedComposerMessage;
  active: boolean;
  accepted: boolean;
}

// Presentation only: admission and the runner remain the sole transcript writers.
const submissions = new WeakMap<Chat, Submission>();

export function isFirstMessageSubmissionPending(chat: Chat): boolean {
  return submissions.get(chat)?.active === true;
}

export function beginFirstMessageSubmission(chat: Chat, message: QueuedComposerMessage): void {
  submissions.set(chat, { id: message.id, message, active: true, accepted: false });
}

export function acceptFirstMessageSubmission(chat: Chat, submissionId: string | undefined, commandId: string, state: string): void {
  const submission = submissions.get(chat);
  if (!submission?.active || submission.id !== submissionId) return;
  submission.message = { ...submission.message, id: commandId };
  submission.accepted = !['settled', 'failed', 'cancelled'].includes(state);
}

export function finishFirstMessageSubmission(chat: Chat, submissionId?: string): void {
  const submission = submissions.get(chat);
  if (!submission || submissionId !== undefined && submission.id !== submissionId) return;
  submission.active = false;
  if (!submission.accepted) submissions.delete(chat);
}

export function getFirstMessageSubmission(chat: Chat): QueuedComposerMessage | undefined {
  const submission = submissions.get(chat);
  if (!submission) return;
  const committed = chat.history.some(message => message.role === 'user' &&
    (message.commandId === submission.message.id || chat.chatCommandVersion !== 1));
  const pending = chat.agentPendingCommand;
  const execution = chat.agentExecution;
  const stopped = submission.accepted && (pending?.commandId === submission.message.id && (pending.held || pending.errorCode) ||
    execution?.commandId === submission.message.id && ['completed', 'failed', 'stopped', 'cancelled', 'recovery_required'].includes(execution.status));
  if (committed || stopped) {
    if (!submission.active) submissions.delete(chat);
    return;
  }
  return submission.message;
}
