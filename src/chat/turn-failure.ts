import { CLAUDE_CODE_CLI_ID, CODEX_CLI_ID, CURSOR_AGENT_CLI_ID } from '../models/runtime-ids.mjs';
import type { ChatExecutionFailure } from '../../server/chats/activity';
import type { AgentCliKind } from '../models/agent-clis';

/**
 * One plain-language reading of a failed turn, shared by the managed failure
 * card and the legacy error bubble. Pure: no DOM, no network, no clock unless passed.
 */
export type TurnFailureKind =
  | 'signed_out'
  | 'api_key'
  | 'usage_limit'
  | 'rate_limit'
  | 'unreachable'
  | 'model_unavailable'
  | 'context_limit'
  | 'timeout'
  | 'generic';

export interface TurnFailureInput {
  /** Sanitized provider/runner reason (`agentExecution.error` or the stream error). */
  message?: string | null;
  failure?: ChatExecutionFailure | null;
  /** Provider that ran the turn (resolved model first, then the chat's selection). */
  providerId?: string | null;
  /** Human name for that provider or model, when the caller knows one. */
  providerLabel?: string | null;
  now?: number;
}

export interface TurnFailureView {
  kind: TurnFailureKind;
  title: string;
  body: string;
  /** Raw reason for the Details disclosure; omitted when it adds nothing. */
  detail?: string;
  /** Present for subscription CLIs whose login can be renewed inline. */
  signIn?: { kind: AgentCliKind; label: string };
  /** When the allowance or cooldown is expected to lift (epoch ms). */
  availableAt?: number;
  /** Where the user fixes configuration outside the chat. */
  settings?: 'providers' | 'clis';
}

const CLI_KINDS: Record<string, { kind: AgentCliKind; label: string }> = {
  [CLAUDE_CODE_CLI_ID]: { kind: 'claude', label: 'Claude Code' },
  [CODEX_CLI_ID]: { kind: 'codex', label: 'Codex' },
  [CURSOR_AGENT_CLI_ID]: { kind: 'cursor', label: 'Cursor' },
};

