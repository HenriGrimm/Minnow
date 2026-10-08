/** Share GitHub read requests and rate-limit backoff across Minnow windows. */
export function githubRateLimitDelay(text, now = Date.now()) {
  if (!/rate.?limit|secondary rate|abuse detection/i.test(text)) return 0;
  const reset = /x-ratelimit-reset:\s*(\d+)/i.exec(text);
  const retry = /retry-after:\s*(\d+)/i.exec(text);
  if (reset && /x-ratelimit-remaining:\s*0\b/i.test(text)) {
    return Math.max(1_000, Number(reset[1]) * 1_000 - now + 1_000);
  }
  if (retry) return Math.max(1_000, Number(retry[1]) * 1_000);
  return /secondary|abuse/i.test(text) ? 60_000 : 60 * 60 * 1_000;
}

export function createGithubRequestGate({ now = Date.now, probe } = {}) {
  const cooldowns = new Map();
  const reads = new Map();
  const versions = new Map();
  const secondaryFailures = new Map();
  async function request(args, cwd, host, run) {
    if (args[0] === '--version' || args[0] === 'auth') return run();
    const retryAt = cooldowns.get(host) ?? 0;
    if (retryAt > now()) {
      return { code: 1, stdout: '', stderr: `GitHub API rate limit reached. Requests are paused until ${new Date(retryAt).toISOString()}.` };
    }
    const read = /^(pr|issue|run)$/.test(args[0]) && /^(list|view)$/.test(args[1]);
    const version = versions.get(host) ?? 0;
    const key = JSON.stringify([host, cwd, args]);
    const hit = read && reads.get(key);
    if (hit && hit.version === version && (hit.pending || now() < hit.expires)) return hit.promise;
    const work = (async () => {
      const result = await run();
      const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
      if (result.code !== 0 && githubRateLimitDelay(text, now())) {
        // CLI commands omit headers. Ask GraphQL itself; /rate_limit can report stale capacity.
        let detail = '';
        if (!/secondary|abuse|x-ratelimit-reset:|retry-after:/i.test(text)) {
          try { detail = await probe?.(host, cwd, args) ?? ''; } catch {}
        }
        let delay = githubRateLimitDelay(`${text}\n${detail}`, now());
        if (/secondary|abuse/i.test(text) && !/retry-after:/i.test(text)) {
          const failures = (secondaryFailures.get(host) ?? 0) + 1;
          secondaryFailures.set(host, failures);
          delay *= 2 ** Math.min(failures - 1, 6);
        }
        const until = now() + delay;
        cooldowns.set(host, Math.max(until, cooldowns.get(host) ?? 0));
        result.stderr = `GitHub API rate limit reached. Requests are paused until ${new Date(cooldowns.get(host)).toISOString()}.\n${result.stderr ?? ''}`;
      }
      if (result.code === 0) secondaryFailures.delete(host);
      if (result.code === 0 && /^(create|edit|close|reopen|delete|comment|merge|ready|checkout|rerun|cancel)$/.test(args[1])) {
        versions.set(host, (versions.get(host) ?? 0) + 1);
      }
      return result;
    })();
    if (read) {
      const entry = { promise: work, pending: true, expires: 0, version };
      if (reads.size >= 200) reads.delete(reads.keys().next().value);
      reads.set(key, entry);
      try {
        const result = await work;
        entry.pending = false;
        // Issue reads participate in conflict resolution and must always be fresh.
        entry.expires = result.code === 0 && args[0] !== 'issue' ? now() + 30_000 : 0;
        return result;
      } catch (err) {
        if (reads.get(key) === entry) reads.delete(key);
        throw err;
      }
    }
    return work;
  }
  request.invalidateReads = () => {
    for (const host of versions.keys()) versions.set(host, versions.get(host) + 1);
    reads.clear();
  };
  return request;
}
