import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { command } from './process.js';
import { hostScript } from './host-scripts.js';

/** The Builder draws the app icon here; exports fall back to a generated monogram. */
export const ICON_FILE = 'icon.svg';
const MAX_ICON_BYTES = 100 * 1024;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** The name an exported app carries on its window, executable, menu and download. */
export function productName(app) {
  const name = app.name.replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 70).trim();
  if (!name) return 'Reef utility';
  return RESERVED_WINDOWS_NAMES.test(name) ? `${name} app` : name;
}
/** npm-valid package name; Linux uses it for the executable. */
export function packageName(app) {
  return app.name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'reef-utility';
}

/** Why an icon.svg cannot be used, or '' when it can. Rendering as an image already blocks script and fetches. */
export function iconProblem(svg) {
  if (Buffer.byteLength(svg) > MAX_ICON_BYTES) return 'icon.svg must be smaller than 100 KB';
  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) return 'icon.svg must contain a single <svg> element';
  if (!/\bviewBox\s*=\s*["']\s*0[\s,]+0[\s,]+(\d+(?:\.\d+)?)[\s,]+\1\s*["']/i.test(svg)) return 'icon.svg needs a square viewBox such as viewBox="0 0 1024 1024"';
  if (/<(script|foreignObject|iframe|object|embed)\b/i.test(svg) || /\son[a-z]+\s*=/i.test(svg)) return 'icon.svg cannot contain scripts, event handlers or embedded documents';
  if (/@import/i.test(svg)) return 'icon.svg cannot import stylesheets';
  for (const match of svg.matchAll(/(?:href\s*=\s*["']|url\(\s*["']?)([^"')\s]*)/gi)) {
    if (!match[1].startsWith('#') && !/^data:image\/(png|jpeg|webp);base64,/i.test(match[1])) return 'icon.svg must be self-contained and reference only its own #ids';
  }
  return '';
}

const escapeXml = text => text.replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`);
/** Deterministic monogram for apps built before icons existed, or whose icon cannot render. */
export function fallbackIconSvg(app) {
  const hue = createHash('sha256').update(app.id).digest().readUInt16BE(0) % 360;
  const words = productName(app).split(/[\s._-]+/).filter(word => /^[\p{L}\p{N}]/u.test(word));
  const letters = (words.length > 1 ? words.slice(0, 2) : [words[0] ?? 'R']).map(word => [...word][0]).join('').toLocaleUpperCase();
  const size = words.length > 1 ? 400 : 500;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 72% 58%)"/><stop offset="1" stop-color="hsl(${(hue + 36) % 360} 68% 40%)"/></linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <rect width="1024" height="1024" rx="228" fill="url(#shine)"/>
  <text x="512" y="512" dy=".35em" text-anchor="middle" font-family="'Segoe UI', 'SF Pro Display', -apple-system, system-ui, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="600" fill="#fff" letter-spacing="-8">${escapeXml(letters)}</text>
</svg>
`;
}

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// [type, pixels]: ic11–ic14 and ic10 are the @2x retina slots.
const ICNS_TYPES = [['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
/** PNG-compressed ICO (Windows Vista+); electron-builder uses it as-is, without its icon toolset download. */
export function icoFromPngs(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, data }, index) => {
    const at = 6 + 16 * index;
    header[at] = header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map(entry => entry.data)]);
}
export function icnsFromPngs(bySize) {
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const head = Buffer.alloc(8); head.write(type, 0, 'latin1'); head.writeUInt32BE(bySize.get(size).length + 8, 4);
    return Buffer.concat([head, bySize.get(size)]);
  });
  const head = Buffer.alloc(8); head.write('icns', 0, 'latin1'); head.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

/**
 * Rasterize the icon in Chromium and write icon.ico, icon.icns and icon.png into
 * `folder`. The macOS set is inset to Apple's 824/1024 grid; Windows stays full-bleed.
 */
export async function renderIconSet(svg, folder, { tools, browser, options = {}, execute = command }) {
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, ICON_FILE), svg);
  await execute(tools.node, [await hostScript('render-icon.mjs'), browser.entry, path.join(folder, ICON_FILE), folder], { ...options, env: browser.env, timeout: 120000 });
  const read = async (prefix, size) => fs.readFile(path.join(folder, `${prefix}-${size}.png`));
  const ico = await Promise.all(ICO_SIZES.map(async size => ({ size, data: await read('win', size) })));
  const mac = new Map();
  for (const size of new Set(ICNS_TYPES.map(([, pixels]) => pixels))) mac.set(size, await read('mac', size));
  await fs.writeFile(path.join(folder, 'icon.ico'), icoFromPngs(ico));
  await fs.writeFile(path.join(folder, 'icon.icns'), icnsFromPngs(mac));
  await fs.copyFile(path.join(folder, 'win-512.png'), path.join(folder, 'icon.png'));
}
