/** Assignment titles identify agents without exposing their instruction briefs. */
export function subAgentTitle(run: { title?: string }): string {
  return run.title?.trim().replace(/\s+/g, ' ').slice(0, 240) || 'Agent assignment';
}
