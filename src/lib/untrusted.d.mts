export const GUARD_OPEN_PREFIX: string;
export const GUARD_CLOSE: string;
export function escapeGuardMarkers(text: string): string;
export function sanitizeSourceLabel(source: string): string;
export function isWrappedUntrusted(text: string): boolean;
export function wrapUntrusted(text: string, opts: { source: string }): string;
export const UNTRUSTED_CONTEXT_POLICY_FULL: string;
