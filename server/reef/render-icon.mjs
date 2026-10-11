// Host-owned icon rasterizer. The SVG renders through <img>, which never runs its script or fetches.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [playwrightPath, svgFile, outDir] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const source = `data:image/svg+xml;base64,${(await fs.readFile(svgFile)).toString('base64')}`;
// macOS icons sit inside Apple's 824/1024 grid; Windows and Linux icons are full-bleed.
const sets = [['win', 0, [16, 24, 32, 48, 64, 128, 256, 512]], ['mac', 100 / 1024, [16, 32, 64, 128, 256, 512, 1024]]];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  for (const [prefix, inset, sizes] of sets) {
    for (const size of sizes) {
      const pad = Math.round(size * inset), art = size - pad * 2;
      await page.setContent(`<!doctype html><body style="margin:0;background:transparent"><img id="icon" alt="" src="${source}" width="${art}" height="${art}" style="display:block;margin:${pad}px"></body>`);
      const decoded = await page.locator('#icon').evaluate(image => image.decode().then(() => true, () => false));
      if (!decoded) throw new Error('icon.svg could not be rendered');
      await page.screenshot({ path: path.join(outDir, `${prefix}-${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    }
  }
} finally { await browser.close(); }
