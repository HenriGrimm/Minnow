import type { TurnToolDefinition } from './run-turn';

/** Tool name the model calls. Injection decides whether it is on the wire. */
export const ASK_QUESTION_TOOL_NAME: 'ask_question';

/**
 * Default interactive wait (60 minutes), independent of the generation
 * silence watchdog. Override with `askTimeoutMs`.
 */
export const DEFAULT_ASK_TIMEOUT_MS: number;

/** Immediate tool result when no `AskCapability` is injected. */
export const ASK_QUESTION_UNAVAILABLE_ERROR: string;

/** Tool result when the interactive wait hits `askTimeoutMs`. */
export const ASK_QUESTION_TIMEOUT_ERROR: string;

/** True when `ask.ask` is a function. */
export function isAskCapability(ask: unknown): ask is { ask: (...args: never[]) => unknown };

/** Positive finite ms, else {@link DEFAULT_ASK_TIMEOUT_MS}. Never returns 0. */
export function resolveAskTimeoutMs(raw: unknown): number;

/** Catalog-shaped OpenAI function tool for `ask_question`. */
export function defaultAskQuestionTool(): TurnToolDefinition;

/**
 * Strip `ask_question` unless a capability is present; if present, ensure the
 * catalog schema is on the list (do not replace a caller-supplied schema).
 */
export function withAskQuestionTool(
  tools: TurnToolDefinition[] | undefined,
  ask: unknown,
): TurnToolDefinition[];

/** JSON-parse tool-call arguments when they arrive as a string. */
export function parseAskQuestionArgs(raw: unknown): unknown;

/** Coerce a capability return value to the tool-result string. */
export function stringifyAskAnswer(answer: unknown): string;
