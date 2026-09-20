import type { RunnerDeps } from './adapters';
import type { SubAgentRunner } from '../../src/agents/types';
import type { ApiMessage } from '../../src/types';

export function createTurnRunner(deps: RunnerDeps): SubAgentRunner;
export function cloneTurnMessages(messages: ApiMessage[]): ApiMessage[];
