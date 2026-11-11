import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ICON_BYTES = 128 * 1024;
const MAX_HTML_BYTES = 64 * 1024;
const MIME_TYPES = new Map([
  ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.avif', 'image/avif'],
]);
const HTML_FILES = ['index.html', 'public/index.html', 'src/index.html', 'src/app.html'];
const ICON_NAMES = ['favicon.svg', 'favicon.ico', 'favicon.png', 'favicon.webp'];
const CONVENTIONAL_PATHS = [
  ...['', 'public', 'static', 'app', 'src', 'src/app'].flatMap((dir) =>
    ICON_NAMES.map((name) => path.join(dir, name))),
  ...['app', 'src/app', 'assets'].flatMap((dir) =>
    ['icon.svg', 'icon.png', 'icon.ico'].map((name) => path.join(dir, name))),
  'assets/logo.svg', 'assets/logo.png',
];

async function readProjectFile(root, relative, limit, { prefix = false } = {}) {
  try {
    const file = await fs.realpath(path.resolve(root, relative));
    const fromRoot = path.relative(root, file);
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return null;
    if (path.extname(file).toLowerCase() !== path.extname(relative).toLowerCase()) return null;

    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (!prefix && stat.size > limit)) return null;
      const buffer = Buffer.alloc(Math.min(stat.size, limit));
      const { bytesRead } = await handle.read({ buffer, position: 0 });
      return bytesRead ? buffer.subarray(0, bytesRead) : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function* htmlIconPaths(html, htmlPath) {
  const markup = html.replace(/<!--[\s\S]*?(?:-->|$)|<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, '');
  for (const [tag] of markup.matchAll(/<link\s+[^<>]*>/gi)) {
    const attributes = new Map();
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of tag.matchAll(/\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g)) {
      attributes.set(name.toLowerCase(), doubleQuoted ?? singleQuoted ?? unquoted);
    }
    if (!/^(?:icon|shortcut icon|apple-touch-icon)$/i.test(attributes.get('rel')?.trim() ?? '')) continue;
    const href = attributes.get('href')?.trim().split(/[?#]/, 1)[0];
    if (!href) continue;
    let local;
    try {
      local = decodeURIComponent(href.replace(/^%sveltekit\.assets%\//, '/'));
    } catch {
      continue;
    }
    if (/^\/\/|[:\\\x00-\x1f]/.test(local)) continue;
    if (local.startsWith('/')) {
      for (const dir of ['public', 'static', '']) yield path.join(dir, local.slice(1));
    } else {
      yield path.join(path.dirname(htmlPath), local);
    }
  }
}

/** Resolve a small, local image from an already-registered recent workspace. */
export async function readWorkspaceProjectIcon(workspacePath) {
  const root = await fs.realpath(workspacePath).catch(() => null);
  if (!root) return undefined;

  const candidates = new Set();
  for (const htmlPath of HTML_FILES) {
    const html = await readProjectFile(root, htmlPath, MAX_HTML_BYTES, { prefix: true });
    if (html) {
      for (const iconPath of htmlIconPaths(html.toString('utf8'), htmlPath)) {
        candidates.add(iconPath);
        if (candidates.size >= 24) break;
      }
    }
    if (candidates.size >= 24) break;
  }

  for (const candidate of [...candidates, ...CONVENTIONAL_PATHS]) {
    const mime = MIME_TYPES.get(path.extname(candidate).toLowerCase());
    if (!mime) continue;
    const image = await readProjectFile(root, candidate, MAX_ICON_BYTES);
    if (image) return `data:${mime};base64,${image.toString('base64')}`;
  }
  return undefined;
}
