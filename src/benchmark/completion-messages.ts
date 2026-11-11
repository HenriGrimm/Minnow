/**
 * Benchmark completion message helpers.
 */

import { apiMessageContentToText } from '../api/message-content.ts';
import type { ApiMessage } from '../types.ts';

export interface ApplyBenchmarkSystemPromptOptions {
  /** Optional extra system line merged into the first system message. */
  extraSystem?: string;
}

/**
 * Merge optional extra system text into messages. No default benchmark preamble —
 * capability probes use their own task-specific instructions.
 */
export function applyBenchmarkSystemPrompt(
  messages: ApiMessage[],
  options: ApplyBenchmarkSystemPromptOptions = {},
): ApiMessage[] {
  const extra = options.extraSystem?.trim();
  if (!extra) {
    return messages.map((m) => ({ ...m }));
  }

  const out = messages.map((m) => ({ ...m }));
  const systemIdx = out.findIndex((m) => m.role === 'system');
  if (systemIdx >= 0) {
    const existing = apiMessageContentToText(out[systemIdx]!.content);
    out[systemIdx] = {
      role: 'system',
      content: existing ? `${extra}\n\n${existing}` : extra,
    };
    return out;
  }

  out.unshift({ role: 'system', content: extra });
  return out;
}
