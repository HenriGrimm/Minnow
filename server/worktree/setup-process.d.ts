import type { ChildProcess } from 'node:child_process';
export function runWorktreeSetupProcess(command: string, args: string[], options?: {
  cwd?: string; timeout?: number; env?: Record<string, string>; shell?: boolean; signal?: AbortSignal;
  onSpawn?: (child: ChildProcess) => void; killTree?: (child: ChildProcess) => void;
  onStdout?: (text: string) => void; onStderr?: (text: string) => void;
}): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; accumulationTruncated?: boolean }>;
