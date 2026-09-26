import { cancelTerminalRun, startTerminalRun, streamTerminalRun } from '../api/terminal';
import { saveShipGateEvidence } from '../api/ship-gate';
import { gitDiff, gitLog, gitStatus } from '../state/git-api';
import { getActiveChat } from '../state/sessions';
import {
  gitStateFingerprint,
  type ShipGateCheckConfig,
  type ShipGateCheckEvidence,
  type ShipGateEvidence,
} from './model';

const MAX_OUTPUT = 12_000;

export interface ShipGateRunCallbacks {
  onCheckStart?: (check: ShipGateCheckConfig) => void;
  onOutput?: (check: ShipGateCheckConfig, text: string, stream: 'stdout' | 'stderr') => void;
  onCheckComplete?: (check: ShipGateCheckConfig, evidence: ShipGateCheckEvidence) => void;
}

export interface ShipGateRunHandle {
  result: Promise<ShipGateEvidence>;
  cancel: () => Promise<void>;
}

async function snapshot(workspaceRoot?: string): Promise<{ headSha: string | null; fingerprint: string }> {
  const [log, status, working, staged] = await Promise.all([
    gitLog({ cwd: workspaceRoot, count: 1 }),
    gitStatus(workspaceRoot),
    gitDiff({ cwd: workspaceRoot, workingTree: true }),
    gitDiff({ cwd: workspaceRoot, cached: true }),
  ]);
  return {
    headSha: log.ok ? (log.commits?.[0]?.hash ?? null) : null,
    fingerprint: status.ok
      ? gitStateFingerprint(status, working.ok ? working.patch : '', staged.ok ? staged.patch : '')
      : '',
  };
}

export function runShipGate(input: {
  checks: ShipGateCheckConfig[];
  configSignature: string;
  workspaceRoot?: string;
  callbacks?: ShipGateRunCallbacks;
}): ShipGateRunHandle {
  let currentRunId: string | null = null;
  let cancelled = false;
  const abort = new AbortController();

  const cancel = async (): Promise<void> => {
    cancelled = true;
    abort.abort();
    if (currentRunId) await cancelTerminalRun(currentRunId);
  };

  const result = (async (): Promise<ShipGateEvidence> => {
    const startedAt = new Date().toISOString();
    const before = await snapshot(input.workspaceRoot);
    const completed: ShipGateCheckEvidence[] = [];
    const selected = input.checks.filter((check) => check.enabled && check.command.trim());

    for (const check of selected) {
      if (cancelled) break;
      input.callbacks?.onCheckStart?.(check);
      const checkStarted = Date.now();
      let output = '';
      let exitCode: number | null = null;
      let stopped = false;
      let started: Awaited<ReturnType<typeof startTerminalRun>>;
      try {
        started = await startTerminalRun({
          command: check.command,
          shell: true,
          chatId: getActiveChat().id,
          source: 'user',
          workspaceRoot: input.workspaceRoot,
          timeoutMs: 600_000,
        });
      } catch (err) {
        const evidence: ShipGateCheckEvidence = {
          id: check.id,
          command: check.command,
          outcome: 'fail',
          exitCode: null,
          durationMs: Date.now() - checkStarted,
          runId: '',
          outputTail: err instanceof Error ? err.message : String(err),
        };
        completed.push(evidence);
        input.callbacks?.onCheckComplete?.(check, evidence);
        break;
      }
      currentRunId = started.runId;
      try {
        await streamTerminalRun(started.runId, (event) => {
          if (event.type === 'stdout' || event.type === 'stderr') {
            output = `${output}${event.text}`.slice(-MAX_OUTPUT);
            input.callbacks?.onOutput?.(check, event.text, event.type);
          } else if (event.type === 'exit') {
            exitCode = event.code;
            stopped = event.stopped === true;
          } else if (event.type === 'error') {
            output = `${output}\n${event.message}`.slice(-MAX_OUTPUT);
          }
        }, abort.signal);
      } catch (err) {
        if (!cancelled) output = `${output}\n${err instanceof Error ? err.message : String(err)}`.slice(-MAX_OUTPUT);
      } finally {
        currentRunId = null;
      }

      const outcome = cancelled || stopped ? 'cancelled' : exitCode === 0 ? 'pass' : 'fail';
      const evidence: ShipGateCheckEvidence = {
        id: check.id,
        command: check.command,
        outcome,
        exitCode,
        durationMs: Date.now() - checkStarted,
        runId: started.runId,
        outputTail: output,
      };
      completed.push(evidence);
      input.callbacks?.onCheckComplete?.(check, evidence);
      if (outcome !== 'pass') break;
    }

    const after = await snapshot(input.workspaceRoot);
    const outcome = cancelled
      ? 'cancelled'
      : selected.length > 0 && completed.length === selected.length && completed.every((check) => check.outcome === 'pass')
        ? 'pass'
        : 'fail';
    const evidence: ShipGateEvidence = {
      version: 1,
      outcome,
      startedAt,
      completedAt: new Date().toISOString(),
      headSha: after.headSha ?? before.headSha,
      gitFingerprint: after.fingerprint,
      configSignature: input.configSignature,
      checks: completed,
    };
    return saveShipGateEvidence(evidence, input.workspaceRoot);
  })();

  return { result, cancel };
}
