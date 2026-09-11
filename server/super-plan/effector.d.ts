import type { Effector } from '../orchestrator/engine';

export const SUPERPLAN_ENGINE_NAMESPACE: 'superplan';

export function createSuperPlanEffector(options: {
  runId: string;
  getEngine?: () => any;
  runStage?: (input: Record<string, any>) => Promise<{
    outcome: string;
    summary?: string;
    evidence?: Record<string, unknown>;
    usage?: Record<string, number>;
  }>;
}): Effector & {
  readonly started: Array<{ taskId: string | null; role: string; attemptId: string; seedKind?: string }>;
  vanishAll(): void;
};
