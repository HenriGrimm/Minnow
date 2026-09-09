/**
 * Compare electron-builder update-feed YAML to GitHub release asset sizes.
 * A mismatch means the installer users download will fail SHA-512 verification.
 */

/**
 * @param {string} yamlText
 * @returns {{ version: string | null, files: Array<{ url: string, size: number | null }> }}
 */
export function parseUpdateFeedYaml(yamlText) {
  const versionMatch = /^\s*version:\s*(.+)\s*$/m.exec(yamlText);
  const version = versionMatch ? String(versionMatch[1]).trim().replace(/^['"]|['"]$/g, '') : null;
  const files = [];
  const fileBlocks = yamlText.split(/\n\s*-\s+url:\s*/).slice(1);
  for (const block of fileBlocks) {
    const urlLine = block.split('\n')[0]?.trim() ?? '';
    const url = urlLine.replace(/^['"]|['"]$/g, '');
    const sizeMatch = /\n\s*size:\s*(\d+)/.exec(`\n${block}`);
    files.push({
      url,
      size: sizeMatch ? Number(sizeMatch[1]) : null,
    });
  }
  return { version, files };
}

/**
 * @param {{ files: Array<{ url: string, size: number | null }> }} feed
 * @param {Array<{ name: string, size: number }>} assets
 * @returns {Array<{ url: string, feedSize: number | null, assetSize: number | null, reason: string }>}
 */
export function findUpdateFeedSizeMismatches(feed, assets) {
  const byName = new Map(assets.map((asset) => [asset.name, asset.size]));
  const mismatches = [];
  for (const file of feed.files) {
    const assetSize = byName.has(file.url) ? byName.get(file.url) : null;
    if (assetSize == null) {
      mismatches.push({
        url: file.url,
        feedSize: file.size,
        assetSize: null,
        reason: 'asset-missing',
      });
      continue;
    }
    if (file.size == null || file.size !== assetSize) {
      mismatches.push({
        url: file.url,
        feedSize: file.size,
        assetSize,
        reason: 'size-mismatch',
      });
    }
  }
  return mismatches;
}
