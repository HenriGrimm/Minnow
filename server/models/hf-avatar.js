const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_AVATAR_BYTES = 512 * 1024;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

/** @type {Map<string, { at: number, value: string | null }>} */
const cache = new Map();
/** @type {Map<string, { at: number, value: { body: Buffer, contentType: string } | null }>} */
const imageCache = new Map();
let fetchImpl = (...args) => fetch(...args);

export function setHfAvatarFetchForTests(fn) {
  fetchImpl = fn;
}

export function resetHfAvatarForTests() {
  fetchImpl = (...args) => fetch(...args);
  cache.clear();
  imageCache.clear();
}

function trustedAvatarUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' && url.hostname === 'cdn-avatars.huggingface.co'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

async function fetchOverview(kind, owner) {
  const res = await fetchImpl(
    `https://huggingface.co/api/${kind}/${encodeURIComponent(owner)}/overview`,
    { headers: { 'User-Agent': 'Minnow/1.0' }, signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) return null;
  const data = await res.json();
  return trustedAvatarUrl(data?.avatarUrl);
}

/** Resolve an organisation or user avatar without exposing arbitrary redirect targets. */
export async function getHfCreatorAvatar(owner) {
  if (!OWNER_PATTERN.test(String(owner ?? ''))) return null;
  const key = String(owner).toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const settled = await Promise.allSettled([
    fetchOverview('organizations', owner),
    fetchOverview('users', owner),
  ]);
  const value = settled
    .map((result) => (result.status === 'fulfilled' ? result.value : null))
    .find(Boolean) ?? null;
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Download a small trusted avatar so the browser never forwards its auth URL off-host. */
export async function getHfCreatorAvatarImage(owner) {
  if (!OWNER_PATTERN.test(String(owner ?? ''))) return null;
  const key = String(owner).toLowerCase();
  const cached = imageCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const avatarUrl = await getHfCreatorAvatar(owner);
  if (!avatarUrl) {
    imageCache.set(key, { at: Date.now(), value: null });
    return null;
  }
  const res = await fetchImpl(avatarUrl, {
    headers: { 'User-Agent': 'Minnow/1.0' },
    signal: AbortSignal.timeout(5_000),
  });
  const contentType = String(res.headers?.get('content-type') ?? '').split(';')[0].toLowerCase();
  const declaredBytes = Number(res.headers?.get('content-length'));
  if (
    !res.ok ||
    !IMAGE_TYPES.has(contentType) ||
    (Number.isFinite(declaredBytes) && declaredBytes > MAX_AVATAR_BYTES)
  ) {
    imageCache.set(key, { at: Date.now(), value: null });
    return null;
  }
  const body = Buffer.from(await res.arrayBuffer());
  const value = body.byteLength <= MAX_AVATAR_BYTES ? { body, contentType } : null;
  imageCache.set(key, { at: Date.now(), value });
  return value;
}
