import type { TurnEvent } from '../../../server/runner/run-turn';
import { runtimeStatusFromStreamMetaRuntime } from '../turn-stream-meta';

export interface SuperPlanLiveTranscript {
  text: string;
  reasoning: string;
  phase: string;
  tool: string;
  detail: string;
}

const live = new Map<string, SuperPlanLiveTranscript>();
const listeners = new Set<(key: string) => void>();

export function getSuperPlanLiveTranscript(key: string): SuperPlanLiveTranscript | undefined {
  return live.get(key);
}

export function subscribeSuperPlanTranscript(listener: (key: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function clearSuperPlanLiveTranscript(key: string): void {
  live.delete(key);
  for (const listener of listeners) listener(key);
}

/** One current round per run; tokens never become individual activity rows. */
export function observeSuperPlanTranscript(key: string, event: TurnEvent): void {
  let value = live.get(key);
  if (!value || event.type === 'round_start' || event.type === 'response_restart') {
    value = { text: '', reasoning: '', phase: 'generating', tool: '', detail: '' };
    live.set(key, value);
  }
  if (event.type === 'delta') { value.text = event.text; value.phase = 'generating'; }
  else if (event.type === 'thinking') { value.reasoning = event.text; value.phase = 'thinking'; }
  else if (event.type === 'phase') value.phase = event.phase;
  else if (event.type === 'loading_model') value.phase = 'loading_model';
  else if (event.type === 'tool_call' || event.type === 'tool_streaming') { value.phase = 'tools'; value.tool = event.name; }
  else if (event.type === 'stream_meta') {
    const runtime = runtimeStatusFromStreamMetaRuntime(event.runtime, Boolean(value.text || value.reasoning));
    value.detail = runtime.detail;
    if (runtime.phase === 'prompt_processing') value.phase = runtime.phase;
  } else if (event.type === 'round_end') {
    value.text = ''; value.reasoning = ''; value.detail = ''; value.phase = 'generating';
  }
  for (const listener of listeners) listener(key);
}
