import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-reef-identity-')));
process.env.MINNOW_HOME = home;
const { productName, packageName, iconProblem, fallbackIconSvg, icoFromPngs, icnsFromPngs, ICO_SIZES } = await import('../../server/reef/icon.js');
const { exportConfig, exportFilename } = await import('../../server/reef/exports.js');
const { attachmentDisposition } = await import('../../server/reef/middleware.js');
const { checkProject } = await import('../../server/reef/pipeline.js');
after(async () => { await fs.rm(home, { recursive: true, force: true }); });

const app = { id: '3f2a1b4c-0000-4000-8000-000000000001', name: 'Focus Timer', description: 'A focus timer\nwith breaks' };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="g"/></defs><rect width="1024" height="1024" rx="220" fill="url(#g)"/></svg>';

test('exports are named after the app, never its id', () => {
  assert.equal(productName(app), 'Focus Timer');
  assert.equal(productName({ name: '  Notes: "draft" / v2.  ' }), 'Notes draft v2');
  assert.equal(productName({ name: 'CON' }), 'CON app');
  assert.equal(productName({ name: '???' }), 'Reef utility');
  assert.equal(packageName({ name: 'Café Notes!' }), 'cafe-notes');
  assert.equal(packageName({ name: '📝' }), 'reef-utility');
  assert.equal(exportFilename(app, { method: 'local', target: 'win32', arch: 'x64' }), 'Focus Timer.exe');
  assert.equal(exportFilename(app, { method: 'github', target: 'win32', arch: 'arm64' }), 'Focus Timer (ARM64).exe');
  assert.equal(exportFilename(app, { method: 'github', target: 'darwin', arch: 'arm64' }), 'Focus Timer-macOS-arm64.zip');
  assert.equal(exportFilename(app, { method: 'docker', target: 'linux', arch: 'x64' }), 'Focus Timer-linux.tar.gz');
  assert.equal(exportFilename(app, { method: 'source', target: 'linux', arch: 'x64' }), 'Focus Timer source.zip');
  for (const item of [{ method: 'local', target: 'win32' }, { method: 'source', target: 'darwin' }]) assert.doesNotMatch(exportFilename(app, item), new RegExp(app.id));
});

test('builder config stamps the icon and version info without code signing', () => {
  const config = exportConfig(app);
  assert.equal(config.productName, 'Focus Timer');
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.win.signAndEditExecutable, undefined, 'signAndEditExecutable:false would skip the icon and metadata');
  assert.equal(config.win.icon, 'reef-build/icon.ico');
  assert.equal(config.mac.icon, 'reef-build/icon.icns');
  assert.equal(config.linux.icon, 'reef-build/icon.png');
  assert.equal(config.linux.executableName, 'focus-timer');
  assert.equal(config.portable.artifactName, '${productName}.${ext}');
  assert.ok(config.files.includes('!reef-build/**') && config.files.includes('!icon.svg'));
  const bare = exportConfig(app, { icons: false });
  assert.equal(bare.win.icon, undefined); assert.equal(bare.mac.icon, undefined); assert.equal(bare.linux.icon, undefined);
});

test('icon.svg must be a self-contained square SVG', () => {
  assert.equal(iconProblem(svg), '');
  assert.match(iconProblem(svg.replace(' viewBox="0 0 1024 1024"', '')), /square viewBox/);
  assert.match(iconProblem(svg.replace('0 0 1024 1024', '0 0 1024 512')), /square viewBox/);
  assert.match(iconProblem(svg.replace('<defs>', '<script>alert(1)</script><defs>')), /scripts/);
  assert.match(iconProblem(svg.replace('<rect', '<rect onclick="x()"')), /event handlers/);
  assert.match(iconProblem(svg.replace('<defs>', '<image href="https://example.com/a.png"/><defs>')), /self-contained/);
  assert.match(iconProblem(svg.replace('url(#g)', 'url(https://example.com/a.svg#g)')), /self-contained/);
  assert.match(iconProblem('<html><svg viewBox="0 0 1 1"></svg></html>'), /single <svg>/);
  assert.match(iconProblem(`${svg.slice(0, -6)}${' '.repeat(110 * 1024)}</svg>`), /100 KB/);
});

test('generated monogram icons are valid, stable per app, and escape the name', () => {
  assert.equal(iconProblem(fallbackIconSvg(app)), '');
  assert.equal(fallbackIconSvg(app), fallbackIconSvg({ ...app }));
  assert.match(fallbackIconSvg(app), />FT<\/text>/);
  assert.match(fallbackIconSvg({ ...app, name: 'calc' }), />C<\/text>/);
  assert.notEqual(fallbackIconSvg(app), fallbackIconSvg({ ...app, id: '9a8b7c6d-0000-4000-8000-000000000002' }));
});

test('ICO and ICNS containers index every PNG', () => {
  const png = size => Buffer.from(`png-${size}`);
  const ico = icoFromPngs(ICO_SIZES.map(size => ({ size, data: png(size) })));
  assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
  ICO_SIZES.forEach((size, index) => {
    const at = 6 + index * 16;
    assert.equal(ico[at], size >= 256 ? 0 : size);
    const length = ico.readUInt32LE(at + 8), offset = ico.readUInt32LE(at + 12);
    assert.equal(ico.subarray(offset, offset + length).toString(), `png-${size}`);
  });
  const icns = icnsFromPngs(new Map([16, 32, 64, 128, 256, 512, 1024].map(size => [size, png(size)])));
  assert.equal(icns.subarray(0, 4).toString('latin1'), 'icns'); assert.equal(icns.readUInt32BE(4), icns.length);
  const types = [];
  for (let at = 8; at < icns.length; at += icns.readUInt32BE(at + 4)) types.push(icns.subarray(at, at + 4).toString('latin1'));
  assert.deepEqual(types, ['icp4', 'icp5', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']);
});

test('download names survive any letters in the app name', () => {
  assert.equal(attachmentDisposition('Focus Timer.exe'), `attachment; filename="Focus Timer.exe"; filename*=UTF-8''Focus%20Timer.exe`);
  assert.equal(attachmentDisposition('Café (ARM64).exe'), `attachment; filename="Cafe (ARM64).exe"; filename*=UTF-8''Caf%C3%A9%20%28ARM64%29.exe`);
  assert.match(attachmentDisposition('日記.exe'), /filename="__\.exe"/);
});

test('an unusable icon.svg fails the build check so the Builder repairs it', async () => {
  const workspace = path.join(home, 'workspace');
  await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vite: '8.1.5', typescript: '5.9.3' } }));
  await fs.writeFile(path.join(workspace, 'test', 'app.test.mjs'), '');
  assert.deepEqual(await checkProject(workspace), ['app.test.mjs'], 'icon.svg is optional');
  await fs.writeFile(path.join(workspace, 'icon.svg'), svg);
  await checkProject(workspace);
  await fs.writeFile(path.join(workspace, 'icon.svg'), svg.replace('<defs>', '<script>x</script><defs>'));
  await assert.rejects(checkProject(workspace), /scripts/);
});
