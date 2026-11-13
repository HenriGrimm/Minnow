export type DevTool = 'github' | 'claude' | 'codex' | 'cursor';

/** Navigation cancels observation, not the host-owned installation. Retry rejoins it. */
export async function installDevTool(tool: DevTool, signal: AbortSignal, onProgress: (message: string) => void = () => {}): Promise<void> {
  let method = 'POST';
  while (!signal.aborted) {
    const response = await fetch(`/api/system/dev-tools/${tool}`, {
      method, cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    const job = await response.json() as { state: string; message: string; error: string | null };
    if (!response.ok || job.state === 'error') throw new Error(job.error || 'Could not set up tools. Retry here.');
    onProgress(job.message);
    if (job.state === 'ready') return;
    if (job.state !== 'running') throw new Error('Tool setup was interrupted. Retry here.');
    method = 'GET';
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  signal.throwIfAborted();
}
