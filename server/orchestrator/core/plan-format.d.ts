export type PlanType = 'build' | 'orchestrate' | 'invalid';
export function readPlanType(markdown: string): PlanType;
export function boardPlanTypeError(markdown: string): string | null;
