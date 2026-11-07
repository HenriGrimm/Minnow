/** Availability is an enforcement contract, not a CLI feature/version check. */
export function agentCliNativeCodingCapability(kind, { platform = process.platform, version, installed = true } = {}) {
  const available = kind === 'codex' && platform === 'win32' && installed && /^(?:codex-cli\s+)?0\.166\.0(?:\s|$)/.test(version ?? '');
  return {
    available,
    effective: 'minnow',
    reason: kind === 'codex'
      ? available ? 'Limited experiment: gpt-5.5, a Git checkout and Full permission for equivalent coding tools are required. Network and native escalation stay off; Plan native actions stay read-only. Unsupported policy or recovery fails explicitly.'
        : 'Codex native coding tools require the verified Windows Codex CLI 0.166.0. Other configurations use Minnow tools unless a native-only request was already admitted.'
      : 'Native coding tools are not supported by this Minnow CLI adapter. Use Minnow tools.',
  };
}

/** Fail before process creation, including profiles not loaded through Settings. */
export function assertMinnowToolMode(settings) {
  if (settings?.nativeCodingTools !== undefined && settings.nativeCodingTools !== false) {
    throw Object.assign(new Error('Codex native coding tools require private server execution admission; this request has none.'), { cliPolicyRejected: true });
  }
}

// A matching native digest proves integrity, not that effects are safe to replay.
const MINNOW_CODEX_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall', 'functionCallOutput']);
export const isMinnowCodexItem = item => MINNOW_CODEX_ITEMS.has(item?.type);
export function hasUnsupportedCodexHistory(thread) {
  return Array.isArray(thread?.turns) && thread.turns.some(turn => !turn || typeof turn !== 'object'
    || turn.items !== undefined && (!Array.isArray(turn.items) || turn.items.some(item => !isMinnowCodexItem(item))));
}
