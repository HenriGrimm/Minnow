#!/usr/bin/env node

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rcedit } from 'rcedit';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function resolveElectronExe() {
  try {
    const electronPath = require('electron');
    return electronPath && fs.existsSync(electronPath) ? electronPath : null;
  } catch {
    return null;
  }
}

async function main() {
  if (process.platform !== 'win32') {
    return;
  }

  const exe = resolveElectronExe();
  if (!exe) {
    console.warn('[brand-electron-win] electron.exe not found; skipping taskbar branding.');
    return;
  }

  const icon = path.join(root, 'build', 'icon.ico');
  if (!fs.existsSync(icon)) {
    console.warn('[brand-electron-win] build/icon.ico missing; run npm run app-icon:sync first.');
    return;
  }

  // Windows names the per-user Start Menu shortcut Electron writes for toast
  // notifications after this string. Branding the dev binary as the shipped
  // product put a `Minnow` shortcut pointing at bare electron.exe in front of
  // the installer's own entry, so launching Minnow from the Start Menu opened
  // Electron's welcome screen instead. Dev gets its own name.
  const productName = `${pkg.build?.productName ?? 'Minnow'} Dev`;
  const company = typeof pkg.author === 'string' ? pkg.author : 'Grim Media';
  const version = typeof pkg.version === 'string' ? pkg.version : '1.0.0';

  await rcedit(exe, {
    icon,
    'file-version': version,
    'product-version': version,
    'version-string': {
      CompanyName: company,
      FileDescription: productName,
      ProductName: productName,
      LegalCopyright: `Copyright (c) ${company}`,
    },
  });

  console.log(`[brand-electron-win] Taskbar icon set on ${exe}`);
}

main().catch((err) => {
  console.error('[brand-electron-win]', err.message || err);
  process.exit(1);
});
