/**
 * Interval and cron next-run calculation for scheduled jobs.
 */

import { CronExpressionParser } from 'cron-parser';

/** Minimum interval between interval-kind jobs. */
export const MIN_INTERVAL_MS = 60_000;

const INTERVAL_RE = /^(\d+)(s|m|h)$/i;

/**
 * Parse interval strings like "60s", "5m", "2h" into milliseconds.
 * @param {string} value
 * @returns {number}
 */
export function parseInterval(value) {
  const raw = String(value ?? '').trim();
  const match = INTERVAL_RE.exec(raw);
  if (!match) {
    throw new Error('Interval must look like 60s, 5m, or 2h');
  }

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Interval amount must be a positive integer');
  }

  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000 };
  const ms = amount * multipliers[unit];
  if (ms < MIN_INTERVAL_MS) {
    throw new Error(`Interval must be at least ${MIN_INTERVAL_MS / 1000} seconds`);
  }
  return ms;
}

/**
 * Validate a five-field cron expression in the system local timezone.
 * @param {string} expression
 */
export function validateCronExpression(expression) {
  const raw = String(expression ?? '').trim();
  if (!raw) {
    throw new Error('Cron expression is required');
  }
  try {
    CronExpressionParser.parse(raw, { currentDate: new Date() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid cron expression: ${message}`);
  }
}

/**
 * @param {{ kind: 'interval' | 'cron' | 'manual'; value: string }} schedule
 */
export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') {
    throw new Error('schedule is required');
  }
  const kind = String(schedule.kind ?? '').trim();
  const value = String(schedule.value ?? '').trim();
  if (kind === 'manual') {
    // Manual automations never run on their own; Run now starts them.
    return { kind, value: 'manual' };
  }
  if (kind !== 'interval' && kind !== 'cron') {
    throw new Error('schedule.kind must be interval, cron or manual');
  }
  if (!value) {
    throw new Error('schedule.value is required');
  }
  if (kind === 'interval') {
    parseInterval(value);
  } else {
    validateCronExpression(value);
  }
  return { kind, value };
}

/**
 * Compute the next ISO run timestamp from now (no backfill of missed runs).
 * @param {{ schedule: { kind: 'interval' | 'cron'; value: string }; lastRunAt?: string }} job
 * @param {Date} [now]
 * @returns {string | undefined} undefined for manual schedules
 */
export function computeNextRun(job, now = new Date()) {
  const schedule = validateSchedule(job.schedule);
  if (schedule.kind === 'manual') {
    return undefined;
  }
  if (schedule.kind === 'interval') {
    const ms = parseInterval(schedule.value);
    return new Date(now.getTime() + ms).toISOString();
  }

  const interval = CronExpressionParser.parse(schedule.value, {
    currentDate: now,
  });
  return interval.next().toDate().toISOString();
}
