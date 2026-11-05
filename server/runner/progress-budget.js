/** Advisory checkpoints between confirmed edits; never abort a build. */
export function createProgressBudget(enabled, maxCalls = 48) {
  const limit = Number.isFinite(maxCalls) && maxCalls >= 12 ? Math.floor(maxCalls) : 48;
  let calls = 0;
  let previousFailure = '';
  let probeFailures = 0;
  const isProbe = name => name.startsWith('browser_') && !['browser_close_tab', 'browser_release_tab'].includes(name);
  return {
    reset() { calls = 0; previousFailure = ''; probeFailures = 0; },
    note(name, result, args) {
      if (!enabled) return null;
      const failed = result?.isError === true || /^Error:|^Not implemented:/i.test(result?.content ?? '');
      const change = result?.codeChange;
      if (!failed && change && (change.additions > 0 || change.deletions > 0)) {
        calls = 0;
        previousFailure = '';
        probeFailures = 0;
        return null;
      }
      // Reporting/planning/discovery isn't implementation progress, but don't
      // charge it against the evidence-gathering allowance either.
      if (['todo_write', 'search_tools', 'recall_history', 'ask_question'].includes(name)) return null;
      if (isProbe(name)) {
        const signature = failed ? name + ':' + String(result?.content ?? '').slice(0, 256) : '';
        probeFailures = signature && signature === previousFailure ? probeFailures + 1 : failed ? 1 : 0;
        previousFailure = signature;
        if (probeFailures === 3) return `[Minnow verification checkpoint: ${name} had 3 consecutive failures with the same result. Follow its recovery advice or report the blocked criterion before repeating the probe.]`;
        return null;
      }
      if (!failed && (name === 'get_lsp_diagnostics' || (name === 'execute_command' &&
        /\b(?:test|pytest|vitest|jest|tsc|lint|playwright)\b/i.test(args?.command ?? '') && /\(exit 0\)/.test(result?.content?.split('\n', 1)[0] ?? '')))) return null;
      calls++;
      if (calls === 6) return '[Minnow build checkpoint: state Hypothesis:, Next edit:, and Acceptance check: now. Implement the smallest coherent change when evidence supports it; if not, name the specific missing fact and check only that. Do not make cosmetic edits to reset the budget.]';
      if (calls !== 12 && calls % limit !== 0) return null;
      return `[Minnow build checkpoint: ${calls}/${limit} calls since the last confirmed edit. State Hypothesis:, Next edit:, Acceptance check:, or Blocked: with the specific missing fact. Consult retained findings and recall_history before re-reading. Implement a scoped change when supported; do not keep surveying or make cosmetic edits to reset this count. Continue the task and report honestly if blocked.]`;
    },
  };
}
