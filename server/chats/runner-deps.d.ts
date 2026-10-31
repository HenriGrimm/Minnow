import type { RunnerDeps } from '../runner/adapters.js';
import type { PreparedChatExecution } from './preparation.js';
export function createChatRunnerDeps(prepared: PreparedChatExecution): Promise<RunnerDeps>;
