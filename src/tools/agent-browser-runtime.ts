import { withSessionToken } from '../api/session-token';

export interface AgentBrowserRuntimeOwner {
  chatId: string;
  runId: string;
  agentId: string;
}

interface GuideEvent {
  id: string;
  tabId: string;
  message: string;
  elementSummary?: string;
  url?: string;
}

const RUNTIME_REQUEST_TIMEOUT_MS = 5_000;

export interface AgentBrowserRuntimeHandle {
  owner: AgentBrowserRuntimeOwner;
  drainMessages(): Array<{ role: 'user'; content: string }>;
  drainText(): string;
  close(): Promise<void>;
}

function guideText(guide: GuideEvent): string {
  const lines = [
    `Guide from the user for agent browser tab ${guide.tabId}: ${guide.message}`,
  ];
  if (guide.elementSummary) lines.push(`Selected element: ${guide.elementSummary}`);
  if (guide.url) lines.push(`Page: ${guide.url}`);
  return lines.join('\n');
}

async function postJson(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
    signal: AbortSignal.timeout(RUNTIME_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Agent Browser runtime request failed (HTTP ${response.status})`);
  return response;
}

/** Register one exact foreground turn as the consumer for its owned agent tabs. */
export async function openAgentBrowserRuntime(
  owner: AgentBrowserRuntimeOwner,
): Promise<AgentBrowserRuntimeHandle | null> {
  if (typeof fetch !== 'function' || typeof EventSource === 'undefined') return null;
  let response: Response;
  try {
    response = await postJson('/api/browser-agent/runtime/register', { runtimeOwner: owner });
  } catch {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as { runtimeToken?: string } | null;
  const token = payload?.runtimeToken?.trim() ?? '';
  if (!token) return null;

  const queue: GuideEvent[] = [];
  const seen = new Set<string>();
  const pendingAcks = new Set<Promise<unknown>>();
  let closed = false;
  const source = new EventSource(
    withSessionToken(`/api/browser-agent/runtime/${encodeURIComponent(token)}/events`),
  );
  source.addEventListener('guide', (event) => {
    if (closed || !(event instanceof MessageEvent)) return;
    try {
      const guide = JSON.parse(event.data) as GuideEvent;
      if (!guide.id || seen.has(guide.id) || !guide.message?.trim()) return;
      seen.add(guide.id);
      queue.push(guide);
    } catch {
    }
  });

  const drainMessages = (): Array<{ role: 'user'; content: string }> =>
    queue.splice(0).map((guide) => {
      // Handing the row to the runner's transcript boundary is the delivery commit.
      const ack = postJson(`/api/browser-agent/runtime/${encodeURIComponent(token)}/ack`, {
        guideId: guide.id,
      });
      pendingAcks.add(ack);
      void ack.then(
        () => pendingAcks.delete(ack),
        () => pendingAcks.delete(ack),
      );
      return { role: 'user', content: guideText(guide) };
    });

  return {
    owner,
    drainMessages,
    drainText() {
      return drainMessages().map((row) => row.content).join('\n\n');
    },
    async close() {
      if (closed) return;
      closed = true;
      source.close();
      await Promise.allSettled([...pendingAcks]);
      try {
        await postJson(`/api/browser-agent/runtime/${encodeURIComponent(token)}/unregister`);
      } catch (firstError) {
        try {
          await postJson(`/api/browser-agent/runtime/${encodeURIComponent(token)}/unregister`);
        } catch {
          console.warn('[agent-browser] runtime unregister failed; the server will keep the exact lease until reassigned or shutdown', firstError);
        }
      }
    },
  };
}
