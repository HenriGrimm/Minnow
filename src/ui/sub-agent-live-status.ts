import type { SubAgentLivePhase } from '../agents/types';
import type { SubAgentRun } from '../agents/types';
import type { PersistedSubAgentRun } from '../types';
import { humanizeToolName } from './tool-messages';
import {
  STREAM_LABEL_GENERATING,
  STREAM_LABEL_THINKING,
} from './stream-status';

/** Terminal status label for persisted or settled runs. */
export function subAgentTerminalStatusLabel(status: string): string {
  if (status === 'completed') return 'Done';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Stopped';
  if (status === 'queued') return 'Queued';
  return status;
}

/** Short badge label while a run is in flight. */
export function subAgentLiveBadgeLabel(
  run: SubAgentRun | PersistedSubAgentRun,
  live: boolean,
): string {
  if (!live || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return subAgentTerminalStatusLabel(run.status);
  }
  if (run.status === 'queued') return 'Queued';
  const active = run as SubAgentRun;
  if (active.startError) return `Retrying (${active.startError.consecutive})`;
  if (active.livePhase === 'stopping') return 'Stopping';
  const tool = active.liveCurrentToolName?.trim();
  if (tool) return 'Calling tool';
  if (active.livePhase === 'thinking') return 'Thinking';
  if (active.livePhase === 'generating') return 'Generating';
  if (active.livePhase === 'tools') return 'Tools';
  return 'Working';
}

/** One-line activity hint for cards, footer, and structured summary fallback. */
export function subAgentLiveStatusLine(
  run: SubAgentRun | PersistedSubAgentRun,
  live: boolean,
): string {
  if (!live || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return '';
  }
  if (run.status === 'queued') return 'Queued — waiting for a concurrency slot…';
  const active = run as SubAgentRun;
  if (active.startError) {
    return `${active.startError.message} (${active.startError.consecutive})`;
  }
  if (active.livePhase === 'stopping') return 'Stopping…';
  const tool = active.liveCurrentToolName?.trim();
  if (tool) return `Calling ${humanizeToolName(tool)}…`;
  if (active.livePhase === 'thinking') return STREAM_LABEL_THINKING;
  if (active.livePhase === 'generating') return STREAM_LABEL_GENERATING;
  if (active.livePhase === 'tools') return 'Running tools…';
  return 'Working…';
}

/** Live tail options for transcript rendering. */
export interface SubAgentTranscriptLive {
  isLive: boolean;
  phase?: SubAgentLivePhase | null;
  currentToolName?: string | null;
  partialReasoning?: string;
  partialText?: string;
  /** Restore expanded Thoughts on a rare remount of the live toggle. */
  thoughtsExpanded?: boolean;
  onThoughtsExpandedChange?: (expanded: boolean) => void;
}

/** Build live tail props from a run snapshot. */
export function subAgentTranscriptLiveFromRun(
  run: SubAgentRun | PersistedSubAgentRun,
  live: boolean,
): SubAgentTranscriptLive | undefined {
  if (!live || run.status !== 'running') return undefined;
  const active = run as SubAgentRun;
  return {
    isLive: true,
    phase: active.livePhase ?? 'generating',
    currentToolName: active.liveCurrentToolName ?? null,
    partialReasoning: active.livePartialReasoning,
    partialText: active.livePartialText,
  };
}
