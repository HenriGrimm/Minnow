export interface PauseGate {
  readonly paused: boolean;
  setPaused(value: boolean): void;
  subscribe(listener: (paused: boolean) => void): () => void;
  wait(signal?: AbortSignal): Promise<void>;
}
export function createPauseGate(): PauseGate;
