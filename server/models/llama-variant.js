import { LLAMA_CPP_RELEASE_TAG } from './llama-runtime.js';
import { detectHardware } from '../system/hardware.js';

/** @typedef {'cpu' | 'cuda-12.4' | 'cuda-13' | 'vulkan' | 'metal' | 'rocm'} LlamaVariant */

export const LLAMA_VARIANT_LABELS = {
  cpu: 'CPU',
  'cuda-12.4': 'CUDA 12.4',
  'cuda-13': 'CUDA 13.x',
  vulkan: 'Vulkan',
  metal: 'Metal (macOS)',
  rocm: 'ROCm (Linux)',
};

function platformArchSuffix() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return { platform: 'win', arch, ext: 'zip' };
  if (process.platform === 'darwin') return { platform: 'macos', arch, ext: 'tar.gz' };
  if (process.platform === 'linux') return { platform: 'ubuntu', arch, ext: 'tar.gz' };
  return null;
}

/**
 * @param {LlamaVariant} variant
 * @param {string} tag
 * @returns {{ main: string, companion?: string }}
 */
export function expectedAssetNames(variant, tag = LLAMA_CPP_RELEASE_TAG) {
  const pa = platformArchSuffix();
  if (!pa) throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);

  const { platform, arch, ext } = pa;

  if (variant === 'cpu') {
    if (platform === 'win') {
      return { main: `llama-${tag}-bin-win-cpu-${arch}.zip` };
    }
    return { main: `llama-${tag}-bin-${platform}-${arch}.${ext}` };
  }

  if (variant === 'cuda-12.4') {
    if (platform === 'win') {
      return {
        main: `llama-${tag}-bin-win-cuda-12.4-${arch}.zip`,
        companion: `cudart-llama-bin-win-cuda-12.4-${arch}.zip`,
      };
    }
    return { main: `llama-${tag}-bin-${platform}-cuda-12.4-${arch}.${ext}` };
  }

  if (variant === 'cuda-13') {
    if (platform === 'win') {
      return {
        main: `llama-${tag}-bin-win-cuda-13-${arch}.zip`,
        companion: `cudart-llama-bin-win-cuda-13-${arch}.zip`,
      };
    }
    return { main: `llama-${tag}-bin-${platform}-cuda-13-${arch}.${ext}` };
  }

  if (variant === 'vulkan') {
    if (platform === 'win') {
      return { main: `llama-${tag}-bin-win-vulkan-${arch}.zip` };
    }
    return { main: `llama-${tag}-bin-${platform}-vulkan-${arch}.${ext}` };
  }

  if (variant === 'metal') {
    if (platform !== 'macos' || arch !== 'arm64') {
      throw new Error('Metal variant is only available on macOS arm64');
    }
    return { main: `llama-${tag}-bin-macos-arm64.tar.gz` };
  }

  if (variant === 'rocm') {
    if (platform !== 'ubuntu') {
      throw new Error('ROCm variant is only available on Linux');
    }
    return { main: `llama-${tag}-bin-ubuntu-rocm-${arch}.tar.gz` };
  }

  throw new Error(`Unknown llama variant: ${variant}`);
}

function hostArchToken() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

/**
 * @param {string} name
 * @returns {'win' | 'macos' | 'ubuntu' | null}
 */
function llamaAssetPlatform(name) {
  if (/(?:^|[-_])win(?:[-_.]|$)/i.test(name)) return 'win';
  if (/macos/i.test(name)) return 'macos';
  if (/ubuntu/i.test(name)) return 'ubuntu';
  return null;
}

/**
 * @param {string} name
 * @returns {'arm64' | 'x64' | null}
 */
function llamaAssetArch(name) {
  if (/(?:^|[-_.])arm64(?:[-_.]|$)/i.test(name)) return 'arm64';
  if (/(?:^|[-_.])x64(?:[-_.]|$)/i.test(name)) return 'x64';
  return null;
}

/**
 * @param {string} name
 * @param {string} pattern
 */
export function assetMatchesExpectedHost(name, pattern) {
  const wantArch = llamaAssetArch(pattern) ?? hostArchToken();
  const wantPlat = llamaAssetPlatform(pattern);
  if (llamaAssetArch(name) !== wantArch) return false;
  if (wantPlat && llamaAssetPlatform(name) !== wantPlat) return false;
  return true;
}

function cudaVersionScore(name) {
  const match = String(name).match(/cuda-(\d+)(?:\.(\d+))?/i);
  if (!match) return 0;
  return Number(match[1]) * 1000 + Number(match[2] || 0);
}

/**
 * @param {string} pattern
 * @param {Array<{ name: string }>} assets
 * @returns {string | null}
 */
