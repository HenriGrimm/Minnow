/** Counts work between confirmed edits, not exact argument/result repetitions. */
export function createProgressBudget(enabled, maxCalls = 48) {
  const limit = Number.isFinite(maxCalls) && maxCalls >= 12 ? Math.floor(maxCalls) : 48;
  let calls = 0;
  let repairBatches = 0;
  return {
    reset() { calls = 0; repairBatches = 0; },
    check(names = []) {
      if (!enabled || calls < limit) return;
      // Allow acting on the checkpoint and bounded repair of a rejected patch.
      if (repairBatches < 3 && names.some(name => ['apply_patch', 'save_file', 'replace_text_in_file', 'insert_at_line', 'append_file', 'execute_command'].includes(name))) {
        repairBatches++;
        return;
      }
      throw new Error(`Build investigation budget exhausted after ${calls} tool calls without a confirmed edit. Report findings and remaining uncertainty; ask the user before extending the investigation. Do not claim completion or make cosmetic edits to reset the budget.`);
    },
    note(name, result) {
      if (!enabled) return null;
      const failed = result?.isError === true || /^Error:|^Not implemented:/i.test(result?.content ?? '');
      const change = result?.codeChange;
      if (!failed && change && (change.additions > 0 || change.deletions > 0)) {
        calls = 0;
        repairBatches = 0;
        return null;
      }
      // Reporting/planning/discovery isn't implementation progress, but don't
      // charge it against the evidence-gathering allowance either.
      if (['todo_write', 'search_tools', 'recall_history', 'ask_question'].includes(name)) return null;
      calls++;
      if (calls % 12 !== 0) return null;
      return `[Minnow build checkpoint: ${calls}/${limit} tool calls since the last confirmed edit. Summarize the current hypothesis and missing evidence. If enough is known, implement the scoped change; otherwise narrow the next check or report what prevents implementation. Do not keep surveying or replaying browser tests, skip required verification, or make cosmetic edits to reset this budget.]`;
    },
  };
}
