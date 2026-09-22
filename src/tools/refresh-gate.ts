/** Coalesce discovery requests; callers choose freshness without caching permissions. */
export function createRefreshGate(load: () => Promise<void>, now = () => Date.now()) {
  let updatedAt = -Infinity;
  let pending: Promise<void> | undefined;
  let forced: Promise<void> | undefined;
  const refresh = (maxAgeMs = 0): Promise<void> => {
    if (pending) {
      if (maxAgeMs > 0) return forced ?? pending;
      // A settings mutation may postdate the in-flight request. Follow it with
      // one fresh request rather than letting the old response hide the change.
      forced ??= pending.catch(() => {}).then(() => refresh()).finally(() => { forced = undefined; });
      return forced;
    }
    if (maxAgeMs > 0 && now() - updatedAt < maxAgeMs) return Promise.resolve();
    pending = Promise.resolve().then(load).then(() => { updatedAt = now(); })
      .finally(() => { pending = undefined; });
    return pending;
  };
  return refresh;
}
