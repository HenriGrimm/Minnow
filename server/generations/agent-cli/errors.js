/** Keep credentials out of provider errors even when a CLI echoes configuration. */
export function safeAgentCliDiagnostic(value, secrets = []) {
  let text = String(value ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length > 3) text = text.split(secret).join('[redacted]');
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/gi, '[redacted]')
    .replace(/((?:token|api[_-]?key|authorization|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').slice(-2000).trim();
}

/** Protocol errors, including exit-zero auth failures, take priority over a process exit code. */
export function classifyAgentCliFailure({ error, terminal, exitCode, stderr = '' }) {
  const message = terminal?.error || error?.message || stderr || `Agent CLI exited with code ${exitCode ?? 'unknown'} without a completion event.`;
  if (error?.code === 'ENOENT') return { kind: 'fatal', message: 'Agent CLI executable was not found. Check its path in Models → CLIs.' };
  if (terminal?.ok === true && !error) return null;
  if (/unauthori[sz]ed|unauthenticated|not (?:logged|signed) in|authentication|invalid.*(?:key|token)|login required|401|403/i.test(message)) {
    return { kind: 'fatal', message: `Agent CLI authentication failed. Sign in from Models → CLIs. ${message}` };
  }
  if (/429|rate.?limit|overloaded|503|502|temporar|ECONNRESET|ETIMEDOUT/i.test(message)) return { kind: 'retryable', message };
  return { kind: 'fatal', message };
}
