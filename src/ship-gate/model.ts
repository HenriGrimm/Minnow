import type { GitOpResult } from '../state/git-api';

export type ShipGateCheckId =
  | 'typecheck'
  | 'tests'
  | 'build'
  | 'performance'
  | 'secrets'
  | 'dependencies';

export interface ShipGateCheckConfig {
  id: ShipGateCheckId;
  label: string;
  enabled: boolean;
  command: string;
}

export interface ShipGateConfig {
  version: 1;
  enabled: boolean;
  policy: 'warn' | 'block';
  checks: ShipGateCheckConfig[];
}

export interface ShipGateCheckEvidence {
  id: ShipGateCheckId;
  command: string;
  outcome: 'pass' | 'fail' | 'cancelled';
  exitCode: number | null;
  durationMs: number;
  runId: string;
  outputTail: string;
}

export interface ShipGateEvidence {
  version: 1;
  outcome: 'pass' | 'fail' | 'cancelled';
  startedAt: string;
  completedAt: string;
  headSha: string | null;
  gitFingerprint: string;
  configSignature: string;
  checks: ShipGateCheckEvidence[];
}

export interface ShipGateState {
  config: ShipGateConfig;
  configSignature: string;
  configPath: string;
  evidence: ShipGateEvidence | null;
}

function rows(result: GitOpResult): Array<{ path: string; status: string; bucket: string }> {
  return [
    ...(result.staged ?? []).map((row) => ({ ...row, bucket: 'staged' })),
    ...(result.unstaged ?? []).map((row) => ({ ...row, bucket: 'unstaged' })),
    ...(result.untracked ?? []).map((row) => ({ ...row, bucket: 'untracked' })),
  ];
}

function compactHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + i;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

/** Stable content-aware working-tree identity used to invalidate a previously passing gate. */
export function gitStateFingerprint(
  result: GitOpResult,
  workingTreePatch = '',
  stagedPatch = '',
): string {
  const status = JSON.stringify(rows(result).sort((a, b) =>
    `${a.bucket}:${a.path}:${a.status}`.localeCompare(`${b.bucket}:${b.path}:${b.status}`),
  ));
  return compactHash(`${status}\n--working--\n${workingTreePatch}\n--staged--\n${stagedPatch}`);
}

export type ShipGateReadiness = 'disabled' | 'missing' | 'failed' | 'stale' | 'passed';

export function assessShipGateEvidence(input: {
  config: ShipGateConfig;
  configSignature: string;
  evidence: ShipGateEvidence | null;
  headSha: string | null;
  gitFingerprint: string;
}): ShipGateReadiness {
  if (!input.config.enabled) return 'disabled';
  if (!input.evidence) return 'missing';
  if (input.evidence.outcome !== 'pass') return 'failed';
  if (
    input.evidence.configSignature !== input.configSignature ||
    input.evidence.headSha !== input.headSha ||
    input.evidence.gitFingerprint !== input.gitFingerprint
  ) return 'stale';
  return 'passed';
}

export function shipGateReadinessLabel(state: ShipGateReadiness): string {
  if (state === 'passed') return 'Passed for current changes';
  if (state === 'failed') return 'Last run failed';
  if (state === 'stale') return 'Repository changed since last pass';
  if (state === 'disabled') return 'Gate disabled';
  return 'Not run for current changes';
}
