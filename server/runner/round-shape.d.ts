export const BATCH_STREAK: 4;
export const BATCH_REPEAT: 10;

export interface RoundShapeOptions {
  batching?: boolean;
  verdictRounds?: number | null;
}

export interface RoundShapeGuard {
  note(names: string[], round: number): string | null;
}

export function createRoundShapeGuard(options?: RoundShapeOptions): RoundShapeGuard;
