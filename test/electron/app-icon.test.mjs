import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('all desktop packages use the current logo assets and ship runtime icons', () => {
  const png = 'public/logos/minnow-logo/minnow/png/minnow-1024.png';
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.equal(pkg.build.mac.icon, png);
  assert.equal(pkg.build.linux.icon, png);
  for (const icon of ['build/icon.ico', png]) {
    assert.ok(pkg.build.files.includes(icon));
    assert.ok(fs.existsSync(new URL(`../../${icon}`, import.meta.url)));
  }
});

test('macOS explicitly sets its Dock icon after readiness', () => {
  assert.match(read('electron/main.ts'), /app\.whenReady\(\)\.then\(\(\) => \{[\s\S]*?if \(process\.platform === 'darwin'\) app\.dock\?\.setIcon\(appIconPath\(\)\)/);
});

test('packaging refreshes icons before invoking electron-builder', () => {
  const script = read('scripts/electron-builder-run.mjs');
  assert.ok(script.indexOf("['scripts/sync-app-icon.mjs']") < script.indexOf('const builderArgs'));
  assert.match(script, /if \(syncIcon\.status !== 0\) process\.exit/);
});
