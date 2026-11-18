/**
 * Remote URL parsing with no dependencies, so modules that only need a
 * remote's host and slug (workspace repo discovery) do not load the forge
 * layer and the `gh` CLI wrapper.
 */

/**
 * @param {string} url
 * @returns {{ host: string, slug: string, hostname: string }}
 */
export function parseRemoteHost(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return { host: 'none', slug: '', hostname: '' };

  let hostname = '';
  let pathPart = '';

  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
  if (scp && !raw.includes('://')) {
    hostname = scp[1] ?? '';
    pathPart = scp[2] ?? '';
  } else {
    try {
      const parsed = new URL(raw);
      hostname = parsed.hostname;
      pathPart = parsed.pathname;
    } catch {
      return { host: 'other', slug: '', hostname: '' };
    }
  }

  hostname = hostname.toLowerCase();
  const slug = pathPart
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  let host = 'other';
  if (hostname === 'github.com' || hostname.endsWith('.github.com')) host = 'github';
  else if (hostname === 'gitlab.com' || hostname.startsWith('gitlab.')) host = 'gitlab';
  else if (hostname === 'bitbucket.org') host = 'bitbucket';
  else if (hostname.includes('github')) host = 'github-enterprise';

  return { host, slug, hostname };
}
