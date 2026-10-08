import type { ReefApp, ReefExport } from './types';
export async function reefRequest<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/reef/${route}`, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Reef request failed (${response.status})`);
  return data as T;
}
export const listReefApps = () => reefRequest<ReefApp[]>('apps');
export const getReefApp = (id: string) => reefRequest<ReefApp & { workspacePath: string }>(`apps/${id}`);
export const createReefApp = (input: { prompt: string; providerId?: string; modelId?: string }) => reefRequest<ReefApp>('apps', 'POST', input);
export const exportReefApp = (id: string, input: unknown) => reefRequest<ReefExport>(`apps/${id}/exports`, 'POST', input);

/** Streaming fetch inherits Minnow's authenticated fetch wrapper. */
export function subscribeReef(id: string, changed: () => void): () => void {
  const controller = new AbortController();
  let cursor = 0;
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`/api/reef/apps/${id}/events?after=${cursor}`, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('Event stream unavailable');
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const match = /^id: (\d+)$/m.exec(event); if (match) cursor = Number(match[1]);
            if (event.includes('data:')) changed();
          }
        }
      } catch { if (controller.signal.aborted) return; }
      await new Promise<void>(resolve => {
        const abort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, 2000);
        controller.signal.addEventListener('abort', abort, { once: true });
      });
    }
  })();
  return () => controller.abort();
}
