#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';
import { minnowMarkPath } from '../src/lib/minnow-mark.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pngDir = path.join(root, 'public', 'logos', 'minnow-logo', 'minnow', 'png');
const svgDir = path.join(root, 'public', 'logos', 'minnow-logo', 'minnow', 'svg');
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

/**
 * macOS draws the whole icon canvas as the Dock tile and its own apps keep the
 * artwork inside an 824 px content box, so the full-bleed PNG ladder (right for
 * iOS, PWA masks and Linux launchers) reads ~24% oversized in the Dock. The
 * bundle icon and the runtime Dock icon therefore use an inset variant.
 */
const MAC_ICON_SIZE = 1024;
const MAC_TILE_SIZE = 824;

async function writeMacAppIcon() {
  const svg = fs.readFileSync(path.join(svgDir, 'minnow-icon.svg'));
  const sourceWidth = Number(/width="([\d.]+)"/.exec(svg.toString())?.[1] ?? 512);
  const density = Math.max(72, Math.ceil((72 * MAC_TILE_SIZE) / sourceWidth));
  const tile = await sharp(svg, { density })
    .resize(MAC_TILE_SIZE, MAC_TILE_SIZE)
    .png()
    .toBuffer();
  const inset = (MAC_ICON_SIZE - MAC_TILE_SIZE) / 2;
  const macDest = path.join(root, 'build', 'icon-mac.png');
  await sharp({
    create: {
      width: MAC_ICON_SIZE,
      height: MAC_ICON_SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: tile, left: inset, top: inset }])
    .png({ compressionLevel: 9 })
    .toFile(macDest);
  console.log(
    `[sync-app-icon] Wrote ${macDest} (${MAC_ICON_SIZE}px canvas, ${MAC_TILE_SIZE}px tile)`,
  );
}

await writeMacAppIcon();

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
