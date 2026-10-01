#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = 'release/pkg-linux';
const image = 'electronuserland/builder:22';

const validate = spawnSync('node', ['scripts/validate-packaged-runtime-files.mjs'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (validate.status !== 0) process.exit(validate.status ?? 1);

const dockerArgs = [
  'run',
  '--rm',
  `-v=${repoRoot}:/project`,
  '-v=minnow-linux-node-modules:/project/node_modules',
  '-w=/project',
  image,
  'bash',
  '-c',
  [
    'npm ci',
    'npm run sandbox:build-helper',
    'npm run build',
    'npm run electron:build',
    'npm run headless:build',
    `npx electron-builder --linux AppImage --publish never --config.directories.output=${outputDir}`,
  ].join(' && '),
];

console.log(`[package:linux:docker] image=${image} output=${outputDir}/`);
const result = spawnSync('docker', dockerArgs, { cwd: repoRoot, stdio: 'inherit' });
process.exit(result.status ?? 1);
