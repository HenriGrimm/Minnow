#!/usr/bin/env node
/**
 * Renders every Minnow logo asset from the pixel-minnow geometry in
 * src/lib/minnow-mark.mjs: SVG masters, the PNG size ladder, favicons, PWA
 * icons, lockups and the download kit. Run `npm run logos:render` (which then
 * runs `app-icon:sync` for build/icon.ico and the tray icons).
 *
 * Sizes 16–64 use hand-snapped grids so every cell lands on whole pixels;
 * larger sizes draw the vector master.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';
import { MINNOW_MARK_VECTOR, minnowMarkPath } from '../src/lib/minnow-mark.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logosDir = path.join(root, 'public', 'logos');
const kitDir = path.join(logosDir, 'minnow-logo', 'minnow');
const kitSvgDir = path.join(kitDir, 'svg');
const kitPngDir = path.join(kitDir, 'png');
const pwaDir = path.join(root, 'public', 'icons');

const INK = '#0f1216';
const ACCENT = '#9ec5a7';
const FG = '#dfe3e8';
const MUTED = '#5a626c';
const TAGLINE = 'Tiny by design.';

/** Whole-pixel grids for small tiles: cell, step (cell + gap), grid origin. */
const SNAPPED = {
  16: { cell: 2, step: 2, x: 1, y: 3 },
  32: { cell: 2, step: 3, x: 6, y: 9 },
  48: { cell: 4, step: 5, x: 7, y: 12 },
  64: { cell: 4, step: 6, x: 12, y: 18 },
};

/** Share of the tile the 100-unit vector box covers. */
const GLYPH_SCALE = 0.72;

