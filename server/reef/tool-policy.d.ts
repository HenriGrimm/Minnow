export const REEF_TOOLS: Set<string>;
export function reefToolAllowed(name: string, phase?: string): boolean;
export function reefProtectedPath(args: Record<string, unknown>): boolean;
