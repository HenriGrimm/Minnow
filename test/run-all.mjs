#!/usr/bin/env node
/**
 * Discover and run node:test files under test/.
 *
 * Usage:
 *   node test/run-all.mjs              # full suite
 *   node test/run-all.mjs --suite memory
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

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') {
      listOnly = true;
    } else if (arg === '--suite') {
      suite = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--suite=')) {
      suite = arg.slice('--suite='.length);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }

  return { suite, listOnly };
}

function printHelp() {
  console.log(`Usage: node test/run-all.mjs [--suite <name>] [--list]

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
  const { suite, listOnly } = parseArgs(process.argv.slice(2));
  const files = listTestsForSuite(suite);

  if (listOnly) {
    for (const file of files) {
      console.log(`${file}\t${resolveRunner(file)}`);
    }
    return;
  }

  if (files.length === 0) {
    console.error(suite ? `No tests matched suite "${suite}".` : 'No tests discovered.');
    process.exit(1);
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

main();
