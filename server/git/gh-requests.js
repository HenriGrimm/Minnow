import { isGithubRateLimitError, githubRetryAt } from '../../src/lib/github-rate-limit.mjs';

const PR_READ_TTL_MS = 25_000;

/** Shared by all forge callers, including separate renderers and workspaces. */
export function createGhRequests({ run, now = Date.now }) {
  const reads = new Map();
  const cooldowns = new Map();
  const probes = new Map();
  let revision = 0;

  function invalidateReads() {
    revision += 1;
    reads.clear();
  }

  async function request(args, options = {}, hostname = 'github.com') {
    if (args[0] === '--version' || args[0] === 'auth') return run(args, options);
    const resource = args[0] === 'pr' || args[0] === 'issue' ||
      (args[0] === 'api' && args.includes('graphql')) ? 'graphql' : 'core';
    const budget = `${hostname}:${resource}`;
    const cooldown = cooldowns.get(budget);
    if (cooldown && now() < cooldown.until) return cooldown.result;

    const read = args[0] === 'pr' && ['list', 'view'].includes(args[1]);
    // Successful writes must invalidate lists/details even if an older read is still running.
    const mutation = args[0] === 'pr' && !['list', 'view', 'diff'].includes(args[1]);
    const key = JSON.stringify([hostname, args.includes('--repo') ? '' : options.cwd, args]);
    if (read) {
      for (const [cachedKey, value] of reads) {
        if (!value.pending && now() >= value.until) reads.delete(cachedKey);
      }
      if (reads.size >= 100) {
        const oldest = [...reads].find(([, value]) => !value.pending);
        if (oldest) reads.delete(oldest[0]);
      }
      const hit = reads.get(key);
      if (hit && (hit.pending || now() < hit.until)) return hit.promise;
    }

    const entry = { pending: true, until: 0, promise: null };
    const startedRevision = revision;
    entry.promise = (async () => {
      try {
        const result = await run(args, options);
        const message = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
        if (result.code !== 0 && isGithubRateLimitError(message)) {
          const active = cooldowns.get(budget);
          if (active && now() < active.until) return active.result;
          // gh's GraphQL errors omit the response headers. One REST lookup discovers
          // the authoritative reset, without issuing another exhausted GraphQL call.
          let probe = probes.get(hostname);
          if (!probe) {
            probe = Promise.resolve().then(() => run(['api', '--hostname', hostname, 'rate_limit'], {
              ...options, timeout: Math.min(options.timeout || 20_000, 20_000),
            }))
              .catch(() => null);
            probes.set(hostname, probe);
            void probe.finally(() => probes.delete(hostname));
          }
          const status = await probe;
          let until = githubRetryAt(message, now());
          try {
            const bucket = JSON.parse(status?.stdout ?? '').resources?.[resource];
            if (bucket?.remaining === 0 && Number.isFinite(bucket.reset)) {
              until = Math.max(now() + 1_000, bucket.reset * 1_000 + 1_000);
            }
          } catch {}
          const blocked = { ...result, stderr: `${result.stderr || message.trim()}\nRetry after ${new Date(until).toISOString()}` };
          const previous = cooldowns.get(budget);
          if (!previous || previous.until < until) cooldowns.set(budget, { until, result: blocked });
          return blocked;
        }
        if (mutation && result.code === 0) invalidateReads();
        if (read && result.code === 0 && !result.accumulationTruncated && revision === startedRevision) {
          entry.until = now() + PR_READ_TTL_MS;
        }
        return result;
      } finally {
        entry.pending = false;
        if (read && !entry.until && reads.get(key) === entry) reads.delete(key);
      }
    })();
    if (read) reads.set(key, entry);
    return entry.promise;
  }

  return { request, invalidateReads };
}
