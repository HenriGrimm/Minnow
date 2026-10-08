import fs from 'node:fs/promises';
import path from 'node:path';
import { gh, processError } from './forge-ops.js';
import { remoteContext, github, segment, pageNumber, positiveId, inside } from './action-common.js';

export function normalizeRelease(raw) {
  return {
    id: raw.id,
    tag: raw.tag_name,
    title: raw.name || raw.tag_name,
    body: raw.body || '',
    target: raw.target_commitish,
    draft: raw.draft,
    prerelease: raw.prerelease,
    immutable: raw.immutable === true,
    url: raw.html_url,
    createdAt: raw.created_at,
    publishedAt: raw.published_at,
    assets: (raw.assets || []).map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
      downloads: a.download_count,
    })),
  };
}
export async function releaseList(args = {}) {
  const context = await remoteContext(args.cwd);
  const rows = await github(context, `releases?per_page=30&page=${pageNumber(args.page)}`);
  return {
    ok: true,
    releases: rows.map(normalizeRelease),
    hasMore: rows.length === 30,
    repo: `${context.hostname}/${context.repo}`,
  };
}
async function load(context, id, writable = false) {
  const release = await github(context, `releases/${positiveId(id)}`);
  if (writable && release.immutable)
    throw new Error('This release is immutable and cannot be changed');
  return release;
}
export async function releaseView(args) {
  const context = await remoteContext(args.cwd);
  const [release, repo] = await Promise.all([load(context, args.id), github(context, '')]);
  return {
    ok: true,
    release: normalizeRelease(release),
    canWrite: repo.permissions?.push === true || repo.permissions?.admin === true,
    repo: `${context.hostname}/${context.repo}`,
  };
}
export async function releaseCreate(args) {
  const context = await remoteContext(args.cwd);
  if (typeof args.tag !== 'string' || !args.tag.trim() || args.tag.startsWith('-'))
    throw new Error('A tag is required');
  let target;
  if (args.createTag) {
    if (!/^[a-f0-9]{40}$/i.test(args.target || ''))
      throw new Error('Creating a tag requires the selected remote commit SHA');
    target = (await github(context, `commits/${segment(args.target)}`)).sha;
    // The release API may create the tag only when publishing; retain the exact target.
  } else {
    await github(context, `git/ref/tags/${segment(args.tag)}`);
  }
  const release = await github(context, 'releases', 'POST', {
    tag_name: args.tag,
    name: args.title || args.tag,
    body: args.body || '',
    draft: true,
    prerelease: args.prerelease === true,
    ...(target ? { target_commitish: target } : {}),
  });
  return { ok: true, release: normalizeRelease(release) };
}
export async function releaseEdit(args) {
  const context = await remoteContext(args.cwd);
  await load(context, args.id, true);
  const body = {};
  if (typeof args.title === 'string') body.name = args.title;
  if (typeof args.body === 'string') body.body = args.body;
  if (typeof args.prerelease === 'boolean') body.prerelease = args.prerelease;
  if (args.publish === true) body.draft = false;
  if (['true', 'false', 'legacy'].includes(args.latest)) body.make_latest = args.latest;
  return {
    ok: true,
    release: normalizeRelease(
      await github(context, `releases/${positiveId(args.id)}`, 'PATCH', body),
    ),
  };
}
export async function releaseDelete(args) {
  const context = await remoteContext(args.cwd);
  await load(context, args.id, true);
  await github(context, `releases/${positiveId(args.id)}`, 'DELETE');
  return { ok: true, note: 'Release deleted. Git tag retained.' };
}
export async function releaseNotes(args) {
  const context = await remoteContext(args.cwd);
  if (!args.tag) throw new Error('A tag is required');
  const result = await github(context, 'releases/generate-notes', 'POST', {
    tag_name: args.tag,
    ...(args.target ? { target_commitish: args.target } : {}),
    ...(args.previousTag ? { previous_tag_name: args.previousTag } : {}),
  });
  return { ok: true, title: result.name, body: result.body };
}
export async function releaseAssetDelete(args) {
  const context = await remoteContext(args.cwd);
  const release = await load(context, args.id, true);
  if (!release.assets.some((a) => a.id === positiveId(args.assetId)))
    throw new Error('Asset does not belong to this release');
  await github(context, `releases/assets/${positiveId(args.assetId)}`, 'DELETE');
  return { ok: true };
}
export async function releaseAssetUpload(args) {
  const context = await remoteContext(args.cwd);
  const release = await load(context, args.id, true);
  const file = await inside(context.cwd, args.path);
  if (!(await fs.stat(file)).isFile()) throw new Error('Select an asset file');
  const name = path.basename(file);
  if (name.includes('#')) throw new Error('Asset filenames cannot contain #');
  if (release.assets.some((a) => a.name === name) && !args.replace)
    throw new Error('Asset already exists. Choose Replace explicitly.');
  const argv = [
    'release',
    'upload',
    release.tag_name,
    file,
    '--repo',
    `${context.hostname}/${context.repo}`,
  ];
  if (args.replace) argv.push('--clobber');
  const result = await gh(argv, context.cwd, 30 * 60 * 1000);
  if (result.code !== 0) throw new Error(processError(result, 'Asset upload failed'));
  return { ok: true, name };
}
export async function releaseAssetDownload(args) {
  const context = await remoteContext(args.cwd);
  const release = await load(context, args.id);
  const asset = release.assets.find((a) => a.id === positiveId(args.assetId));
  if (!asset || path.basename(asset.name) !== asset.name || /[\\/]/.test(asset.name))
    throw new Error('Invalid release asset');
  const directory = await inside(context.cwd, args.directory || '.');
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('Select a destination directory');
  const target = await inside(
    context.cwd,
    path.relative(context.cwd, path.join(directory, asset.name)),
    false,
  );
  if (
    await fs.stat(target).then(
      () => true,
      () => false,
    )
  )
    throw new Error('Destination already exists');
  // gh streams directly to disk. An exact asset name must not become a glob pattern.
  if (/[\[\]*?]/.test(asset.name))
    throw new Error('This asset name cannot be downloaded through the CLI');
  const result = await gh(
    [
      'release',
      'download',
      release.tag_name,
      '--pattern',
      asset.name,
      '--dir',
      directory,
      '--repo',
      `${context.hostname}/${context.repo}`,
    ],
    context.cwd,
    30 * 60 * 1000,
  );
  if (result.code !== 0) throw new Error(processError(result, 'Asset download failed'));
  return { ok: true, path: target };
}
