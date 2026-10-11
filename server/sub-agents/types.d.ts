export type EnvelopeVersion = number;

export interface EventEnvelope {
  v: number;
  seq?: number;
  ts?: number;
  type: string;
}

export type AttemptOutcome =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'no_report'
  | 'crashed'
  | 'timeout';

export type SubAgentRole = 'sub-agent';

export type SeedKind = 'initial' | 'continue';

export type RunPhase = 'idle' | 'running' | 'passed' | 'abandoned' | 'cancelled' | 'cancelling';

export type AgentsStatus = 'idle' | 'running';

export type FieldType =
  | 'id'
  | 'str'
  | 'int'
  | 'posint'
  | 'str[]'
  | 'obj[]'
  | 'obj'
  | { enum: readonly string[] };

export interface EventSchema {
  readonly required: Readonly<Record<string, FieldType>>;
  readonly optional: Readonly<Record<string, FieldType>>;
}

export type ValidationResult =
  | { ok: true; event: Record<string, unknown>; known: boolean }
  | { ok: false; error: string };

export interface Attempt {
  attemptId: string;
  seedKind: SeedKind | string | null;
  seed: Record<string, unknown> | null;
  model: { providerId: string; id: string } | null;
  ended: boolean;
  outcome: AttemptOutcome | null;
  summary: string | null;
  evidence: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
}

export interface RunState {
  runId: string;
  type: string;
  task: string;
  parentChatId: string;
  cwd: string;
  requestedAt: number | null;
  endedAt: number | null;
  phase: RunPhase;
  attempts: Attempt[];
  abandonedReason: string | null;
  abandonedEvidence: Record<string, unknown> | null;
  cancelledReason: 'user' | null;
  delivered: boolean;
  deliveredSkipReason: 'missing_chat' | 'orchestrate' | null;
  nudged: boolean;
  parentTurnId: string | null;
  parentToolCallId: string | null;
  model: { providerId: string; id: string } | null;
}

export interface AgentsState {
  parentChatId: string;
  status: AgentsStatus;
  runs: Map<string, RunState>;
  runOrder: string[];
}

export interface Caps {
  globalMaxConcurrent: number;
  maxConcurrentByType?: Readonly<Record<string, number>>;
}

export interface Desired {
  taskId: string;
  role: SubAgentRole;
  seedKind?: SeedKind;
}

export type Action =
  | { kind: 'retry'; seedKind: SeedKind }
  | { kind: 'deliver' }
  | { kind: 'done'; reason: string }
  | { kind: 'abandon'; reason: string; evidence?: Record<string, unknown> };

export type NextAction =
  | { kind: 'start'; role: SubAgentRole; seedKind: SeedKind }
  | { kind: 'abandon'; reason: string; evidence: Record<string, unknown> }
  | { kind: 'none' };

export interface PolicyRow {
  readonly outcome: string;
  readonly under: number | null;
  readonly action: Action;
}
