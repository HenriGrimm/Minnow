#!/usr/bin/env node
/**
 * Discover and run node:test files under test/.
 *
 * Usage:
 *   node test/run-all.mjs              # full suite
 *   node test/run-all.mjs --suite memory
 *   node test/run-all.mjs --shard 1/3
 *   node test/run-all.mjs --list       # print discovered files
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { resolveTestConcurrency } from './test-config.mjs';
import {
  groupByRunner,
  listTestsForSuite,
  resolveRunner,
  RUNNERS,
  suitePostCommands,
} from './test-discovery.mjs';

function parseArgs(argv) {
  let suite = null;
  let listOnly = false;
  let shard = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') {
      listOnly = true;
    } else if (arg === '--suite') {
      suite = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--suite=')) {
      suite = arg.slice('--suite='.length);
    } else if (arg === '--shard' || arg.startsWith('--shard=')) {
      const value = arg === '--shard' ? argv[++i] : arg.slice('--shard='.length);
      const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? '');
      const index = Number(match?.[1]);
      const count = Number(match?.[2]);
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count) {
        throw new Error('--shard must be an index/count pair, such as 1/3');
      }
      shard = { index, count };
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }

  if (suite && shard) throw new Error('--shard is only supported for the full suite');
  return { suite, listOnly, shard };
}

function printHelp() {
  console.log(`Usage: node test/run-all.mjs [--suite <name> | --shard <index>/<count>] [--list]

Runs all discoverable test/**/*.test.{js,mjs,mts,ts} files, grouped by runner profile.
Orphan detection: npm run test:check-coverage`);
}

/** Headroom under Windows CreateProcess's 32767-char command-line limit. */
const ARGV_CHAR_BUDGET = 24_000;
/** Secondary guard so a single batch does not grow without bound. */
const MAX_FILES_PER_BATCH = 300;

/** Estimate joined argv length (one space between args). */
function estimateArgvLength(args) {
  if (args.length === 0) return 0;
  return args.reduce((sum, arg) => sum + arg.length, 0) + args.length - 1;
}

/** Split files into batches that fit the argv budget and file-count cap. */
function chunkFiles(files, runnerId) {
  const profile = RUNNERS[runnerId];
  const fixedPrefix = [
    ...profile.prefixArgs,
    `--test-concurrency=${resolveTestConcurrency()}`,
  ];

  const chunks = [];
  let currentChunk = [];

  for (const file of files) {
    const nextChunk = [...currentChunk, file];
    const nextLen = estimateArgvLength([...fixedPrefix, ...nextChunk]);
    const overBudget = nextLen > ARGV_CHAR_BUDGET;
    const overCount = nextChunk.length > MAX_FILES_PER_BATCH;

    if (currentChunk.length > 0 && (overBudget || overCount)) {
      chunks.push(currentChunk);
      currentChunk = [file];
    } else {
      currentChunk = nextChunk;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function runBatch(runnerId, files) {
  const profile = RUNNERS[runnerId];
  if (!profile) {
    console.error(`Unknown runner profile: ${runnerId}`);
    return 1;
  }

  let exitCode = 0;
  const chunks = chunkFiles(files, runnerId);

  for (const [index, chunk] of chunks.entries()) {
    const label =
      chunks.length === 1
        ? `${runnerId} (${chunk.length} file${chunk.length === 1 ? '' : 's'})`
        : `${runnerId} batch ${index + 1}/${chunks.length} (${chunk.length} files)`;
    console.log(`\n▶ ${label}`);

    const args = [
      ...profile.prefixArgs,
      `--test-concurrency=${resolveTestConcurrency()}`,
      ...chunk,
    ];
    const result = spawnSync(profile.command, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    if (result.error) {
      console.error(result.error.message);
      exitCode = 1;
      continue;
    }
    if ((result.status ?? 1) !== 0) exitCode = result.status ?? 1;
  }

  return exitCode;
}

function runShellCommand(command) {
  console.log(`\n▶ post: ${command}`);
  const result = spawnSync(command, {
    stdio: 'inherit',
    shell: true,
    cwd: process.cwd(),
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  const { suite, listOnly, shard } = parseArgs(process.argv.slice(2));
  let files = listTestsForSuite(suite);
  if (shard && shard.count > 1) {
    // Deal each runner's sorted files across shards so every machine gets a
    // mix of fast tests and integrations. Continue the index between runners.
    let position = 0;
    files = [...groupByRunner(files).values()]
      .flatMap(group => group.filter(() => position++ % shard.count === shard.index - 1));
  }

  if (listOnly) {
    for (const file of files) {
      console.log(`${file}\t${resolveRunner(file)}`);
    }
    return;
  }

  if (files.length === 0) {
    const reason = shard ? 'No tests matched the requested shard'
      : suite ? `No tests matched suite "${suite}".` : 'No tests discovered.';
    throw new Error(reason);
  }

  const groups = groupByRunner(files);
  const runnerOrder = ['node-clean-exit', 'tsx-clean-exit', 'node', 'tsx-mocks', 'tsx-mocks-loader', 'node-tsx'];

  let exitCode = 0;
  for (const runnerId of runnerOrder) {
    const batch = groups.get(runnerId);
    if (!batch?.length) continue;
    const code = runBatch(runnerId, batch);
    if (code !== 0) exitCode = code;
  }

  for (const [runnerId, batch] of groups) {
    if (runnerOrder.includes(runnerId)) continue;
    const code = runBatch(runnerId, batch);
    if (code !== 0) exitCode = code;
  }

  for (const command of suitePostCommands(suite)) {
    const code = runShellCommand(command);
    if (code !== 0) exitCode = code;
  }

  process.exit(exitCode);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
