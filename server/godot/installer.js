/** Managed, checksum-verified Godot 4 runtime installation. */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { downloadToFile, extractArchive } from '../lsp/bundle-installer.js';

const RELEASES_URL = 'https://api.github.com/repos/godotengine/godot-builds/releases?per_page=100';
const USER_AGENT = 'minnow-godot-installer';
let installPromise = null;
let installerTestHooks = null;

export function getManagedGodotRoot() {
  return path.join(getMinnowHome(), 'runtimes', 'godot');
}

function manifestPath() {
  return path.join(getManagedGodotRoot(), 'installed.json');
}

export async function readManagedGodotInstall() {
  try {
    const parsed = JSON.parse(await fsp.readFile(manifestPath(), 'utf8'));
    if (typeof parsed?.executable !== 'string') return null;
    const executable = path.resolve(parsed.executable);
    if (!(await fsp.stat(executable).catch(() => null))?.isFile()) return null;
    return { ...parsed, executable };
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const fetchImpl = installerTestHooks?.fetch ?? fetch;
  const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`Unable to resolve Godot releases (HTTP ${response.status})`);
  return response.json();
}

export function selectStableGodotRelease(releases, requestedVersion) {
  const requested = String(requestedVersion ?? '').trim().replace(/^v/, '');
  const stable = (Array.isArray(releases) ? releases : [])
    .filter((release) => !release?.draft && !release?.prerelease && /^4\.\d+(?:\.\d+)?-stable$/.test(String(release?.tag_name ?? '')))
    .sort((a, b) => String(b.tag_name).localeCompare(String(a.tag_name), undefined, { numeric: true }));
  const selected = requested
    ? stable.find((release) => release.tag_name === requested || release.tag_name === `${requested}-stable`)
    : stable[0];
  if (!selected) throw new Error(requested ? `Godot ${requested} stable was not found` : 'No stable Godot 4 release was found');
  return selected;
}

export function selectGodotAsset(assets, platform = process.platform, arch = process.arch) {
  const list = (Array.isArray(assets) ? assets : []).filter((asset) => {
    const name = String(asset?.name ?? '');
    return asset?.browser_download_url && name.endsWith('.zip') && !/_mono_|export_templates|web_editor|android/i.test(name);
  });
  let pattern;
  if (platform === 'win32') {
    pattern = arch === 'arm64' ? /_windows_arm64\.exe\.zip$/i : arch === 'ia32' ? /_win32\.exe\.zip$/i : /_win64\.exe\.zip$/i;
  } else if (platform === 'darwin') {
    pattern = /_macos\.universal\.zip$/i;
  } else if (platform === 'linux') {
    pattern = arch === 'arm64' ? /_linux\.arm64\.zip$/i : arch === 'arm' ? /_linux\.arm32\.zip$/i : arch === 'ia32' ? /_linux\.x86_32\.zip$/i : /_linux\.x86_64\.zip$/i;
  } else {
    throw new Error(`Managed Godot installation is not supported on ${platform}`);
  }
  const asset = list.find((candidate) => pattern.test(candidate.name));
  if (!asset) throw new Error(`No Godot build is available for ${platform}/${arch}`);
  return asset;
}

async function sha512File(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export function checksumForAsset(checksumText, assetName) {
  for (const line of String(checksumText ?? '').split(/\r?\n/)) {
    const match = /^([a-f0-9]{128})\s+[*]?(.+?)\s*$/i.exec(line);
    if (match && match[2] === assetName) return match[1].toLowerCase();
  }
  return null;
}

async function findManagedExecutable(root, platform = process.platform) {
  const candidates = [];
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (platform === 'win32' ? /^Godot.*\.exe$/i.test(entry.name) : entry.name === 'Godot' || /^Godot_v4/i.test(entry.name)) candidates.push(absolute);
    }
  }
  await walk(root);
  candidates.sort((a, b) => {
    const aConsole = /console\.exe$/i.test(a) ? 1 : 0;
    const bConsole = /console\.exe$/i.test(b) ? 1 : 0;
    return bConsole - aConsole || a.localeCompare(b);
  });
  return candidates[0] ?? null;
}

