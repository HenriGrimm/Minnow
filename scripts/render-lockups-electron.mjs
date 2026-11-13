/**
 * Electron helper for scripts/render-logos.mjs: rasterises lockup SVGs with the
 * bundled Geist fonts (sharp/librsvg cannot read woff2). Not meant to be run on
 * its own: `electron scripts/render-lockups-electron.mjs <jobs.json>`, where
 * jobs.json is `[{ svg, width, height, out }]`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontDir = path.join(root, 'src', 'styles', 'vendor', 'geist');
const jobs = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'));

function fontFace(family, file) {
  return `@font-face{font-family:'${family}';font-weight:100 900;src:url('${pathToFileURL(path.join(fontDir, file)).href}') format('woff2');}`;
}

let win;

async function render(job) {
  const html =
    '<!doctype html><meta charset="utf-8"><style>' +
    fontFace('Geist', 'geist-latin.woff2') +
    fontFace('Geist Mono', 'geist-mono-latin.woff2') +
    'html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>' +
    job.svg.replace(/width="[\d.]+" height="[\d.]+"/, `width="${job.width}" height="${job.height}"`);
  const file = path.join(os.tmpdir(), `minnow-lockup-${process.pid}-${path.basename(job.out)}.html`);
  fs.writeFileSync(file, html);
  win.setContentSize(job.width, job.height);
  try {
    await win.loadFile(file);
    await win.webContents.executeJavaScript(
      "Promise.all([document.fonts.load('600 64px \"Geist Mono\"'), document.fonts.load('400 20px Geist')]).then(() => document.fonts.ready).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))",
    );
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: job.width, height: job.height });
    const png = image.resize({ width: job.width, height: job.height, quality: 'best' }).toPNG();
    fs.mkdirSync(path.dirname(job.out), { recursive: true });
    fs.writeFileSync(job.out, png);
    console.log(`[render-logos] ${path.relative(root, job.out)}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 800,
    height: 800,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, deviceScaleFactor: 1 },
  });
  try {
    for (const job of jobs) await render(job);
    app.exit(0);
  } catch (err) {
    console.error('[render-logos] lockup render failed:', err);
    app.exit(1);
  }
});
