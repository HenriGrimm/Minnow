export interface ProviderUsageMetric {
  label: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit: string;
  resetsAt?: string;
}
export interface ProviderAccountUsage {
  status: 'available' | 'unsupported' | 'unavailable';
  checkedAt: string;
  metrics: ProviderUsageMetric[];
}
const cache = new Map<string, { at: number; value: ProviderAccountUsage }>();
const pending = new Map<string, Promise<ProviderAccountUsage>>();
export function hasProviderUsage(value: ProviderAccountUsage | null): boolean {
  return value?.status === 'available' && value.metrics.some(metric =>
    [metric.used, metric.remaining, metric.limit].some(number => typeof number === 'number' && Number.isFinite(number)));
}
/** Same-origin session authentication only; provider credentials never reach the renderer. */
export function fetchProviderAccountUsage(id: string, force = false): Promise<ProviderAccountUsage> {
  const running = pending.get(id);
  if (running) return running;
  const entry = cache.get(id);
  if (!force && entry && Date.now() - entry.at < 60_000) return Promise.resolve(entry.value);
  const request = (async (): Promise<ProviderAccountUsage> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let value: ProviderAccountUsage;
    try {
      const response = await fetch('/api/providers/' + encodeURIComponent(id) + '/usage', {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Usage unavailable');
      const body = await response.json() as ProviderAccountUsage;
      if (!['available', 'unsupported', 'unavailable'].includes(body.status)
        || !Array.isArray(body.metrics) || !Number.isFinite(Date.parse(body.checkedAt))) throw new Error('Invalid usage');
      value = { status: body.status, checkedAt: body.checkedAt, metrics: body.status === 'available'
        ? body.metrics.filter(metric => typeof metric.label === 'string' && typeof metric.unit === 'string')
        : [] };
    } catch {
      value = { status: 'unavailable', checkedAt: new Date().toISOString(), metrics: [] };
    } finally { clearTimeout(timeout); }
    cache.set(id, { at: Date.now(), value });
    return value;
  })();
  pending.set(id, request);
  void request.finally(() => pending.delete(id));
  return request;
}
