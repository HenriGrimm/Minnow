import type { TokenLedgerEntry } from './types';

export type UsageInterval = 'hour' | 'day' | 'week' | 'month' | 'year';
export interface UsageBucket {
  at: number;
  end: number;
  tokens: number;
  prompt: number;
  completion: number;
  count: number;
}

function floorTime(at: number, interval: UsageInterval): number {
  const date = new Date(at);
  date.setMinutes(0, 0, 0);
  if (interval !== 'hour') date.setHours(0);
  if (interval === 'week') date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  if (interval === 'month' || interval === 'year') date.setDate(1);
  if (interval === 'year') date.setMonth(0);
  return date.getTime();
}

function nextTime(at: number, interval: UsageInterval): number {
  if (interval === 'hour') return at + 3_600_000;
  const date = new Date(at);
  if (interval === 'day' || interval === 'week') date.setDate(date.getDate() + (interval === 'week' ? 7 : 1));
  if (interval === 'month') date.setMonth(date.getMonth() + 1);
  if (interval === 'year') date.setFullYear(date.getFullYear() + 1);
  return date.getTime();
}

const tokenCount = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, value!) : 0;

/** Calendar-aligned totals, including empty intervals so gaps stay visible. */
export function buildUsageTimeline(entries: TokenLedgerEntry[], days = 0, now = Date.now()) {
  const cutoff = days ? now - days * 86_400_000 : -Infinity;
  const history = entries.filter(entry => Number.isFinite(new Date(entry.at).getTime()) && entry.at >= cutoff && entry.at <= now)
    .sort((a, b) => a.at - b.at);
  const first = days ? cutoff : history[0]?.at;
  const last = days ? now : history.at(-1)?.at;
  if (first === undefined || last === undefined || !history.length) return { interval: 'day' as UsageInterval, buckets: [] as UsageBucket[] };
  const spanDays = (last - first) / 86_400_000;
  const interval: UsageInterval = spanDays <= 2 ? 'hour' : spanDays <= 60 ? 'day' : spanDays <= 365 ? 'week' : spanDays <= 1_825 ? 'month' : 'year';
  const buckets: UsageBucket[] = [];
  let index = 0;
  for (let at = floorTime(first, interval); at <= last; at = nextTime(at, interval)) {
    const end = nextTime(at, interval);
    const bucket: UsageBucket = { at, end, tokens: 0, prompt: 0, completion: 0, count: 0 };
    while (index < history.length && history[index]!.at < end) {
      const entry = history[index++]!;
      const prompt = tokenCount(entry.usage.prompt_tokens);
      const completion = tokenCount(entry.usage.completion_tokens);
      bucket.prompt += prompt;
      bucket.completion += completion;
      bucket.tokens += entry.usage.total_tokens == null ? prompt + completion : tokenCount(entry.usage.total_tokens);
      bucket.count++;
    }
    buckets.push(bucket);
  }
  return { interval, buckets };
}

export function usageAxisMaximum(maximum: number): number {
  if (maximum <= 0) return 4;
  const step = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const niceStep = [1, 1.5, 2, 2.5, 5, 10].find(value => value * magnitude >= step)! * magnitude;
  return niceStep * 4;
}
