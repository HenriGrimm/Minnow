import { loadToolConfig } from './config';
import { resolveEffectivePermission } from './permission-resolve';
import { enqueueToolApproval } from './approval-queue';
import type { ExecuteToolContext } from './client';
import type { ToolExecutionResult } from '../types';

export async function executeApprovedImage(
  args: Record<string, unknown>, context: ExecuteToolContext,
  execute: (name: string, args: Record<string, unknown>, approval?: { approved: boolean; fingerprint: string }) => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  if (context.workAgentId) {
    const { getWorkAgent } = await import('../agents/work-agent-registry');
    const agent = getWorkAgent(context.workAgentId);
    if (!agent || agent.disabled || (agent.allowedTools && !agent.allowedTools.includes('generate_image'))) return { content: 'Error: This work agent cannot generate images' };
  }
  if (context.subAgentType) {
    const { getSubAgentTypeConfig } = await import('../agents/sub-agent-config');
    const agent = await getSubAgentTypeConfig(context.subAgentType);
    if (!agent || agent.deniedTools?.includes('generate_image') || (agent.allowedTools && !agent.allowedTools.includes('generate_image'))) return { content: 'Error: This sub-agent cannot generate images' };
  }
  const permission = resolveEffectivePermission(loadToolConfig(), 'generate_image', args, context).mode;
  if (permission === 'off') return { content: 'Error: Image generation is disabled in Settings → Tools' };
  if (!context.toolCallId) return { content: 'Error: Image generation requires a tool execution identity' };
  const info = await execute('image_generation_info', {});
  let binding: { status: string; fingerprint: string; binding: { providerId: string; modelId: string }; notice: string };
  try { binding = JSON.parse(info.content); } catch { return { content: 'Error: Image configuration unavailable' }; }
  if (binding.status !== 'Ready') return { content: 'Error: Configure Image generation in Models → Routing' };
  const companion = typeof document !== 'undefined' && document.documentElement.classList.contains('minnow-companion');
  if (permission !== 'full' || companion) {
    if (typeof document === 'undefined') return { content: 'Error: Unattended image generation requires Full permission' };
    const decision = await enqueueToolApproval({
      toolName: 'generate_image', title: `Generate image · ${binding.binding.providerId} / ${binding.binding.modelId}`,
      description: `${binding.notice} Destination: ${String(args.output_path ?? 'assets/generated/<job-id>.<format>')}. Reference uploads: ${JSON.stringify(args.reference_paths ?? [])}. Cancellation may not prevent upstream charges.`,
      argsJson: JSON.stringify(args, null, 2), signal: context.signal,
      workspace: context.workspaceRoot ? { label: context.workspaceRoot, path: context.workspaceRoot } : undefined,
    });
    if (decision === 'cancel') return { content: 'Error: User denied image generation' };
  }
  if (context.signal?.aborted) return { content: 'Error: Image generation canceled' };
  return execute('generate_image', args, { approved: true, fingerprint: binding.fingerprint });
}
