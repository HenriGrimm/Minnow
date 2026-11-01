import type { BoardState, TaskState } from '../../server/orchestrator/core/types';
import { createButton } from '../ui/components/button';
import { el } from './dom';
import { collectAttemptFacts, humanizeAbandonReason } from './attempt-scan';
import { renderReportEvidence, reportBadge, reportDisclosure } from './report-evidence';

export interface BoardAttentionActions {
  resetTask: (taskId: string) => void;
  fixFinal: () => void;
}

/** The most recent blocker any attempt journaled. */
function lastBlocker(task: TaskState): string | null {
  for (let i = task.attempts.length - 1; i >= 0; i -= 1) {
    const [first] = collectAttemptFacts(task.attempts[i].evidence).blockers;
    if (first) return first;
  }
  return null;
}

/** Why this card is on the list, in the fewest lines that stay actionable. */
export function attentionIssues(task: TaskState): string[] {
  const lines: string[] = [];
  if (task.skippedBy) lines.push(`Waiting on ${task.skippedBy}, which did not finish.`);
  else if (task.abandonedReason) lines.push(humanizeAbandonReason(task.abandonedReason));
  if (task.mergeConflicts?.length) {
    lines.push(`Merge conflicts in ${[...new Set(task.mergeConflicts)].join(', ')}`);
  }
  if (task.mergeFailure) {
    lines.push(
      `Merge could not run (${task.mergeFailure.reason})` +
        (task.mergeFailure.summary ? `: ${task.mergeFailure.summary}` : ''),
    );
  }
  const blocker = lastBlocker(task);
  if (blocker && !lines.includes(blocker)) lines.push(blocker);
  return lines.length ? lines : ['This task did not finish.'];
}

export function renderTaskAttention(task: TaskState, actions: BoardAttentionActions): HTMLElement {
  const row = el('div', 'ov2-attention__row');
  row.dataset.taskId = task.id;
  row.appendChild(el('span', 'ov2-attention__id', task.id));

  const main = el('div', 'ov2-attention__main');
  main.appendChild(el('span', 'ov2-attention__title', task.title));
  for (const line of attentionIssues(task)) {
    main.appendChild(el('p', 'ov2-attention__issue', line));
  }
  row.appendChild(main);
  row.appendChild(reportBadge(task.phase));

  const reset = createButton({ className: 'ov2-attention__action', label: 'Reset task', icon: 'undo', size: 'sm' });
  reset.title =
    `Reset ${task.id}: delete its attempts, transcript, worktree, and branch, ` +
    'and return the card to Planned. Integration is not changed.';
  reset.addEventListener('click', () => actions.resetTask(task.id));
  row.appendChild(reset);
  return row;
}

export function renderFinalAttention(state: BoardState, actions: BoardAttentionActions): HTMLElement {
  const row = el('div', 'ov2-attention__row ov2-attention__row--final');
  row.appendChild(el('span', 'ov2-attention__id', 'Final'));

  const main = el('div', 'ov2-attention__main');
  main.appendChild(el('span', 'ov2-attention__title', 'Integration check'));
  main.appendChild(el('p', 'ov2-attention__issue', finalFailText(state)));
  if (state.finalTest?.runInstructions) {
    const run = el('p', 'ov2-attention__run');
    run.appendChild(el('code', 'ov2-report-screen__run-cmd', state.finalTest.runInstructions));
    main.appendChild(run);
  }
  const evidence = state.finalTest?.evidence;
  if (evidence) {
    const output = [evidence.output, evidence.testOutput].find(
      (value): value is string => typeof value === 'string' && !!value.trim(),
    );
    if (output) {
      const details = el('details', 'ov2-report-disclosure ov2-integration-output');
      details.open = false;
      details.appendChild(el('summary', '', 'Command output'));
      const log = el('pre', 'ov2-report-evidence__log', output);
      log.tabIndex = 0;
      log.setAttribute('aria-label', 'Integration check command output');
      details.appendChild(log);
      main.appendChild(details);
    }
    const extra = { ...evidence };
    delete extra.output;
    delete extra.testOutput;
    delete extra.summary;
    if (Object.values(extra).some((value) => value != null && value !== '')) {
      main.appendChild(reportDisclosure('Check details', () => renderReportEvidence(extra)));
    }
  }
  row.appendChild(main);
  row.appendChild(reportBadge('fail'));

  const fix = createButton({ className: 'ov2-attention__action', label: 'Fix and re-verify', icon: 'loop', size: 'sm' });
  fix.title = 'Add a fix task and run the integration check again';
  fix.addEventListener('click', () => actions.fixFinal());
  row.appendChild(fix);
  return row;
}

function finalFailText(state: BoardState): string {
  const evidence = state.finalTest?.evidence;
  if (typeof evidence?.summary === 'string' && evidence.summary.trim()) {
    return evidence.summary.trim();
  }
  const browser = evidence?.browser && typeof evidence.browser === 'object' && !Array.isArray(evidence.browser)
    ? evidence.browser as Record<string, unknown> : null;
  const explanation = [browser?.summary, evidence?.reason].find(
    (value): value is string => typeof value === 'string' && !!value.trim(),
  );
  if (explanation) return explanation.trim();
  const blocker = collectAttemptFacts(evidence).blockers[0];
  if (blocker) return blocker;
  const rungs = Array.isArray(evidence?.rungs)
    ? evidence.rungs.filter((rung): rung is Record<string, unknown> =>
      !!rung && typeof rung === 'object' && !Array.isArray(rung),
    )
    : [];
  const failed = rungs.find((rung) => rung.id === evidence?.failedRung) ??
    rungs.find((rung) => rung.outcome === 'fail');
  const stage = typeof evidence?.failedRung === 'string' && evidence.failedRung.trim()
    ? evidence.failedRung.trim()
    : typeof failed?.id === 'string' ? failed.id : '';
  if (stage) {
    const names: Record<string, string> = {
      typecheck: 'Type check', lint: 'Lint', unit: 'Unit tests', build: 'Build', browser: 'Browser check',
    };
    const name = names[stage] ?? stage;
    const exit = typeof failed?.exitCode === 'number' && Number.isFinite(failed.exitCode)
      ? ` (exit code ${failed.exitCode})` : '';
    return `${name} failed${exit}.`;
  }
  if ((typeof evidence?.output === 'string' && evidence.output.trim()) ||
      (typeof evidence?.testOutput === 'string' && evidence.testOutput.trim())) {
    return 'The final integration test failed. See the recorded command output below.';
  }
  return 'The final integration test failed. No failure explanation or command output was recorded.';
}

