import type { Engine } from '../orchestrator/engine';
export function createJournaledAsk(options: { engine: Engine; runId: string; attemptId: string; deliver?: (event: unknown) => void }): (input: any, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>;
export function answerJournaledGate(options: { engine: Engine; runId: string; gateId: string; answer: string; errors?: string[] }): Promise<{ ok: boolean; status: number; error?: string }>;
