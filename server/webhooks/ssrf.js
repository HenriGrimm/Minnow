/**
 * SSRF protection and error sanitization for outgoing webhooks.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

/** Private/internal CIDR blocks checked in addition to Node address flags. */
const PRIVATE_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::1/128',
  '::/128',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  'fc00::/7',
  'fe80::/10',
  '2001::/32',
  '2001:db8::/32',
  '2002::/16',
  'ff00::/8',
];

/** @type {import('node:net').BlockList | null} */
let privateBlockList = null;

function getPrivateBlockList() {
  if (!privateBlockList) {
    privateBlockList = new net.BlockList();
    for (const cidr of PRIVATE_CIDRS) {
      privateBlockList.addSubnet(...parseCidr(cidr));
    }
  }
  return privateBlockList;
}

/**
 * @param {string} cidr
 * @returns {[string, number, number]}
 */
function parseCidr(cidr) {
  const [addr, prefixRaw] = cidr.split('/');
  const prefix = Number(prefixRaw);
  const type = addr.includes(':') ? 'ipv6' : 'ipv4';
  return [addr, prefix, type];
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedHostname(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return true;
  if (h === 'localhost' || h === '0.0.0.0' || h === 'metadata.google.internal' || h === 'metadata') {
    return true;
  }
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.intranet') || h.endsWith('.localhost')) {
    return true;
  }
  return false;
}

/** @param {string} hostname */
function normalizeHostname(hostname) {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/**
 * @param {string} address
 * @returns {boolean}
 */
export function isPrivateIpAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return true;

  if (family === 6) {
    const mapped = extractIpv4Mapped(address);
    if (mapped && isPrivateIpAddress(mapped)) {
      return true;
    }
  }

  const blockList = getPrivateBlockList();
  if (blockList.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    return true;
  }

  if (family === 4) {
    const octets = address.split('.').map((n) => Number(n));
    if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  }

  return false;
}

/**
 * @param {string} ipv6
 * @returns {string | null}
 */
function extractIpv4Mapped(ipv6) {
  const lower = ipv6.toLowerCase();
  const mappedPrefix = '::ffff:';
  if (!lower.startsWith(mappedPrefix)) return null;
  const tail = lower.slice(mappedPrefix.length);
  if (net.isIP(tail) === 4) return tail;
  return null;
}

/**
 * Resolve hostname to all A/AAAA addresses.
 * @param {string} hostname
 * @returns {Promise<string[]>}
 */
export async function resolveHostnameIps(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    const ips = records
      .map((r) => (typeof r.address === 'string' ? r.address : ''))
      .filter((addr) => addr && net.isIP(addr) > 0);
    return [...new Set(ips)];
  } catch {
    return [];
  }
}

/**
 * @param {string} url
 * @param {{ allowLocalHttp?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function isPrivateUrl(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const hostname = normalizeHostname(parsed.hostname || '');
  if (!hostname || isBlockedHostname(hostname)) {
    return true;
  }

  const allowLocalHttp =
    options.allowLocalHttp === true &&
    parsed.protocol === 'http:' &&
    (hostname === '127.0.0.1' || hostname === 'localhost');

  if (allowLocalHttp) {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return true;
  }

  if (net.isIP(hostname)) {
    return isPrivateIpAddress(hostname);
  }

  const addrs = await resolveHostnameIps(hostname);
  if (addrs.length === 0) {
    return true;
  }
  return addrs.some((addr) => isPrivateIpAddress(addr));
}

/**
 * Validate a target and return the exact addresses approved for the connection.
 * Callers must use `lookup` for the request so DNS cannot change between the
 * policy check and socket creation.
 * @param {string} url
 * @param {{ allowLocalHttp?: boolean }} [options]
 * @returns {Promise<{ url: string, lookup: import('node:dns').LookupFunction }>}
 */
