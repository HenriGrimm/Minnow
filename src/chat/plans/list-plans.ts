import { executeTool } from '../../tools/client';
import { isLocalServerAvailable } from '../../tools/config';
import { isOrchestratePlanPickerEntry } from './plan-path';
import { readWorkspaceTextFile } from '../../attachments/workspace-text-read';
import { readPlanType } from '../../../server/orchestrator/core/plan-format.js';

export type PlanDiscoverError = 'server_off' | 'no_plans_dir' | string;

export interface DiscoverOrchestratePlansResult {
  plans: string[];
  /** Present when listing failed or server is unavailable (UI maps to hints). */
  error?: PlanDiscoverError;
}

/**
 * Maps raw find_files errors to stable codes the UI can phrase briefly.
 */
export function normalizePlanDiscoverError(raw: string): PlanDiscoverError {
  const msg = raw.trim();
  if (!msg) return 'find_files failed';
  if (/ENOENT|no such file or directory/i.test(msg)) {
    return 'no_plans_dir';
  }
  return msg;
}

/**
 * Parses find_files tool stdout into relative file paths (drops truncation footer lines).
 */
export function parseFindFilesOutputPaths(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('Error:')) return [];
  if (trimmed.startsWith('No files matching')) return [];
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('(truncated'));
}

/**
 * Lists executable orchestrate plan paths via find_files when npm start is available.
 */
export async function discoverOrchestratePlans(): Promise<DiscoverOrchestratePlansResult> {
  if (!isLocalServerAvailable()) {
    return { plans: [], error: 'server_off' };
  }

  const raw = (await executeTool('find_files', {
    path: 'documentation/plans',
    pattern: '*.md',
  })).content;

  const content = typeof raw === 'string' ? raw : '';
  const trimmed = content.trim();
  if (trimmed.startsWith('Error:')) {
    const rawMsg = trimmed.replace(/^Error:\s*/i, '').trim() || 'find_files failed';
    return {
      plans: [],
      error: normalizePlanDiscoverError(rawMsg),
    };
  }

  const paths = parseFindFilesOutputPaths(content);
  const plans = (await filterBoardPlanPaths(paths.filter(isOrchestratePlanPickerEntry)))
    .sort((a, b) => {
      const baseA = a.split('/').pop() ?? a;
      const baseB = b.split('/').pop() ?? b;
      const byBase = baseA.localeCompare(baseB);
      if (byBase !== 0) return byBase;
      return a.localeCompare(b);
    });

  return { plans };
}

/** Bound file reads while excluding explicit Build plans and unreadable artifacts. */
export async function filterBoardPlanPaths(
  paths: string[],
  read: (path: string) => Promise<string> = readWorkspaceTextFile,
): Promise<string[]> {
  const plans: string[] = [];
  for (let offset = 0; offset < paths.length; offset += 8) {
    const batch = paths.slice(offset, offset + 8);
    const results = await Promise.allSettled(batch.map((path) => read(path)));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && readPlanType(result.value) === 'orchestrate') plans.push(batch[index]!);
    });
  }
  return plans;
}