function findAsset(pattern, assets) {
  const exact = assets.find((a) => a.name === pattern);
  if (exact) return exact.name;

  if (pattern.includes('cuda-13')) {
    const isCudart = pattern.startsWith('cudart-');
    const cuda13 = assets
      .map((a) => a.name)
      .filter(
        (n) =>
          /cuda-13/i.test(n) &&
          (isCudart ? n.startsWith('cudart-') : !n.startsWith('cudart-')) &&
          assetMatchesExpectedHost(n, pattern),
      );
    cuda13.sort((a, b) => cudaVersionScore(a) - cudaVersionScore(b) || a.localeCompare(b));
    const picked = cuda13.at(-1);
    if (picked) return picked;
  }

  const needle = pattern.split('-bin-')[1]?.split('.')[0] ?? pattern;
  const fuzzy = assets.find(
    (a) => a.name.includes(needle) && assetMatchesExpectedHost(a.name, pattern),
  );
  return fuzzy?.name ?? null;
}

/**
 * @param {string} mainZip
 * @param {Array<{ name: string }>} assets
 */
function findCudartCompanion(mainZip, assets) {
  const verMatch = mainZip.match(/cuda-([\d.]+)/i);
  if (!verMatch) return null;
  const cudaVer = verMatch[1];
  const arch = hostArchToken();
  const exact = `cudart-llama-bin-win-cuda-${cudaVer}-${arch}.zip`;
  const hit = assets.find((a) => a.name === exact);
  if (hit) return hit.name;
  return (
    assets.find(
      (a) =>
        a.name.startsWith('cudart-') &&
        a.name.includes(`cuda-${cudaVer}`) &&
        a.name.endsWith('.zip') &&
        llamaAssetArch(a.name) === arch,
    )?.name ?? null
  );
}

/**
 * @param {{ variant: LlamaVariant, tag?: string, assets: Array<{ name: string, browser_download_url?: string }> }} opts
 * @returns {{ mainZip: string, companionZip?: string, assetNames: string[] }}
 */
export function resolveLlamaAssets({ variant, tag = LLAMA_CPP_RELEASE_TAG, assets }) {
  const expected = expectedAssetNames(variant, tag);
  const mainZip = findAsset(expected.main, assets);
  if (!mainZip) {
    const available = assets.map((a) => a.name).join(', ');
    throw new Error(
      `No llama.cpp asset for variant "${variant}" (${expected.main}). Available: ${available || 'none'}`,
    );
  }

  let companionZip;
  if (expected.companion) {
    companionZip = findCudartCompanion(mainZip, assets) ?? findAsset(expected.companion, assets) ?? undefined;
  }

  const assetNames = companionZip ? [mainZip, companionZip] : [mainZip];
  return { mainZip, companionZip, assetNames };
}

/**
 * @param {Array<{ name: string }>} assets
 * @returns {LlamaVariant[]}
 */
