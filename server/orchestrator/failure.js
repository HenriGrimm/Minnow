/** Normalize operational failures at the board boundary. Never infer a code pass. */
import { createHash, randomInt } from 'node:crypto';
import { allowanceFailure, isQuotaExhaustedText } from '../generations/quota-error.js';
import { redactDiagnosticText } from '../diagnostics/redact.js';
import { normalizePrerequisites } from './prerequisites.js';

export function rejectedOptionalField(message) {
  if (!/unknown|unsupported|unrecognized|unexpected|extra.*not permitted/i.test(message)) return null;
  return /\b(thinking|enable_thinking|reasoning_effort|reasoning|chat_template_kwargs)\b/i.exec(message)?.[1]?.toLowerCase() ?? null;
}

export function boardFailure(input = {}, now = Date.now()) {
  const evidence = input.evidence ?? {};
  const supplied = input.failure ?? evidence.failure ?? {};
  const detail = String(input.message ?? input.error ?? input.summary ?? evidence.error ?? input.outcome ?? 'Unknown failure');
  const needs = input.outcome === 'blocked' && Array.isArray(evidence.needs) ? evidence.needs.filter((need) => typeof need === 'string').slice(0, 8).join('; ') : '';
  const message = redactDiagnosticText(needs ? `${detail}: ${needs}` : detail, 3000);
  const status = Number(supplied.status ?? input.status ?? /(?:Upstream\s+)?HTTP\s+(\d{3})\b/i.exec(message)?.[1]) || undefined;
  const allowance = allowanceFailure(message, { ...input, ...supplied, status, now });
  let category = supplied.category;
  if (!['quota', 'rate_limit', 'unavailable', 'capacity', 'context', 'authentication', 'prerequisite', 'environment', 'protocol', 'interrupted', 'implementation', 'verification', 'unknown'].includes(category)) {
    if (supplied.kind === 'quota' || input.quotaExceeded || isQuotaExhaustedText(message)) category = 'quota';
    else if (supplied.kind === 'rate_limit' || allowance?.kind === 'rate_limit') category = 'rate_limit';
    else if (/memory.*(?:limit|budget)|GENERATION_MEMORY_LIMIT/i.test(message)) category = status === 413 || (!status && /single|request.*(?:large|exceed)|context/i.test(message)) ? 'context' : 'capacity';
    else if (/process limit|cli.*(?:limit|capacity)|too many.*process/i.test(message)) category = 'capacity';
    else if (supplied.kind === 'unavailable' || allowance?.kind === 'unavailable') category = 'unavailable';
    else if (status === 401 || /expired.*(?:login|auth)|not authenticated|authentication required|please.*(?:log|sign) in/i.test(message)) category = 'authentication';
    else if (/ENOENT|executable.*(?:missing|not found)|command not found|no model bound/i.test(message)) category = 'prerequisite';
    else if ([408, 425, 429, 500, 502, 503, 504, 529].includes(status) || evidence.providerUnreachable || /ECONN|fetch failed|endpoint.*unavailable|socket hang up/i.test(message)) category = status === 429 ? 'rate_limit' : 'unavailable';
    else if (/unknown.*(?:field|parameter)|unsupported.*(?:field|parameter)/i.test(message)) category = 'protocol';
    else if (input.outcome === 'blocked' && /node_modules|cannot find module|missing.*(?:npm|pip|project dependency)|dependencies.*not installed/i.test(`${message} ${JSON.stringify(evidence.needs ?? [])}`)) category = 'environment';
    else if (input.outcome === 'blocked') category = 'prerequisite';
    else if (input.outcome === 'fail') category = 'implementation';
    else if (evidence.interrupted || ['timeout', 'no_report'].includes(input.outcome) || /process.*no longer|aborted/i.test(message)) category = 'interrupted';
    else category = 'unknown';
  }
  const resetAt = Number(supplied.resetAt ?? allowance?.resetAt);
  const retryAt = Number(supplied.retryAt ?? input.retryAt);
  const retryAfterMs = Number(supplied.retryAfterMs ?? allowance?.retryAfterMs);
  return {
    category, scope: supplied.scope ?? allowance?.scope ?? (['quota', 'authentication'].includes(category) ? 'provider' : 'task'),
    ...(now > 0 && ['unavailable', 'capacity', 'interrupted', 'context'].includes(category) ? { jitterMs: randomInt(0, 1001) } : {}),
    message, ...(status ? { status } : {}),
    ...(Number.isFinite(resetAt) && resetAt > now ? { retryAt: resetAt } : Number.isFinite(retryAt) && retryAt > now ? { retryAt } : Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { retryAt: now + retryAfterMs } : {}),
    fingerprint: createHash('sha256').update(`${category}:${status ?? ''}:${message.replace(/\b[0-9a-f]{8,}\b|\b\d+\b/gi, '#')}`).digest('hex').slice(0, 24),
    ...(category === 'protocol' && rejectedOptionalField(message) ? { omitField: rejectedOptionalField(message) } : {}),
    ...(supplied.prerequisites?.length || evidence.prerequisites?.length ? { prerequisites: normalizePrerequisites(supplied.prerequisites ?? evidence.prerequisites) } : {}),
    ...(typeof supplied.identity === 'string' ? { identity: supplied.identity, providerId: supplied.providerId, modelId: supplied.modelId } : {}),
  };
}