const AUTH_RE = /unauthori[sz]ed|unauthenticated|not (?:logged|signed) in|log ?in required|login required|please (?:log|sign) ?in|(?:session|token|credentials?|login) (?:has )?expired|authentication (?:failed|required|error)|invalid (?:api[ _-]?key|x-api-key|token|credentials?)|incorrect api key|\bHTTP 40[13]\b|\(auth\)|\b401\b/i;
const USAGE_RE = /out of usage|usage limit|hit your (?:usage |session |weekly )?limit|quota exceeded|exceeded your current quota|insufficient[_ ](?:quota|credits?)|out of credits|credit balance is too low|billing hard limit|spend(?:ing)? limit|plan limit reached|upgrade your plan|HTTP 402|payment required/i;
const RATE_RE = /rate.?limit|too many requests|\bHTTP 429\b|\b429\b|overloaded|server is busy|capacity/i;
const UNREACHABLE_RE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|fetch failed|network ?error|socket hang up|could not (?:reach|connect)|connection (?:refused|reset|closed)|provider (?:is )?unreachable|\bHTTP 50[0234]\b|\bHTTP 529\b|endpoint.*unavailable|temporarily unavailable/i;
const MODEL_RE = /model[^.]{0,60}(?:not found|not available|unavailable|does not exist|not supported|isn'?t supported)|unknown model|no such model|model_not_found|HTTP 400 \(bad request \/ model not found\)|no models? (?:loaded|available)/i;
const CONTEXT_RE = /context (?:length|window|budget)|maximum context|too many tokens|prompt is too long|input is too long|reduce the length|context_length_exceeded|exceeds? the (?:model'?s )?(?:context|token) limit/i;
const TIMEOUT_RE = /\btimed? ?out\b|timeout|deadline exceeded/i;

const KEEP = 'Your message and any finished work are kept.';

/** Strip CLI prefixes we add server-side so the detail reads as the provider's own words. */
function cleanDetail(message: string): string {
  return message
    .replace(/^Agent CLI authentication failed\. Sign in from Models → Subscriptions\.\s*/i, '')
    .replace(/^(?:Out of usage|Rate limited|Provider temporarily unavailable)\. Retry after \S+\.\s*/i, '')
    .trim();
}

/** `today at 4:00 PM`, `tomorrow at 9:15 AM`, or `Tue, Nov 24 at 4:00 PM`. */
export function formatAvailableAt(at: number, now = Date.now()): string {
  const target = new Date(at);
  const time = target.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(target) - startOfDay(new Date(now))) / 86_400_000);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  const date = target.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${date} at ${time}`;
}

/** `in 3 minutes` / `in about 2 hours` — short horizons read better than a clock time. */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

function availability(at: number | undefined, now: number): string {
  if (!at || at <= now) return '';
  return at - now < 90 * 60_000 ? formatWait(at - now) : formatAvailableAt(at, now);
}

export function classifyTurnFailure(input: TurnFailureInput): TurnFailureView {
  const now = input.now ?? Date.now();
  const message = (input.message ?? '').trim();
  const failure = input.failure ?? {};
  const providerId = failure.providerId ?? input.providerId ?? '';
  const cli = CLI_KINDS[providerId];
  const name = cli?.label ?? input.providerLabel?.trim() ?? '';
  const detail = cleanDetail(message) || undefined;
  const status = failure.status;
  const availableAt = failure.resetAt ?? failure.retryAt;

  const quota = failure.kind === 'quota' || failure.quotaExceeded === true || (!failure.kind && USAGE_RE.test(message));
  if (quota) {
    const when = availability(availableAt, now);
    return {
      kind: 'usage_limit',
      title: name ? `You’re out of usage on ${name}` : 'You’re out of usage',
      body: when
        ? `Your plan’s allowance resets ${when}. Retry then, or switch to another model below. ${KEEP}`
        : `Your plan’s allowance is used up for now. Retry once it resets, or switch to another model below. ${KEEP}`,
      detail,
      ...(availableAt && availableAt > now ? { availableAt } : {}),
      ...(cli ? { settings: 'clis' as const } : {}),
    };
  }

  const auth = status === 401 || status === 403 || AUTH_RE.test(message);
  if (auth && cli) {
    return {
      kind: 'signed_out',
      title: `You’re signed out of ${cli.label}`,
      body: `Sign back in to your ${cli.label} account to keep going. ${KEEP}`,
      detail,
      signIn: cli,
      settings: 'clis',
    };
  }
  if (auth) {
    return {
      kind: 'api_key',
      title: name ? `${name} didn’t accept your credentials` : 'The provider didn’t accept your credentials',
      body: `Check the API key in Models → Providers, then retry. ${KEEP}`,
      detail,
      settings: 'providers',
    };
  }

  if (failure.kind === 'rate_limit' || (!failure.kind && RATE_RE.test(message))) {
    const when = availability(failure.retryAt ?? failure.resetAt, now);
    return {
      kind: 'rate_limit',
      title: name ? `${name} is busy right now` : 'The provider is busy right now',
      body: `Too many requests went through at once. ${when ? `It should clear ${when}.` : 'Wait a moment, then retry.'} ${KEEP}`,
      detail,
      ...(availableAt && availableAt > now ? { availableAt } : {}),
    };
  }

  if (failure.kind === 'unavailable' || failure.providerUnreachable === true || UNREACHABLE_RE.test(message)) {
    return {
      kind: 'unreachable',
      title: name ? `Couldn’t reach ${name}` : 'Couldn’t reach the model provider',
      body: cli
        ? `Check your internet connection, then retry. ${KEEP}`
        : `Make sure the provider is running and reachable, then retry. ${KEEP}`,
      detail,
      ...(cli ? {} : { settings: 'providers' as const }),
    };
  }

  if (CONTEXT_RE.test(message)) {
    return {
      kind: 'context_limit',
      title: 'This conversation is too long for the model',
      body: 'The model can’t fit the whole conversation. Run /compact or start a new chat, then retry.',
      detail,
    };
  }

  if (MODEL_RE.test(message) || status === 404) {
    return {
      kind: 'model_unavailable',
      title: 'This model isn’t available',
      body: `Pick another model below, then retry. ${KEEP}`,
      detail,
    };
  }

  if (failure.outcome === 'timeout' || TIMEOUT_RE.test(message)) {
    return {
      kind: 'timeout',
      title: 'The turn ran out of time',
      body: `It hit the time limit before finishing. Continue to pick up where it stopped. ${KEEP}`,
      detail,
    };
  }

  return {
    kind: 'generic',
    title: 'This turn didn’t finish',
    body: `Something went wrong before the reply was complete. ${KEEP}`,
    detail,
  };
}
