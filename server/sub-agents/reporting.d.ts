import type { TurnResult } from '../runner/run-turn';

export const SUB_AGENT_COMPLETION_GUIDANCE: string;
export function subAgentCompletionResult(result: TurnResult): TurnResult & { reportedOutcome?: 'fail' | 'blocked' };
