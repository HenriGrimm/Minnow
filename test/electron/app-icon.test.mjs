import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import zlib from 'node:zlib';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const iconFile = (file) => new URL(`../../${file}`, import.meta.url);
const pkg = JSON.parse(read('package.json'));

/**
 * Reads the IHDR fields plus the first scanline of an RGBA PNG. A fully
 * transparent first row always inflates to zero bytes, whichever filter the
 * encoder chose, so this needs no row unfiltering.
 */
function pngInfo(file) {
  const png = fs.readFileSync(iconFile(file));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  const idat = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const scanlines = zlib.inflateSync(Buffer.concat(idat));
  return { width, height, bitDepth, colorType, firstScanline: scanlines.subarray(0, 1 + width * 4) };
}

test('all desktop packages use the current logo assets and ship runtime icons', () => {
  const png = 'public/logos/minnow-logo/minnow/png/minnow-1024.png';
  const macIcon = 'build/icon-mac.png';
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.equal(pkg.build.mac.icon, macIcon);
  assert.equal(pkg.build.linux.icon, png);
  for (const icon of ['build/icon.ico', png, macIcon]) {
    assert.ok(pkg.build.files.includes(icon));
    assert.ok(fs.existsSync(iconFile(icon)));
  }
});

test('the macOS app icon keeps the inset macOS draws its Dock tiles with', () => {
  const icon = pngInfo('build/icon-mac.png');
  assert.equal(icon.width, 1024);
  assert.equal(icon.height, 1024);
  assert.equal(icon.bitDepth, 8);
  assert.equal(icon.colorType, 6);
  // Row 0 sits above the 824 px tile: a full-bleed icon would paint it opaque
  // and then read oversized next to system apps in the Dock.
  assert.ok(icon.firstScanline.every((byte) => byte === 0));
  // The padding must not have swallowed the artwork.
  assert.ok(fs.statSync(iconFile('build/icon-mac.png')).size > 10_000);
});

test('macOS explicitly sets its Dock icon after readiness', () => {
  assert.match(read('electron/main.ts'), /app\.whenReady\(\)\.then\(\(\) => \{[\s\S]*?if \(process\.platform === 'darwin'\) app\.dock\?\.setIcon\(appIconPath\(\)\)/);
});

test('packaging refreshes icons before invoking electron-builder', () => {
  const script = read('scripts/electron-builder-run.mjs');
  assert.ok(script.indexOf("['scripts/sync-app-icon.mjs']") < script.indexOf('const builderArgs'));
  assert.match(script, /if \(syncIcon\.status !== 0\) process\.exit/);
});