async function writeManifest(manifest) {
  await fsp.mkdir(path.dirname(manifestPath()), { recursive: true });
  const temporary = `${manifestPath()}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  try {
    await fsp.rename(temporary, manifestPath());
  } catch (err) {
    if (!['EEXIST', 'EPERM'].includes(err?.code)) throw err;
    await fsp.rm(manifestPath(), { force: true });
    await fsp.rename(temporary, manifestPath());
  }
}

async function performInstall(options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  onProgress({ phase: 'resolving', percent: 2, message: 'Finding the latest stable Godot 4 release' });
  const releases = await fetchJson(RELEASES_URL);
  const release = selectStableGodotRelease(releases, options.version);
  const existing = await readManagedGodotInstall();
  if (existing?.version === release.tag_name) {
    onProgress({ phase: 'complete', percent: 100, message: `Godot ${release.tag_name} is already ready` });
    return { installed: true, alreadyInstalled: true, managed: true, ...existing };
  }
  const asset = selectGodotAsset(release.assets, options.platform, options.arch);
  const checksumAsset = release.assets.find((candidate) => candidate.name === 'SHA512-SUMS.txt');
  if (!checksumAsset?.browser_download_url) throw new Error('Godot release has no SHA512 checksum manifest');

  const fetchImpl = installerTestHooks?.fetch ?? fetch;
  const checksumResponse = await fetchImpl(checksumAsset.browser_download_url, { headers: { 'User-Agent': USER_AGENT } });
  if (!checksumResponse.ok) throw new Error(`Unable to download Godot checksums (HTTP ${checksumResponse.status})`);
  const expectedChecksum = checksumForAsset(await checksumResponse.text(), asset.name);
  if (!expectedChecksum) throw new Error(`Godot checksum is missing for ${asset.name}`);

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-godot-'));
  const archivePath = path.join(tmpRoot, asset.name);
  const tag = String(release.tag_name);
  const destination = path.join(getManagedGodotRoot(), tag);
  try {
    onProgress({ phase: 'downloading', percent: 5, message: `Downloading Godot ${tag}` });
    const downloader = installerTestHooks?.download ?? downloadToFile;
    await downloader(asset.browser_download_url, archivePath, (percent) => {
      onProgress({ phase: 'downloading', percent: Math.min(80, Number(percent) || 5), message: `Downloading ${asset.name}` });
    });
    const actualChecksum = await sha512File(archivePath);
    if (actualChecksum !== expectedChecksum) throw new Error(`Checksum mismatch for ${asset.name}; the archive was not installed`);

    onProgress({ phase: 'extracting', percent: 85, message: `Installing Godot ${tag}` });
    const extractDir = path.join(tmpRoot, 'extract');
    await (installerTestHooks?.extract ?? extractArchive)(archivePath, extractDir);
    const executable = await findManagedExecutable(extractDir, options.platform ?? process.platform);
    if (!executable) throw new Error(`Godot executable was not found in ${asset.name}`);
    await fsp.mkdir(getManagedGodotRoot(), { recursive: true });
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.rename(extractDir, destination);
    const installedExecutable = path.join(destination, path.relative(extractDir, executable));
    if ((options.platform ?? process.platform) !== 'win32') await fsp.chmod(installedExecutable, 0o755);
    const manifest = {
      version: tag,
      executable: installedExecutable,
      asset: asset.name,
      sha512: actualChecksum,
      installedAt: new Date().toISOString(),
      source: 'godotengine/godot-builds',
    };
    await writeManifest(manifest);
    onProgress({ phase: 'complete', percent: 100, message: `Godot ${tag} is ready` });
    return { installed: true, managed: true, ...manifest };
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

export function installManagedGodot(options = {}) {
  if (!installPromise) installPromise = performInstall(options).finally(() => { installPromise = null; });
  return installPromise;
}

export function __setGodotInstallerTestHooks(hooks) {
  installerTestHooks = hooks;
}

export function __resetGodotInstallerForTests() {
  installerTestHooks = null;
  installPromise = null;
}