export async function resolveWebhookTarget(url, options = {}) {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) {
    throw new Error('URL is required');
  }
  if (trimmed.length > 2048) {
    throw new Error('URL too long (max 2048 characters)');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('URL must use http or https');
  }

  const allowLocalHttp = options.allowLocalHttp === true;
  if (parsed.protocol !== 'https:' && !(allowLocalHttp && parsed.protocol === 'http:')) {
    throw new Error('URL must use https (or http://127.0.0.1 when local webhooks are enabled)');
  }
  if (!parsed.hostname) {
    throw new Error('URL must have a hostname');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL must not contain embedded credentials');
  }

  const hostname = normalizeHostname(parsed.hostname);
  const localHttp =
    allowLocalHttp &&
    parsed.protocol === 'http:' &&
    (hostname === '127.0.0.1' || hostname === 'localhost');

  /** @type {string[]} */
  let addresses;
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else if (localHttp && hostname === 'localhost') {
    addresses = await resolveHostnameIps(hostname);
  } else {
    if (isBlockedHostname(hostname)) {
      throw new Error('URL must not point to private/internal addresses');
    }
    addresses = await resolveHostnameIps(hostname);
  }

  if (addresses.length === 0) {
    throw new Error('URL hostname could not be resolved');
  }
  if (localHttp) {
    if (addresses.some((address) => !isLoopbackIpAddress(address))) {
      throw new Error('Local webhook hostname resolved outside loopback');
    }
  } else if (addresses.some((address) => isPrivateIpAddress(address))) {
    throw new Error('URL must not point to private/internal addresses');
  }

  return {
    url: parsed.toString(),
    lookup: createPinnedLookup(hostname, addresses),
  };
}

/** @param {string} address */
function isLoopbackIpAddress(address) {
  if (address === '::1') return true;
  const mapped = extractIpv4Mapped(address);
  const candidate = mapped ?? address;
  return net.isIP(candidate) === 4 && candidate.startsWith('127.');
}

/**
 * @param {string} expectedHostname
 * @param {string[]} addresses
 * @returns {import('node:dns').LookupFunction}
 */
function createPinnedLookup(expectedHostname, addresses) {
  return (hostname, options, callback) => {
    const requested = normalizeHostname(String(hostname));
    if (requested !== expectedHostname) {
      callback(new Error('Webhook DNS lookup changed hostname'));
      return;
    }

    const opts = typeof options === 'number' ? { family: options } : (options ?? {});
    const family = opts.family === 4 || opts.family === 6 ? opts.family : 0;
    const matches = addresses
      .map((address) => ({ address, family: net.isIP(address) }))
      .filter((entry) => entry.family > 0 && (!family || entry.family === family));
    if (matches.length === 0) {
      callback(new Error('Webhook target has no approved address for the requested family'));
      return;
    }
    if (opts.all) {
      callback(null, matches);
      return;
    }
    callback(null, matches[0].address, matches[0].family);
  };
}

/**
 * Validate and normalize a webhook target URL.
 * @param {string} url
 * @param {{ allowLocalHttp?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function validateWebhookUrl(url, options = {}) {
  return (await resolveWebhookTarget(url, options)).url;
}

// Broad candidate matcher for IPv6 redaction (ReDoS-safe).
const IP_CANDIDATE =
  /\[[^\[\]\s]*\](?::\d+)?|(?<![\w.:%])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,}(?:(?:\.[0-9]{1,3}){3})?(?:%[0-9A-Za-z._-]+)?/g;

/**
 * @param {string} token
 * @returns {string}
 */
function redactIpCandidate(token) {
  const bracketed = token.startsWith('[');
  let candidate = token;
  if (bracketed) {
    const end = token.indexOf(']');
    if (end < 0) return token;
    candidate = token.slice(1, end);
  }
  candidate = candidate.split('%', 1)[0];
  if (candidate.endsWith(':') && !candidate.endsWith('::')) {
    candidate = candidate.slice(0, -1);
  }
  if (net.isIP(candidate) === 6 || bracketed) {
    if (net.isIP(candidate) > 0 || bracketed) {
      return '[redacted]';
    }
  }
  return token;
}

/**
 * Strip sensitive host/IP details from delivery error messages.
 * @param {string} error
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeError(error, maxLen = 200) {
  let cleaned = String(error ?? '');
  cleaned = cleaned.replace(IP_CANDIDATE, (match) => redactIpCandidate(match));
  cleaned = cleaned.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g, '[redacted]');
  cleaned = cleaned.replace(/https?:\/\/[^\s/]+/g, '[redacted-url]');
  return cleaned.slice(0, maxLen);
}

/** Reset cached block list (tests). */
export function resetSsrfCachesForTests() {
  privateBlockList = null;
}
