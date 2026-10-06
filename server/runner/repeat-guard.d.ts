/** Repeated-tool-call guard: warn, and optionally stop, on call+result pairs that keep repeating. */
export declare const REPEAT_WINDOW: number;
export declare const REPEAT_WARN_AT: number;
export declare function repeatKey(name: string, args: string, content: string): string;
export interface RepeatGuard {
  note(name: string, args: string, content: string): { count: number; warning: string | null; stop: boolean };
}
export declare function createRepeatGuard(options?: { maxRepeats?: number | null }): RepeatGuard;
export declare class RepeatedToolCallError extends Error {
  constructor(name: string, args: string, count: number);
}
