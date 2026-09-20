#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const planArg = process.argv[2];
if (!planArg || process.argv.length !== 3) {
  console.error('Usage: node .claude/skills/minnow-plan/scripts/validate-plan.mjs documentation/plans/<slug>.md');
  process.exit(1);
}

let repoRoot = path.dirname(fileURLToPath(import.meta.url));
while (!existsSync(path.join(repoRoot, 'server/orchestrator/core/parse-plan.js'))) {
  const parent = path.dirname(repoRoot);
  if (parent === repoRoot) {
    console.error('Not inside a Minnow repo — cannot validate.');
    process.exit(2);
  }
  repoRoot = parent;
}

const moduleUrl = (relative) => pathToFileURL(path.join(repoRoot, relative)).href;
const { parsePlan, isParseErrors, formatParseErrors } = await import(moduleUrl('server/orchestrator/core/parse-plan.js'));
const { structuralErrors } = await import(moduleUrl('server/super-plan/artifacts.js'));
const { findImplementationCode } = await import(moduleUrl('server/super-plan/no-code-guard.js'));

const planPath = path.resolve(planArg);
let markdown;
try {
  markdown = readFileSync(planPath, 'utf8');
} catch (error) {
  console.error(`Cannot read ${planArg}: ${error.message}`);
  process.exit(1);
}

const relative = path.relative(repoRoot, planPath).replaceAll('\\', '/');
const errors = new Set(structuralErrors(markdown, relative, 'plan'));
const codeError = findImplementationCode(markdown);
if (codeError) errors.add(codeError);

const graph = parsePlan(markdown);
if (isParseErrors(graph)) errors.add(formatParseErrors(graph));

if (errors.size) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(`${graph.name}: ${graph.waves.length} waves, ${graph.tasks.length} tasks`);
for (const task of graph.tasks) {
  console.log(`${task.id} · wave ${task.wave} · dependsOn ${task.dependsOn.join(', ') || '(none)'} · touches ${task.touches.join(', ')}`);
}