function svgDoc(w, h, body, title = 'Minnow') {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n` +
    `  <title>${title}</title>\n${body}\n</svg>\n`
  );
}

function vectorGlyph(size, fill, { cx = size / 2, cy = size / 2, scale = GLYPH_SCALE } = {}) {
  const k = (size * scale) / 100;
  const tx = cx - 50 * k;
  const ty = cy - 50 * k;
  return `  <path transform="translate(${tx} ${ty}) scale(${k})" d="${MINNOW_MARK_VECTOR.d}" fill="${fill}"/>`;
}

/**
 * App icon: a rounded graphite tile with the sage minnow.
 * @param {number} size
 * @param {{ tile?: string, fish?: string, radius?: number|null, scale?: number }} [opts]
 */
function iconSvg(size, { tile = INK, fish = ACCENT, radius = null, scale = GLYPH_SCALE } = {}) {
  const rx = radius ?? Math.round(size * 0.21875 * 100) / 100;
  const bg = `  <rect width="${size}" height="${size}" rx="${rx}" fill="${tile}"/>`;
  const snap = SNAPPED[size];
  if (snap && scale === GLYPH_SCALE) {
    const d = minnowMarkPath(snap);
    return svgDoc(size, size, `${bg}\n  <path d="${d}" fill="${fish}" shape-rendering="crispEdges"/>`);
  }
  return svgDoc(size, size, `${bg}\n${vectorGlyph(size, fish, { scale })}`);
}

function glyphSvg(fill) {
  return svgDoc(100, 100, `  <path d="${MINNOW_MARK_VECTOR.d}" fill="${fill}"/>`, 'Minnow glyph');
}

const MONO = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const SANS = "Geist, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

function lockupHorizontalSvg() {
  const tile = 128;
  const k = (tile * GLYPH_SCALE) / 100;
  return svgDoc(
    720,
    200,
    [
      `  <rect x="20" y="36" width="${tile}" height="${tile}" rx="28" fill="${INK}"/>`,
      `  <path transform="translate(${20 + tile / 2 - 50 * k} ${36 + tile / 2 - 50 * k}) scale(${k})" d="${MINNOW_MARK_VECTOR.d}" fill="${ACCENT}"/>`,
      `  <text x="180" y="108" font-family="${MONO}" font-size="64" font-weight="600" letter-spacing="-2.5" fill="${INK}">minnow</text>`,
      `  <text x="182" y="144" font-family="${SANS}" font-size="20" font-weight="400" fill="${MUTED}">${TAGLINE}</text>`,
    ].join('\n'),
    'Minnow — horizontal lockup',
  );
}

function lockupStackedSvg() {
  const tile = 176;
  const x = (400 - tile) / 2;
  const k = (tile * GLYPH_SCALE) / 100;
  return svgDoc(
    400,
    400,
    [
      `  <rect x="${x}" y="56" width="${tile}" height="${tile}" rx="38" fill="${INK}"/>`,
      `  <path transform="translate(${200 - 50 * k} ${56 + tile / 2 - 50 * k}) scale(${k})" d="${MINNOW_MARK_VECTOR.d}" fill="${ACCENT}"/>`,
      `  <text x="200" y="306" text-anchor="middle" font-family="${MONO}" font-size="52" font-weight="600" letter-spacing="-2" fill="${INK}">minnow</text>`,
      `  <text x="200" y="342" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="400" fill="${MUTED}">${TAGLINE}</text>`,
    ].join('\n'),
    'Minnow — stacked lockup',
  );
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  console.log(`[render-logos] ${path.relative(root, file)}`);
}

async function png(svg, size, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const density = Math.max(72, Math.ceil((72 * size) / svgWidth(svg)));
  await sharp(Buffer.from(svg), { density }).resize(size).png({ compressionLevel: 9 }).toFile(file);
  console.log(`[render-logos] ${path.relative(root, file)}`);
}

function svgWidth(svg) {
  return Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 100);
}

/**
 * Lockup PNGs carry type, and librsvg cannot read the bundled woff2 fonts, so
 * they are rasterised by Electron's Chromium (scripts/render-lockups-electron.mjs).
 */
function renderLockups(jobs) {
  const jobsFile = path.join(os.tmpdir(), `minnow-lockup-jobs-${process.pid}.json`);
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  try {
    const electron = require('electron');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const res = spawnSync(electron, [path.join(root, 'scripts', 'render-lockups-electron.mjs'), jobsFile], {
      stdio: 'inherit',
      env,
    });
    if (res.status !== 0) throw new Error(`lockup render exited with ${res.status}`);
  } finally {
    fs.rmSync(jobsFile, { force: true });
  }
}

// ── SVG masters ─────────────────────────────────────────────────────────────

const svgs = {
  'minnow-icon.svg': iconSvg(512),
  'minnow-icon-light.svg': iconSvg(512, { tile: '#ffffff', fish: INK }),
  'minnow-glyph.svg': glyphSvg(INK),
  'minnow-glyph-white.svg': glyphSvg('#ffffff'),
  'minnow-glyph-accent.svg': glyphSvg(ACCENT),
  'minnow-favicon.svg': iconSvg(16),
  // Maskable: full-bleed square, mark inside the 80% safe zone.
  'minnow-maskable.svg': iconSvg(512, { radius: 0, scale: 0.6 }),
  'minnow-lockup-horizontal.svg': lockupHorizontalSvg(),
  'minnow-lockup-stacked.svg': lockupStackedSvg(),
};

for (const [name, svg] of Object.entries(svgs)) write(path.join(kitSvgDir, name), svg);
for (const name of ['minnow-icon.svg', 'minnow-glyph.svg', 'minnow-glyph-white.svg', 'minnow-lockup-horizontal.svg']) {
  write(path.join(logosDir, name), svgs[name]);
}

// ── PNG ladder ──────────────────────────────────────────────────────────────

for (const size of [16, 32, 48, 64, 96, 128, 180, 192, 256, 384, 512, 1024]) {
  await png(iconSvg(size), size, path.join(kitPngDir, `minnow-${size}.png`));
}
for (const size of [16, 32, 48]) {
  await png(iconSvg(size), size, path.join(kitPngDir, `minnow-favicon-${size}.png`));
}
for (const size of [128, 256, 512]) {
  await png(iconSvg(size, { tile: '#ffffff', fish: INK }), size, path.join(kitPngDir, `minnow-light-${size}.png`));
  await png(glyphSvg(INK), size, path.join(kitPngDir, `minnow-glyph-${size}.png`));
}
for (const size of [192, 512]) {
  await png(svgs['minnow-maskable.svg'], size, path.join(kitPngDir, `minnow-maskable-${size}.png`));
  await png(svgs['minnow-maskable.svg'], size, path.join(pwaDir, `icon-${size}.png`));
}
// iOS masks the touch icon itself: an opaque full-bleed square.
const touch = iconSvg(180, { radius: 0, scale: 0.66 });
await png(touch, 180, path.join(kitPngDir, 'apple-touch-icon.png'));
await png(touch, 180, path.join(logosDir, 'apple-touch-icon.png'));

renderLockups([
  ...[720, 1440].map((width) => ({
    svg: svgs['minnow-lockup-horizontal.svg'],
    width,
    height: Math.round((width * 200) / 720),
    out: path.join(kitPngDir, `minnow-lockup-horizontal-${width}.png`),
  })),
  ...[400, 800].map((width) => ({
    svg: svgs['minnow-lockup-stacked.svg'],
    width,
    height: width,
    out: path.join(kitPngDir, `minnow-lockup-stacked-${width}.png`),
  })),
]);

for (const name of ['minnow-512.png', 'minnow-1024.png', 'minnow-lockup-horizontal-1440.png']) {
  fs.copyFileSync(path.join(kitPngDir, name), path.join(logosDir, name));
  console.log(`[render-logos] public/logos/${name}`);
}

// ── Favicon ─────────────────────────────────────────────────────────────────

const ico = await pngToIco([16, 32, 48].map((s) => path.join(kitPngDir, `minnow-favicon-${s}.png`)));
write(path.join(kitPngDir, 'favicon.ico'), ico);
write(path.join(logosDir, 'favicon.ico'), ico);
