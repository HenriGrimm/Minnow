export function toolGetDatetime(): string;
export function toolCalculate(args: Record<string, unknown>): string;
export const MAX_WAIT_MS: number;
export const DEFAULT_WAIT_MS: number;
export const DEFAULT_WAIT_REASON: string;
export function formatWaitDuration(ms: number): string;
export function parseWaitDuration(raw: unknown): { ok: true; ms: number } | { ok: false; error: string };
export function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void>;
