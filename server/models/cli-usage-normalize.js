function text(value, fallback = null) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : fallback;
}

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function reset(value) {
  if (value == null) return null;
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function durationLabel(minutes) {
  if (minutes === 10080) return 'Weekly';
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour`;
  return minutes ? `${minutes}-minute` : 'Usage window';
}

export function normalizeCodexUsage(data, account) {
  const buckets = data?.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length
    ? Object.entries(data.rateLimitsByLimitId) : [['codex', data?.rateLimits]];
  const windows = [];
  for (const [id, bucket] of buckets.slice(0, 32)) {
    for (const name of ['primary', 'secondary']) {
      const row = bucket?.[name];
      if (percent(row?.usedPercent) == null) continue;
      const windowMinutes = typeof row.windowDurationMins === 'number'
        && Number.isFinite(row.windowDurationMins) && row.windowDurationMins > 0 ? row.windowDurationMins : null;
      const label = durationLabel(windowMinutes);
      windows.push({ id: `${id}:${name}`.slice(0, 160),
        label: id === 'codex' ? label : `${text(bucket.limitName, id)} · ${label}`,
        usedPercent: percent(row.usedPercent), windowMinutes, resetsAt: reset(row.resetsAt) });
    }
  }
  const credits = data?.rateLimits?.credits;
  return { windows, plan: text(account?.planType ?? data?.rateLimits?.planType),
    ...(credits && typeof credits.unlimited === 'boolean' ? { credits: {
      unlimited: credits.unlimited, balance: text(credits.balance),
    } } : {}) };
}

const CLAUDE_WINDOWS = {
  five_hour: ['5-hour', 300], seven_day: ['Weekly', 10080],
  seven_day_opus: ['Weekly · Opus', 10080], seven_day_sonnet: ['Weekly · Sonnet', 10080],
  seven_day_oauth_apps: ['Weekly · OAuth apps', 10080], seven_day_cowork: ['Weekly · Cowork', 10080],
};

export function normalizeClaudeUsage(data, plan) {
  const windows = [];
  for (const [id, [label, windowMinutes]] of Object.entries(CLAUDE_WINDOWS)) {
    const row = data?.[id];
    if (percent(row?.utilization) == null) continue;
    windows.push({ id, label, windowMinutes, usedPercent: percent(row.utilization), resetsAt: reset(row.resets_at) });
  }
  return { windows, plan: text(plan) };
}
