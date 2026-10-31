import type { SharedChatFrame } from './shared-chat-protocol';

export type ChatPublication = Omit<SharedChatFrame, 'hostId' | 'sequence'>;
export interface ChatPublicationResult { ok: boolean; status?: number; error?: string }

/** Publications from the same scheduler pass share a request; each retains its acknowledgement. */
export function createChatPublicationBatch(send: (frames: ChatPublication[]) => Promise<void | ChatPublicationResult[]>) {
  let queued: { frame: ChatPublication; resolve: () => void; reject: (error: unknown) => void }[] = [];
  return (frame: ChatPublication): Promise<void> => new Promise((resolve, reject) => {
    queued.push({ frame, resolve, reject });
    if (queued.length !== 1) return;
    queueMicrotask(() => {
      const batch = queued;
      queued = [];
      void Promise.resolve().then(() => send(batch.map(row => row.frame))).then(
        results => batch.forEach((row, index) => {
          if (results && !results[index]?.ok) row.reject(new Error(results[index]?.error ?? 'Chat publication was not acknowledged.'));
          else row.resolve();
        }),
        error => batch.forEach(row => row.reject(error)),
      );
    });
  });
}

/** Keep aggregate requests below the server's 16 MiB limit, even for non-ASCII transcripts. */
export function serializeChatPublicationBatches(hostId: string, frames: ChatPublication[]): { body: string; count: number }[] {
  const batches: { body: string; count: number }[] = [];
  let rows: string[] = [];
  let length = 0;
  const flush = () => {
    if (!rows.length) return;
    batches.push({ body: `{"hostId":${JSON.stringify(hostId)},"frames":[${rows.join(',')}]}`, count: rows.length });
    rows = []; length = 0;
  };
  for (const frame of frames) {
    const row = JSON.stringify(frame);
    // A single frame retains the previous per-request limit; large frames never aggregate.
    if (rows.length && (length + row.length > 2 * 1024 * 1024 || rows.length >= 64)) flush();
    rows.push(row); length += row.length;
  }
  flush();
  return batches;
}
