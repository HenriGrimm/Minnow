/** The initial migration supports ordinary roots, not legacy controllers/native resumes. */
export function ordinaryChatScopeBlocker(chat) {
  if (chat.agentConversation || chat.agentTypeId || chat.kind && chat.kind !== 'chat' || chat.background || chat.boardTaskId || chat.superPlanRunId) return 'specialized_conversation';
  if (!['general', 'build', 'plan', 'debug'].includes(chat.modeId ?? 'build')) return 'unsupported_mode';
  if (!chat.workspacePath?.trim()) return 'workspace_required';
  if (chat.currentGenerationId || chat.resumeInterrupted || chat.lastNativeContext) return 'legacy_recovery_required';
  if (chat.pendingSteerMessage || chat.pendingMessageQueue?.length || chat.pendingModeId) return 'legacy_queue_pending';
  if (chat.activeGoal || chat.activeLoops?.length || chat.followupChain) return 'legacy_controller_active';
  if (chat.workAgentId === 'ui-designer' || chat.uiDesignerMode || chat.expertRuntime || chat.expertId) return 'specialized_preparation';
  if (chat.lastContextTrim || chat.compaction || Object.keys(chat.activeBranchByFork ?? {}).length) return 'legacy_history_unsupported';
  if (chat.subAgentRuns?.some(run => !['completed', 'failed', 'cancelled', 'stopped'].includes(run.status))) return 'legacy_children_pending';
  return null;
}

/** Promotion never reconstructs unresolved/historical tool effects from renderer history. */
export function ordinaryChatHistoryBlocker(messages) {
  const pending = new Set(), seen = new Set();
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'injection') return 'legacy_history_unsupported';
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) return 'legacy_history_unsupported';
      continue;
    }
    if (pending.size) return 'legacy_history_unsupported';
    if (message.tool_calls?.length) {
      if (message.role !== 'assistant') return 'legacy_history_unsupported';
      for (const call of message.tool_calls) {
        if (typeof call.id !== 'string' || !call.id || seen.has(call.id) || call.type !== 'function' ||
            !call.function || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') return 'legacy_history_unsupported';
        seen.add(call.id); pending.add(call.id);
      }
    }
  }
  if (pending.size) return 'legacy_history_unsupported';
  return null;
}
