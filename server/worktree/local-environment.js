import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runWorktreeSetupProcess } from './setup-process.js';
import { getRequestAbortSignal } from '../runtime/request-work.js';

// Exact names, not .env.*: signing, staging and production files stay behind.
const ENV_NAMES = ['.env', '.env.local', '.env.development', '.env.development.local',
  '.env.dev', '.env.dev.local', '.env.test', '.env.test.local', '.env.testing', '.env.testing.local'];
const EXCLUDED_DIRS = ['node_modules', 'vendor', 'target', '.venv', 'venv', '.git', '.worktrees',
  '.minnow', 'dist', 'dist-headless', 'build', 'release', 'out', 'coverage', '.next', '.nuxt', '.output',
  '.svelte-kit', '.turbo', '.cache', '.yarn', '.pnpm-store', '.tox', '__pycache__', '.pytest_cache'];
const ENV_PATHS = [...ENV_NAMES.map(name => `:(glob)**/${name}`),
  ...EXCLUDED_DIRS.map(name => `:(glob,exclude)**/${name}/**`)];
const MAX_ENV_BYTES = 1024 * 1024;
const MAX_ENV_FILES = 512;
const parts = text => text.split('\0').filter(Boolean);
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => pathKey(a) === pathKey(b);
const problem = reason => Object.assign(new Error(reason), { environmentReason: reason });

// A crash can leave staging bytes behind. Keep them ignored as well as private,
// including repositories that ignore only the exact name `.env`.
async function ensurePrivateStagingIgnored(target, signal, directory) {
  const probe = [...directory, `.minnow-env-${randomUUID()}.tmp`].join('/');
  const ignored = async () => parts(await git(target, ['check-ignore', '--no-index', '--stdin', '-z'], signal, true, probe + '\0')).includes(probe);
  if (await ignored()) return;
  const exclude = (await git(target, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], signal)).trim();
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  // One append does not replace existing user/dependency exclusions. Repeated
  // concurrent setup may add a duplicate harmless rule, never truncate rules.
  const handle = await fs.open(exclude, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
    | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw problem('Cannot protect private environment staging files.');
    await handle.writeFile('\n# Minnow private environment staging\n.minnow-env-*.tmp\n');
    await handle.sync();
  } finally { await handle.close(); }
  if (!(await ignored())) throw problem('Cannot protect private environment staging files.');
}

async function git(cwd, args, signal, allowNoMatch = false, input) {
  const result = await runWorktreeSetupProcess('git', args, { cwd, signal, timeout: 30_000,
    ...(input === undefined ? {} : { onSpawn(child) {
      child.stdin.on('error', () => {}); // Git may exit before consuming all input.
      child.stdin.end(input);
    } }),
  });
  if (result.accumulationTruncated || result.timedOut || (result.code !== 0 && !(allowNoMatch && result.code === 1))) {
    // Never forward command output: Git errors can contain user-controlled config.
    throw problem('Cannot inspect local environment files with Git.');
  }
  return result.stdout;
}

function safeRelative(file) {
  const segments = file.split('/');
  if (path.isAbsolute(file) || file.includes('\\') || segments.some(part => !part || part === '.' || part === '..' || part.includes(':'))
    || (process.platform === 'win32' && segments.some(part => /[. ]$/.test(part)))
    || !ENV_NAMES.includes(segments.at(-1)) || segments.slice(0, -1).some(part => EXCLUDED_DIRS.includes(pathKey(part)))) {
    throw problem('Git returned an unsafe environment path.');
  }
  return segments;
}

