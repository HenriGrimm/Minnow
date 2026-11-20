import { ChatContractError } from './contracts.js';
import { hashChatPayload } from './repository.js';

export const ORDINARY_CONSENT_MS = 120_000;

export function ordinaryChatConsentHash(repository, caller, action) {
  const execution = caller.executionId && repository.getExecution(caller.executionId);
  const command = execution?.commandId && repository.getCommand(execution.commandId);
  const effective = command?.effectiveCommand;
  const origin = effective?.provenance;
  if (caller.actor !== 'agent' || execution?.chatId !== caller.chatId || command?.chatId !== caller.chatId
      || origin?.actor !== 'human' || !['composer', 'device', 'cli'].includes(origin.source)
      || effective.intent?.goalDriven || effective.intent?.suppressUserEcho) {
    throw new ChatContractError('policy_denied', 'An active turn started by a human is required for this chat action');
  }
  return hashChatPayload([caller.scope.projectId, caller.chatId, caller.executionId, command.commandId, action]);
}

export function assertOrdinaryChatConsent(repository, caller, action, proof, now) {
  const digest = ordinaryChatConsentHash(repository, caller, action);
  const request = proof?.requestId && repository.getRequest(proof.requestId);
  if (!request || request.chatId !== caller.chatId || request.executionId !== caller.executionId
      || request.toolCallId !== 'ordinary-' + hashChatPayload([proof.toolCallId, digest])
      || request.kind !== 'approval' || request.state !== 'answered'
      || !request.answerCommandId || !Number.isSafeInteger(request.expiresAt)
      || request.expiresAt <= now || request.expiresAt - request.createdAt > ORDINARY_CONSENT_MS
      || request.presentation?.ordinaryChatConsent !== digest) {
    throw new ChatContractError('policy_denied', 'This chat action requires its own current human confirmation');
  }
  const answer = repository.readRequestAnswer(request.requestId);
  if ((answer?.decision ?? answer) !== 'allow_once') {
    throw new ChatContractError('policy_denied', 'The user did not confirm this chat action. Do not retry or work around it.');
  }
}