export function listInstallableVariants(assets) {
  /** @type {LlamaVariant[]} */
  const out = [];
  /** @type {LlamaVariant[]} */
  const candidates =
    process.platform === 'linux'
      ? ['cuda-12.4', 'cuda-13', 'vulkan', 'rocm', 'cpu']
      : process.platform === 'darwin' && process.arch === 'arm64'
        ? ['metal', 'cpu']
        : ['cuda-12.4', 'cuda-13', 'vulkan', 'cpu'];

  for (const variant of candidates) {
    try {
      resolveLlamaAssets({ variant, assets });
      out.push(variant);
    } catch {
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>} [hardware]
 * @param {Array<{ name: string }>} [releaseAssets]
 * @returns {Promise<LlamaVariant>}
 */
export async function detectPreferredLlamaVariant(hardware, releaseAssets) {
  const hw = hardware ?? (await detectHardware());
  const gpuBackend = String(
    hw.gpu_backend ?? hw.gpuBackend ?? hw.backend ?? '',
  ).toLowerCase();
  const assets = releaseAssets ?? (await fetchReleaseAssetList());

  const installable = listInstallableVariants(assets);

  if (gpuBackend === 'cuda') {
    if (installable.includes('cuda-12.4')) return 'cuda-12.4';
    if (installable.includes('cuda-13')) return 'cuda-13';
  }

  if (installable.includes('vulkan')) return 'vulkan';

  if (process.platform === 'darwin' && process.arch === 'arm64' && installable.includes('metal')) {
    return 'metal';
  }

  return 'cpu';
}

let releaseAssetsCache = { tag: '', at: 0, assets: [] };
const RELEASE_CACHE_MS = 60 * 60 * 1000;

const GITHUB_OWNER = 'ggml-org';
const GITHUB_REPO = 'llama.cpp';

/**
 * Optional GitHub auth — unauthenticated REST is capped at 60 req/hr/IP and
 * Minnow's status/install path hit the same endpoints often enough to 403.
 * @returns {Record<string, string>}
 */
export function githubReleaseHeaders() {
  const headers = {
    'User-Agent': 'minnow-llama-runtime',
    Accept: 'application/vnd.github+json',
  };
  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * @param {string} tag
 * @param {string} name
 */
export function llamaReleaseDownloadUrl(tag, name) {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

/**
 * @param {Response} res
 * @param {string} label
 */
async function githubHttpError(res, label) {
  const remaining = res.headers.get('x-ratelimit-remaining');
  let detail = '';
  try {
    const body = await res.json();
    if (body && typeof body.message === 'string') detail = body.message;
  } catch {
    /* non-JSON body */
  }
  const rateLimited =
    res.status === 403 &&
    (remaining === '0' || /rate limit/i.test(detail));
  if (rateLimited) {
    return new Error(
      `GitHub API rate limit exceeded while fetching ${label}. ` +
        `Set GITHUB_TOKEN or GH_TOKEN, or retry later.`,
    );
  }
  return new Error(
    `Failed to fetch ${label}: HTTP ${res.status}${detail ? ` (${detail})` : ''}`,
  );
}

/**
 * Parse ggml-org release asset names from the public expanded_assets HTML page.
 * This path does not use api.github.com, so it still works when REST is rate-limited.
 * @param {string} html
 * @param {string} tag
 * @returns {Array<{ name: string, browser_download_url: string, digest?: string }>}
 */
export function parseExpandedAssetsHtml(html, tag) {
  /** @type {Set<string>} */
  const names = new Set();
  const re = /\/releases\/download\/([^/"'?#]+)\/([^/"'?#]+)/g;
  for (const match of String(html).matchAll(re)) {
    const hrefTag = match[1];
    const name = decodeURIComponent(match[2]);
    if (hrefTag !== tag) continue;
    if (!name || name.endsWith('.sha256')) continue;
    names.add(name);
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      browser_download_url: llamaReleaseDownloadUrl(tag, name),
    }));
}

/**
 * @param {unknown} release
 * @returns {Array<{ name: string, browser_download_url: string, digest?: string }>}
 */
function mapApiReleaseAssets(release) {
  const tag = typeof release?.tag_name === 'string' ? release.tag_name : '';
  return (release?.assets ?? [])
    .filter((a) => a && typeof a.name === 'string')
    .map((a) => ({
      name: a.name,
      browser_download_url:
        typeof a.browser_download_url === 'string' && a.browser_download_url
          ? a.browser_download_url
          : tag
            ? llamaReleaseDownloadUrl(tag, a.name)
            : '',
      ...(typeof a.digest === 'string' && a.digest ? { digest: a.digest } : {}),
    }))
    .filter((a) => a.browser_download_url);
}

/**
 * @param {string} tag
 * @returns {Promise<Array<{ name: string, browser_download_url: string, digest?: string }>>}
 */
async function fetchReleaseAssetsFromApi(tag) {
  const releaseUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${tag}`;
  const tagged = await fetch(releaseUrl, { headers: githubReleaseHeaders() });
  if (tagged.ok) {
    return mapApiReleaseAssets(await tagged.json());
  }
  const taggedErr = await githubHttpError(tagged, `llama.cpp release ${tag}`);
  // Rate-limited REST will fail /latest the same way — skip straight to HTML fallback.
  if (/rate limit/i.test(taggedErr.message)) {
    throw taggedErr;
  }

  const latest = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    { headers: githubReleaseHeaders() },
  );
  if (latest.ok) {
    return mapApiReleaseAssets(await latest.json());
  }
  const latestErr = await githubHttpError(latest, 'llama.cpp latest release');
  throw new Error(`${taggedErr.message}; ${latestErr.message}`);
}

/**
 * @param {string} tag
 * @returns {Promise<Array<{ name: string, browser_download_url: string, digest?: string }>>}
 */
async function fetchReleaseAssetsFromHtml(tag) {
  const url = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/expanded_assets/${tag}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'minnow-llama-runtime' },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch llama.cpp expanded_assets ${tag}: HTTP ${res.status}`);
  }
  const assets = parseExpandedAssetsHtml(await res.text(), tag);
  if (!assets.length) {
    throw new Error(`llama.cpp expanded_assets ${tag} listed no downloadable assets`);
  }
  return assets;
}

/**
 * @param {string} [tag]
 * @returns {Promise<Array<{ name: string, browser_download_url: string, digest?: string }>>}
 */
export async function fetchReleaseAssetList(tag = LLAMA_CPP_RELEASE_TAG) {
  if (
    releaseAssetsCache.tag === tag &&
    Date.now() - releaseAssetsCache.at < RELEASE_CACHE_MS &&
    releaseAssetsCache.assets.length
  ) {
    return releaseAssetsCache.assets;
  }

  /** @type {Error | null} */
  let apiError = null;
  try {
    const assets = await fetchReleaseAssetsFromApi(tag);
    if (assets.length) {
      releaseAssetsCache = { tag, at: Date.now(), assets };
      return assets;
    }
    apiError = new Error('llama.cpp release API returned no assets');
  } catch (err) {
    apiError = err instanceof Error ? err : new Error(String(err));
  }

  try {
    const assets = await fetchReleaseAssetsFromHtml(tag);
    releaseAssetsCache = { tag, at: Date.now(), assets };
    return assets;
  } catch (htmlErr) {
    const htmlMessage = htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
    throw new Error(
      `Failed to fetch llama.cpp release manifest. ${apiError?.message ?? 'API unavailable'}; ${htmlMessage}`,
    );
  }
}

export function isGpuCapableVariant(variant) {
  return variant !== 'cpu';
}

export function resetLlamaVariantCacheForTests() {
  releaseAssetsCache = { tag: '', at: 0, assets: [] };
}
