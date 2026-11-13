#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';
import { minnowMarkPath } from '../src/lib/minnow-mark.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pngDir = path.join(root, 'public', 'logos', 'minnow-logo', 'minnow', 'png');
const trayDir = path.join(root, 'build', 'tray');
const sizes = [256, 128, 64, 48, 32, 16];
const files = sizes.map((size) => path.join(pngDir, `minnow-${size}.png`));

for (const file of files) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing logo PNG: ${file}`);
  }
}

const buf = await pngToIco(files);
const dest = path.join(root, 'build', 'icon.ico');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, buf);
console.log(`[sync-app-icon] Wrote ${dest} (${buf.length} bytes)`);

/** Tray icons are drawn on whole pixels from the mark's grid, never downscaled. */
async function writeTrayPng(outName, size, grid, fill) {
  const outPath = path.join(trayDir, outName);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<path d="${minnowMarkPath(grid)}" fill="${fill}" shape-rendering="crispEdges"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  console.log(`[sync-app-icon] Wrote ${outPath} (${size}px)`);
}

fs.mkdirSync(trayDir, { recursive: true });
// macOS template images: black + alpha; the system tints them.
await writeTrayPng('trayTemplate.png', 22, { cell: 2, step: 3, x: 1, y: 4 }, '#000000');
await writeTrayPng('trayTemplate@2x.png', 44, { cell: 4, step: 6, x: 2, y: 8 }, '#000000');
// Linux panels are light or dark; the sage accent reads on both.
await writeTrayPng('tray-linux.png', 24, { cell: 2, step: 3, x: 2, y: 5 }, '#9ec5a7');
