/** LAN inference servers need the same template controls as loopback servers. */
export function isLanProviderBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.endsWith('.local')) return true;
    if (/^\[f[cd][0-9a-f]{2}:/i.test(host)) return true;
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || !parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return false;
    return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  } catch {
    return false;
  }
}
