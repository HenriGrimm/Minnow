import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertAllowedGitHubUrl } from '../skills/library/github-fetch.js';
import { resolveSafePath } from '../runtime/path-access.js';
import { MAX_PACKAGE_BYTES, readPackage, relativeFile } from './manifest.js';

export function parsePluginGitHubUrl(source) {
  let url;
  try { url = new URL(source); } catch { throw new Error('Enter a GitHub repository URL or a plugin folder.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS github.com repository or folder URL.');
  }
  const parts = url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent);
  const [owner, repository, kind, ref, ...folders] = parts;
  const repo = repository?.replace(/\.git$/, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(owner ?? '') || !/^[a-zA-Z0-9_.-]+$/.test(repo ?? '') || repo === '.' || repo === '..' ||
      (kind !== undefined && (kind !== 'tree' || !ref || !/^[a-zA-Z0-9_./-]+$/.test(ref)))) {
    throw new Error('Use a GitHub repository URL or a /tree/branch/plugin-folder URL.');
  }
  const subpath = folders.join('/');
  if (subpath) relativeFile(subpath);
  return { repo: `${owner}/${repo}`, ref: ref ?? 'HEAD', subpath };
}

async function githubBytes(url, limit, signal, accept = 'application/vnd.github+json') {
  await assertAllowedGitHubUrl(url);
  const response = await fetch(url, { headers: { 'User-Agent': 'minnow-plugins', Accept: accept }, redirect: 'error', signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub download failed (${response.status}). Check the URL and that the repository is public${response.status === 403 || response.status === 429 ? ', or retry after the GitHub rate limit resets' : ''}.`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('GitHub download exceeds the plugin size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function githubPackage(source, reviewedCommit) {
  const { repo, ref, subpath } = parsePluginGitHubUrl(source);
  const signal = AbortSignal.timeout(60000);
  if (reviewedCommit !== undefined && !/^[0-9a-f]{40}$/.test(reviewedCommit)) throw new Error('Invalid reviewed GitHub commit.');
  const commit = reviewedCommit ?? (await githubBytes(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, 128, signal, 'application/vnd.github.sha')).toString('utf8').trim();
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('GitHub returned an invalid commit.');
  const tree = JSON.parse((await githubBytes(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`, 16 * 1024 * 1024, signal)).toString('utf8'));
  if (!Array.isArray(tree.tree) || tree.truncated) throw new Error('GitHub returned an incomplete repository tree. Use a local plugin folder instead.');
  const prefix = subpath ? `${subpath}/` : '';
  const entries = tree.tree.filter(entry => typeof entry.path === 'string' && entry.path.startsWith(prefix));
  if (!entries.some(entry => entry.path === `${prefix}plugin.json` && entry.type === 'blob')) throw new Error('No plugin.json found. Paste the GitHub URL of the folder containing plugin.json.');
  if (entries.length > 512) throw new Error('Plugin directory tree is too large.');
  const files = [];
  let total = 0;
  for (const entry of entries) {
    const name = relativeFile(entry.path.slice(prefix.length));
    if (entry.type === 'tree') continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`Links and submodules are not allowed: ${name}`);
    if (files.length >= 256 || !Number.isSafeInteger(entry.size) || entry.size < 0 || total + entry.size > MAX_PACKAGE_BYTES) throw new Error('Plugin exceeds 8 MiB or 256 files.');
    const bytes = await githubBytes(`https://raw.githubusercontent.com/${repo}/${commit}/${entry.path.split('/').map(encodeURIComponent).join('/')}`, MAX_PACKAGE_BYTES - total, signal);
    total += bytes.length;
    files.push({ name, bytes });
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-plugin-'));
  try {
    for (const file of files) {
      const target = path.join(temp, file.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.bytes, { flag: 'wx' });
    }
    return { ...await readPackage(temp), source, commit };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

export async function readPluginSource(source, { allowExternal = false, commit } = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('A GitHub URL or plugin folder is required.');
  source = source.trim();
  if (/^https?:\/\//i.test(source)) return githubPackage(source, commit);
  const candidate = allowExternal && path.isAbsolute(source) ? path.resolve(source) : resolveSafePath(source);
  const resolved = await fs.realpath(candidate);
  if (!allowExternal) resolveSafePath(resolved);
  return { ...await readPackage(resolved), source: resolved };
}
