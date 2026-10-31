#!/usr/bin/env node

/**
 * Bundle the headless `minnow run` entry into one plain-JS file.
 *
 * In a checkout `bin/minnow.mjs` runs `src/headless/cli-main.ts` through tsx.
 * An installed build ships neither tsx nor the TypeScript sources, so the
 * Scheduler spawns this bundle instead — see `server/scheduler/headless-entry.js`.
 * The second export-only bundle shares Code's prompt composition with the server.
 */

import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADLESS_RUNNER_BUNDLE, CHAT_PREPARATION_BUNDLE } from '../server/constants/headless-runner.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Bundled CommonJS dependencies call `require()` for Node builtins, which an
 * ESM output file does not define.
 */
const REQUIRE_SHIM = [
  "import { createRequire as __minnowCreateRequire } from 'node:module';",
  'const require = __minnowCreateRequire(import.meta.url);',
].join('\n');

/**
 * @param {{ outfile?: string, logLevel?: 'silent' | 'error' | 'warning' | 'info' }} [options]
 * @returns {Promise<{ outfile: string, bytes: number, externals: string[] }>}
 */
async function buildEntry(entry, defaultOutfile, options = {}) {
  const { build } = await import('esbuild');
  const outfile = path.resolve(repoRoot, options.outfile ?? defaultOutfile);
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    metafile: true,
    // Identifiers stay readable: a run's stderr lands in Scheduler run history.
    minifyWhitespace: true,
    minifySyntax: true,
    logLevel: options.logLevel ?? 'warning',
    // Same stubs test/test-loader.mjs gives the tsx path: styles mean nothing here.
    loader: { '.css': 'empty' },
    banner: { js: REQUIRE_SHIM },
  });

  const output = Object.values(result.metafile.outputs)[0];
  const externals = [
    ...new Set((output?.imports ?? []).filter((entry) => entry.external).map((entry) => entry.path)),
  ];
  // The bundle runs with no node_modules beside it, so anything left external
  // other than a Node builtin would only fail once a job is due.
  const unresolved = externals.filter((name) => !isBuiltin(name));
  if (unresolved.length) {
    fs.rmSync(outfile, { force: true });
    throw new Error(`Headless runner bundle has unbundled imports: ${unresolved.join(', ')}`);
  }
  return { outfile, bytes: output?.bytes ?? fs.statSync(outfile).size, externals };
}

export function buildHeadlessRunner(options = {}) {
  return buildEntry('src/headless/cli-main.ts', HEADLESS_RUNNER_BUNDLE, options);
}

export function buildChatPreparation(options = {}) {
  return buildEntry('src/headless/chat-preparation.ts', CHAT_PREPARATION_BUNDLE, options);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    for (const build of [buildHeadlessRunner, buildChatPreparation]) {
      const { outfile, bytes } = await build();
      console.log(`[build-headless-runner] ${path.relative(repoRoot, outfile).replace(/\\/g, '/')} (${Math.round(bytes / 1024)} KB)`);
    }
  } catch (err) {
    console.error('[build-headless-runner]', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
