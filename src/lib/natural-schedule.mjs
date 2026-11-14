/**
 * Plain-words schedules for Automations: "every weekday at 9am", "every 5 minutes",
 * "mondays at 8", "daily at 6pm", or a raw five-field cron. Produces the
 * scheduler's { kind, value } shape plus a sentence to show back to the person.
 *
 * Pure: the server still validates every schedule and computes the next run.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const DAY_ALIASES = new Map([
  ['sun', 0], ['mon', 1], ['tue', 2], ['tues', 2], ['wed', 3], ['thu', 4], ['thur', 4], ['thurs', 4], ['fri', 5], ['sat', 6],
]);
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };

/** @param {string} word */
function dayIndex(word) {
  const w = word.toLowerCase().replace(/s$/, '');
  const full = DAY_NAMES.indexOf(w);
  if (full >= 0) return full;
  return DAY_ALIASES.get(w) ?? -1;
}

/** @param {number} hour @param {number} minute */
export function formatClock(hour, minute) {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** @param {number} ms */
function describeInterval(ms) {
  if (ms % UNIT_MS.h === 0) {
    const n = ms / UNIT_MS.h;
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }
  if (ms % UNIT_MS.m === 0) {
    const n = ms / UNIT_MS.m;
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }
  return `Every ${ms / 1000} seconds`;
}

/** Normalize a duration to the scheduler's interval syntax (largest exact unit). */
function intervalValue(ms) {
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`;
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`;
  return `${ms / 1000}s`;
}

/**
 * Parse a clock phrase. Accepts 9, 9am, 9:30, 9:30pm, 14:00, noon, midnight.
 * @param {string} text
 * @returns {{ hour: number; minute: number } | null}
 */
function parseClock(text) {
  if (/\bnoon\b/.test(text)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(text)) return { hour: 0, minute: 0 };
  const match = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s|$|,|\.)/.exec(text.replace(/\bat\b/g, ' at'));
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.replace(/\./g, '');
  if (minute > 59 || hour > 23) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (/\b(evening|night|tonight)\b/.test(text) && hour >= 5 && hour < 12) {
    hour += 12;
  }
  return { hour, minute };
}

/**
 * Describe a five-field cron when it is one of the shapes this parser writes.
 * Returns null for anything else so callers can fall back to the raw expression.
 * @param {string} expression
 */
export function describeSimpleCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== '*' || mon !== '*') return null;
  const clock = formatClock(Number(hour), Number(min));
  if (dow === '*') return `Daily at ${clock}`;
  if (dow === '1-5') return `Weekdays at ${clock}`;
  if (dow === '0,6' || dow === '6,0') return `Weekends at ${clock}`;
  const days = dow.split(',').map(Number);
  if (days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    const labels = days.map((d) => DAY_LABELS[d]);
    const joined = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];
    return `${joined} at ${clock}`;
  }
  return null;
}

/**
 * @param {string} input
 * @returns {{ ok: true; schedule: { kind: 'interval' | 'cron' | 'manual'; value: string }; description: string } | { ok: false; error: string }}
 */
export function parseNaturalSchedule(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Say when it should run, like “every weekday at 9am”.' };
  const text = raw.toLowerCase().replace(/\s+/g, ' ');

  if (/^(manual(ly)?|never|only when i run it|on demand)$/.test(text)) {
    return { ok: true, schedule: { kind: 'manual', value: 'manual' }, description: 'Only when you run it' };
  }

  // Raw cron passes through; the server validates the fields.
  if (/^[\d*/,-]+( [\d*/,a-z-]+){4}$/.test(text) && text.split(' ').length === 5) {
    return { ok: true, schedule: { kind: 'cron', value: raw.trim() }, description: describeSimpleCron(raw) ?? `Cron ${raw.trim()}` };
  }

  // Shorthand intervals: 5m, 2h, 90s.
  const short = /^(\d+)\s*(s|m|h)$/.exec(text);
  if (short) return intervalResult(Number(short[1]) * UNIT_MS[/** @type {'s'|'m'|'h'} */ (short[2])]);

  if (/^(hourly|every hour)$/.test(text)) return intervalResult(UNIT_MS.h);
  if (/^every minute$/.test(text)) return intervalResult(UNIT_MS.m);
  const every = /^every (\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)$/.exec(text);
  if (every) {
    const unit = every[2].startsWith('s') ? 's' : every[2].startsWith('h') ? 'h' : 'm';
    return intervalResult(Number(every[1]) * UNIT_MS[unit]);
  }

  // Calendar phrases: a day set plus an optional clock (default 9:00 AM).
  let dow = null;
  if (/\b(weekdays?|every weekday|working days?|business days?)\b/.test(text)) dow = '1-5';
  else if (/\b(weekends?)\b/.test(text)) dow = '0,6';
  else {
    const days = [...text.matchAll(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day)?s?\b/g)]
      .map((m) => dayIndex(m[1] + (m[2] ?? '')))
      .filter((d) => d >= 0);
    if (days.length) dow = [...new Set(days)].sort((a, b) => a - b).join(',');
  }
  const daily = /\b(daily|every day|each day|every night|nightly|every morning|every evening|each morning)\b/.test(text);
  const weeklyOnly = /\b(weekly|every week)\b/.test(text);
  if (!dow && !daily && !weeklyOnly && !/\bat\b/.test(text)) {
    return { ok: false, error: 'Try “every 5 minutes”, “daily at 6pm”, “weekdays at 9am” or a cron expression.' };
  }
  const clock = parseClock(text) ?? (/\b(night|nightly)\b/.test(text) ? { hour: 2, minute: 0 } : { hour: 9, minute: 0 });
  if (!dow) dow = weeklyOnly ? '1' : '*';
  const value = `${clock.minute} ${clock.hour} * * ${dow}`;
  return { ok: true, schedule: { kind: 'cron', value }, description: describeSimpleCron(value) ?? `Cron ${value}` };
}

/** @param {number} ms */
function intervalResult(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return { ok: false, error: 'The interval must be a positive number.' };
  if (ms < UNIT_MS.m) return { ok: false, error: 'Automations run at most once a minute.' };
  return { ok: true, schedule: { kind: 'interval', value: intervalValue(ms) }, description: describeInterval(ms) };
}

/**
 * A sentence for any stored schedule, falling back to the raw value.
 * @param {{ kind: string; value: string }} schedule
 */
export function describeAnySchedule(schedule) {
  if (!schedule) return '';
  if (schedule.kind === 'manual') return 'Only when you run it';
  if (schedule.kind === 'interval') {
    const parsed = parseNaturalSchedule(schedule.value);
    return parsed.ok ? parsed.description : `Every ${schedule.value}`;
  }
  return describeSimpleCron(schedule.value) ?? `Cron ${schedule.value}`;
}
