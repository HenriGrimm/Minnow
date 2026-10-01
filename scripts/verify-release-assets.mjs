#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseUpdateFeedYaml, findUpdateFeedSizeMismatches } from './update-feed-verify.mjs';

const platforms = [
  { feed: 'latest.yml', extensions: ['.exe'] },
  { feed: 'latest-linux.yml', extensions: ['.AppImage'] },
  { feed: 'latest-mac.yml', extensions: ['.dmg', '.zip'] },
];

export async function verifyReleaseAssets(directory, version) {
  const names = fs.readdirSync(directory);
  const assets = names.map((name) => ({ name, size: fs.statSync(path.join(directory, name)).size }));
  for (const { feed: name, extensions } of platforms) {
    const yaml = fs.readFileSync(path.join(directory, name), 'utf8');
    const feed = parseUpdateFeedYaml(yaml);
    if (feed.version !== version) throw new Error(`${name}: expected version ${version}, got ${feed.version}`);
    if (!feed.files.length) throw new Error(`${name}: no update files listed`);
    for (const extension of extensions) {
      if (!feed.files.some((file) => file.url.endsWith(extension))) {
        throw new Error(`${name}: missing ${extension} installer in update feed`);
      }
    }
    const mismatches = findUpdateFeedSizeMismatches(feed, assets);
    if (mismatches.length) throw new Error(`${name}: installer missing or size mismatch: ${JSON.stringify(mismatches)}`);
    const blocks = yaml.split(/\n\s*-\s+url:\s*/).slice(1);
    for (const [index, file] of feed.files.entries()) {
      if (path.basename(file.url) !== file.url || /[/\\]/.test(file.url)) {
        throw new Error(`${name}: invalid asset path ${file.url}`);
      }
      const expected = /\n\s*sha512:\s*(\S+)/.exec(blocks[index])?.[1]?.replace(/^['"]|['"]$/g, '');
      const hash = createHash('sha512');
      for await (const chunk of fs.createReadStream(path.join(directory, file.url))) hash.update(chunk);
      if (hash.digest('base64') !== expected) throw new Error(`${name}: SHA-512 mismatch for ${file.url}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/verify-release-assets.mjs <directory> <version>');
    await verifyReleaseAssets(process.argv[2], process.argv[3]);
    console.log('[release] All three platform feeds match their installers and release version.');
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  }
}
