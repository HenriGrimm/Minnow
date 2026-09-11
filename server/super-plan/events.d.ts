import type {
  ArtifactKind,
  CheckpointKind,
  EventSchema,
  SeedKind,
  StageId,
  StageOutcome,
  ValidationResult,
} from './types';

/** Envelope version this build writes. Readers tolerate anything >= 1. */
export const ENVELOPE_VERSION: number;

/** Every stage the engine can run. */
export const STAGES: readonly StageId[];

/** Stages that run a model turn through `runTurn`. */
export const AGENT_STAGES: readonly StageId[];

/** Stages the pipeline can do without. */
export const OPTIONAL_STAGES: readonly StageId[];

/** How an effector reports a stage attempt ended. */
export const STAGE_OUTCOMES: readonly StageOutcome[];

/** The two user checkpoints. */
export const CHECKPOINTS: readonly CheckpointKind[];

/** What a user can answer at each checkpoint. */
export const CHECKPOINT_VERDICTS: Readonly<Record<CheckpointKind, readonly string[]>>;

/** Files the pipeline owns. */
export const ARTIFACT_KINDS: readonly ArtifactKind[];

/** Why an attempt is seeded the way it is. */
export const SEED_KINDS: readonly SeedKind[];

/** The event vocabulary, as data. */
export const EVENT_SCHEMAS: Readonly<Record<string, EventSchema>>;

/** Every known event type, in declaration order. */
export const EVENT_TYPES: string[];

/** Is this a type the fold understands? Unknown types are tolerated, not invalid. */
export function isKnownEventType(type: unknown): boolean;

/** Validate one raw journal line. */
export function validateEvent(raw: unknown): ValidationResult;

/** Build an envelope around a payload, dropping undefined fields. The journal stamps `seq` and `ts`. */
export function makeEvent(type: string, payload?: Record<string, unknown>): Record<string, unknown>;
