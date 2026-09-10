import type {
  EventSchema,
  FieldType,
  GateKind,
  GateVerdict,
  RunOutcome,
  StageId,
  StageOutcome,
  StopReason,
  ValidationResult,
} from './types';

/** Envelope version this build writes. Readers tolerate anything >= 1. */
export const ENVELOPE_VERSION: number;

/** Every stage the pipeline can run. Each is a Desired role too. */
export const STAGES: readonly StageId[];

/** How a stage attempt ended. `rejected` is the accept-gate verdict on a draft. */
export const STAGE_OUTCOMES: readonly StageOutcome[];

/** The two user checkpoints. */
export const GATE_KINDS: readonly GateKind[];

/** What a user can say at a gate. */
export const GATE_VERDICTS: readonly GateVerdict[];

/** How a whole run ended. */
export const RUN_OUTCOMES: readonly RunOutcome[];

/** Why a run stopped. */
export const STOP_REASONS: readonly StopReason[];

/** The event vocabulary, as data. */
export const EVENT_SCHEMAS: Readonly<Record<string, EventSchema>>;

/** Every known event type, in declaration order. */
export const EVENT_TYPES: string[];

/** Is this a type the fold understands? Unknown types are tolerated, not invalid. */
export function isKnownEventType(type: unknown): boolean;

/**
 * Validate one raw journal line.
 */
export function validateEvent(raw: unknown): ValidationResult;

/** Build an envelope around a payload. The journal writer stamps `seq` and `ts`. */
export function makeEvent(type: string, payload?: Record<string, unknown>): Record<string, unknown>;
