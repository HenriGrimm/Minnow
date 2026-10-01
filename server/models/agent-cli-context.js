/** Optional CLI context budget; omission keeps the installed model's defaults. */
export function agentCliContextWindowTokens(value) {
  return Number.isInteger(value) && value >= 1000 && value <= 1_000_000 ? value : null;
}

/** Claude extended context is available for Sonnet/Opus, never Haiku. */
export function supportsClaudeExtendedContext(model) {
  return /^(?:sonnet|opus)(?:\[1m\])?$|^claude-(?:sonnet|opus)-/i.test(model);
}

export function applyAgentCliContextWindow(rows, kind, value) {
  const tokens = agentCliContextWindowTokens(value);
  return rows.map((row) => {
    // Cursor has no native context control. Its advertised window stays the ceiling.
    const canExpand = kind === 'codex' || (kind === 'claude' && supportsClaudeExtendedContext(row.id));
    const known = Number(row.max_context_length);
    const context = !tokens ? known : canExpand ? tokens : Math.min(tokens, known > 0 ? known : 200_000);
    // Runtime catalog wins over a saved capability probe from an older CLI/config.
    return Number.isFinite(context) && context > 0
      ? { ...row, max_context_length: context, loaded_context_length: context } : row;
  });
}