async function lstat(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Do not follow directory junctions/symlinks, even when their targets exist.
async function parentDirectory(root, segments, create) {
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    if (create) {
      try { await fs.mkdir(directory); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = await lstat(directory);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw problem('Environment paths must use regular directories inside the checkout.');
  }
  return directory;
}

const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

async function copyEnvironment(source, target, segments, signal) {
  await parentDirectory(source, segments, false);
  const directory = await parentDirectory(target, segments, true);
  const from = path.join(source, ...segments), to = path.join(target, ...segments);
  if (await lstat(to)) return false; // Includes user-owned files, directories and dangling links.
  const before = await lstat(from);
  if (!before?.isFile() || before.isSymbolicLink()) throw problem('Environment sources must be regular files, not links.');
  if (before.size > MAX_ENV_BYTES) throw problem('Environment file exceeds the 1 MiB setup limit.');
  const input = await fs.open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let bytes;
  try {
    const opened = await input.stat();
    if (!opened.isFile() || !sameFile(before, opened)) throw problem('Environment source changed during setup; retry setup.');
    // Bounded reads also protect against a file growing while it is being copied.
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== before.size || !sameFile(before, await input.stat()) || !sameFile(before, await lstat(from))) {
      throw problem('Environment source changed during setup; retry setup.');
    }
    bytes = buffer.subarray(0, length);
  } finally { await input.close(); }

  const temporary = path.join(directory, `.minnow-env-${randomUUID()}.tmp`);
  let output, createdTemporary = false;
  try {
    signal?.throwIfAborted();
    output = await fs.open(temporary, 'wx', 0o600);
    createdTemporary = true;
    await output.writeFile(bytes);
    await output.sync();
    await output.close(); output = null;
    signal?.throwIfAborted();
    await parentDirectory(source, segments, false);
    await parentDirectory(target, segments, false);
    signal?.throwIfAborted();
    // Publish complete bytes atomically without overwriting a concurrent file.
    // This hard link is to our private COPY, never to the source environment.
    try { await fs.link(temporary, to); }
    catch (error) {
      if (error.code === 'EEXIST') return false;
      if (['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(error.code)) {
        throw problem('The worktree filesystem does not support atomic environment copying (hard links).');
      }
      throw error;
    }
    return true;
  } finally {
    try { await output?.close(); }
    finally {
      if (createdTemporary) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

/** Copy ignored local dev/test dotenv files, not secrets in arbitrary ignored files.
 * Results contain paths/status only. Failed preparation must block project execution.
 * @param {string} sourceRoot
 * @param {string} targetRoot
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function prepareWorktreeEnvironment(sourceRoot, targetRoot, { signal = getRequestAbortSignal() } = {}) {
  const copied = [], skipped = [], failed = [];
  let file;
  try {
    signal?.throwIfAborted();
    const source = await fs.realpath(sourceRoot), target = await fs.realpath(targetRoot);
    if (samePath(source, target)) throw problem('Cannot prepare a worktree environment in the source checkout itself.');
    // Git reports ignored nested repositories as `folder/` even with filename
    // pathspecs/exclusions. They are directory markers, not dotenv candidates.
    const files = parts(await git(source, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...ENV_PATHS], signal))
      .filter(name => !name.endsWith('/'));
    if (!files.length) return { ok: true, copied, skipped, failed };
    if (files.length > MAX_ENV_FILES) throw problem('Too many local environment files (setup limit: 512).');
    const common = async root => fs.realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).trim());
    if (!samePath(await common(source), await common(target))) throw problem('Environment inheritance requires checkouts of the same repository.');
    const tracked = new Set(parts(await git(target, ['ls-files', '--cached', '-z', '--', ...ENV_PATHS], signal)).map(pathKey));
    for (const name of files) safeRelative(name);
    // NUL-delimited stdin handles arbitrary names and Windows argv limits.
    const ignored = new Set(parts(await git(target, ['check-ignore', '--no-index', '--stdin', '-z'], signal, true, files.join('\0') + '\0')));
    const stagingDirectories = new Set();
    for (file of files) {
      signal?.throwIfAborted();
      const segments = safeRelative(file);
      if (tracked.has(pathKey(file))) { skipped.push(file); continue; }
      await parentDirectory(target, segments, true);
      if (await lstat(path.join(target, ...segments))) { skipped.push(file); continue; }
      if (!ignored.has(file)) throw problem('Destination does not ignore this environment file; it was not copied.');
      const parent = segments.slice(0, -1);
      if (!stagingDirectories.has(parent.join('/'))) {
        await ensurePrivateStagingIgnored(target, signal, parent);
        stagingDirectories.add(parent.join('/'));
      }
      if (await copyEnvironment(source, target, segments, signal)) copied.push(file);
      else skipped.push(file);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    failed.push({ file: file ?? null, reason: error.environmentReason ?? `Local environment setup failed (${error.code ?? 'io_error'}).` });
  }
  return { ok: failed.length === 0, copied, skipped, failed };
}

/** For setup paths whose existing failure channel is an exception. */
export async function requireWorktreeEnvironment(source, target, options) {
  const result = await prepareWorktreeEnvironment(source, target, options);
  if (!result.ok) throw new Error(`Worktree kept. ${result.failed.map(item => item.reason).join(' ')} Retry setup after repairing the local environment.`);
  return result;
}
