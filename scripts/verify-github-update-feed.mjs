#!/usr/bin/env node

/**
 * Compare GitHub Release update feeds (latest.yml / latest-linux.yml / latest-mac.yml)
 * to attached asset sizes. A size mismatch means electron-updater will reject the
 * download after hashing it.
 *
 * Usage: node scripts/verify-github-update-feed.mjs [tag]
 * Default tag: v<package.json version>
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findUpdateFeedSizeMismatches,
  parseUpdateFeedYaml,
} from './update-feed-verify.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEED_NAMES = ['latest.yml', 'latest-linux.yml', 'latest-mac.yml'];

function ghJson(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', cwd: repoRoot });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `gh ${args.join(' ')} failed`);
  }
  return JSON.parse(result.stdout);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const tag = process.argv[2] || `v${pkg.version}`;
  const release = ghJson([
    'release',
    'view',
    tag,
    '--repo',
    'HenriGrimm/Minnow',
    '--json',
    'tagName,assets',
  ]);
  const assets = release.assets ?? [];
  const assetSizes = assets.map((asset) => ({ name: asset.name, size: asset.size }));

  let failed = false;
  for (const name of FEED_NAMES) {
    const asset = assets.find((entry) => entry.name === name);
    if (!asset) {
      console.warn(`[update-feed] ${tag} has no ${name} (skip)`);
      continue;
    }
    const apiPath = String(asset.apiUrl ?? '').replace('https://api.github.com/', '');
    if (!apiPath) {
      console.error(`[update-feed] ${name} has no apiUrl on the GitHub asset`);
      failed = true;
      continue;
    }
    const yaml = spawnSync(
      'gh',
      ['api', apiPath, '-H', 'Accept: application/octet-stream'],
      { encoding: 'utf8', cwd: repoRoot },
    );
    if (yaml.status !== 0) {
      console.error(`[update-feed] could not download ${name}: ${yaml.stderr}`);
      failed = true;
      continue;
    }
    const feed = parseUpdateFeedYaml(yaml.stdout);
    const mismatches = findUpdateFeedSizeMismatches(feed, assetSizes);
    if (mismatches.length === 0) {
      console.log(`[update-feed] ${name} matches attached assets`);
      continue;
    }
    failed = true;
    for (const mismatch of mismatches) {
      console.error(
        `[update-feed] ${name}: ${mismatch.url} ${mismatch.reason} feed=${mismatch.feedSize} asset=${mismatch.assetSize}`,
      );
    }
  }

  if (failed) process.exit(1);
}

main();
