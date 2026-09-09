export const DEFAULT_TOOL_TIMEOUT_MS: number;

export function toolCallTimeoutMs(name: string): number | null;

export function toolTimeoutMessage(name: string, timeoutMs: number): string;
