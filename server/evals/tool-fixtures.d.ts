export interface EvalToolFixtures { version: 1; steps: Array<{ name: string; matchArgs: Record<string, unknown>; result: unknown }> }
export function validateEvalToolFixtures(raw: unknown, allowedTools: string[], deniedTools: string[], knownTools: Set<string>): EvalToolFixtures;
