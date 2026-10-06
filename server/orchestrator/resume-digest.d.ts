import type { Attempt, TaskState } from './core/types';

/** Format a digest for the attempts a `continue` resumes, oldest first. Empty when there is nothing to say. */
export function formatResumeDigest(
  chain: Array<{
    attemptId: string;
    outcome: string | null;
    summary?: string | null;
    events: Record<string, unknown>[];
  }>,
): string;

/** The run of interrupted builder attempts at the end of a task, oldest first. */
export function resumeChain(task: TaskState): Attempt[];

/** Read the chain's transcripts and format the digest. Never throws. */
export function loadResumeDigest(boardId: string, task: TaskState): Promise<string>;
