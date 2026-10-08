import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertAllowedGitHubUrl } from '../skills/library/github-fetch.js';
import { resolveSafePath } from '../runtime/path-access.js';
import { readPackage, relativeFile } from './manifest.js';
import { MAX_ARCHIVE_BYTES, readGitHubArchive, selectArchivePlugin } from './github-archive.js';

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

async function githubBytes(url, limit, signal) {
  await assertAllowedGitHubUrl(url);
  const response = await fetch(url, { headers: { 'User-Agent': 'minnow-plugins' }, redirect: 'error', signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub source archive download failed (${response.status}). Check the URL and that the repository is public${response.status === 403 || response.status === 429 ? ', or try again later' : ''}.`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Repository archive exceeds the download size limit (16 MiB). Use a local plugin folder instead.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function githubPackage(source, reviewedCommit) {
  const { repo, ref, subpath } = parsePluginGitHubUrl(source);
  const signal = AbortSignal.timeout(60000);
  if (reviewedCommit !== undefined && !/^[0-9a-f]{40}$/.test(reviewedCommit)) throw new Error('Invalid reviewed GitHub commit.');
  const compressed = await githubBytes(`https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(reviewedCommit ?? ref)}`, MAX_ARCHIVE_BYTES, signal);
  const { entries, commit } = readGitHubArchive(compressed);
  if (reviewedCommit && commit !== reviewedCommit) throw new Error('GitHub archive does not match the reviewed commit.');
  const { files, folder } = selectArchivePlugin(entries, subpath);
  if (!subpath && folder) source = `https://github.com/${repo}/tree/${encodeURIComponent(ref)}/${folder.split('/').map(encodeURIComponent).join('/')}`;
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
