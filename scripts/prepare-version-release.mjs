#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;

export function validateReleaseVersion(input, tags) {
  const version = String(input ?? '').replace(/^v/, '');
  if (!stableVersion.test(version)) {
    throw new Error('Enter a stable version such as 0.1.7 or v0.1.7 (no prerelease suffix).');
  }
  const target = version.split('.').map(BigInt);
  for (const tag of tags) {
    const existing = tag.replace(/^v/, '');
    if (!stableVersion.test(existing)) continue;
    const parts = existing.split('.').map(BigInt);
    let comparison = 0;
    for (let index = 0; index < 3; index++) {
      if (target[index] === parts[index]) continue;
      comparison = target[index] > parts[index] ? 1 : -1;
      break;
    }
    if (comparison <= 0) throw new Error(`Version ${version} must be newer than existing stable tag ${tag}.`);
  }
  return { version, tag: `v${version}` };
}

function main() {
  const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  const release = validateReleaseVersion(process.env.RELEASE_VERSION ?? process.argv[2], tags);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const output = `version=${release.version}\ntag=${release.tag}\nsha=${sha}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  }
}
