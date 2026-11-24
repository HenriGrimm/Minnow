import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyLadderCommand, loadPlanMarkdown } from './final-test.js';

function targetFor(label, repos) {
  const name = label.toLowerCase();
  const exact = repos.find(repo => repo.id.toLowerCase() === name);
  if (exact) return exact;
  const suffix = repos.filter(repo => path.posix.basename(repo.id).toLowerCase().split(/[-_]/).at(-1) === name);
  return suffix.length === 1 ? suffix[0] : null;
}

/** Resolve commands in the directory whose package or checklist owns them. */
export async function boardVerificationTargets(layout, cwd, planPath) {
  const relative = planPath && path.relative(layout.workspace, path.resolve(layout.workspace, planPath));
  const markdown = await loadPlanMarkdown(cwd, relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null);
  const checklist = /^## Verification Checklist[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(markdown)?.[1] ?? '';
  const targets = [];
  for (const repo of layout.repos) {
    const root = path.join(cwd, repo.id);
    let scripts = {};
    try { scripts = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).scripts ?? {}; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const has = name => fs.access(path.join(root, name)).then(() => true, () => false);
    const pkg = await has('pnpm-lock.yaml') ? 'pnpm' : await has('yarn.lock') ? 'yarn' : 'npm';
    const defaults = ['typecheck', 'lint', 'test', 'build'].filter(name => scripts[name]).map(name => `${pkg} run ${name}`);
    if (await has('pyproject.toml') && await has('tests')) defaults.push(await has('uv.lock') ? 'uv run pytest' : 'python -m pytest');
    targets.push({ id: repo.id, cwd: root, defaults, scripts, browser: Boolean(scripts.dev || scripts.start), commands: [] });
  }
  const workspace = targets.find(target => target.id === '.') ?? { id: '.', cwd, commands: [], defaults: [], browser: false };
  for (const line of checklist.split(/\r?\n/)) {
    if (!/^\s*-\s*\[[ xX]\]/.test(line)) continue;
    const label = /^\s*-\s*\[[ xX]\]\s*([\w./ -]+):/.exec(line)?.[1]?.trim();
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const command = match[1].trim();
      // Backticked route names, assertion outcomes and data literals are prose.
      const tool = /^(?:cd|npm|npx|pnpm|yarn|bun|node|uv|python3?|pytest|ruff|mypy|cargo|go|make|dotnet|gradle|mvn|sh|bash|pwsh|\.\/\S+)\b/i.exec(command)?.[0];
      if (!tool) continue;
      let target = label && targetFor(label, targets);
      if (!target && /^(npm|npx|pnpm|yarn|bun|node)$/.test(tool)) {
        const packages = targets.filter(candidate => Object.keys(candidate.scripts).length);
        if (packages.length === 1) target = packages[0];
      }
      (target ?? workspace).commands.push(command);
    }
  }
  if (!targets.includes(workspace) && workspace.commands.length) targets.push(workspace);
  return targets.map(target => ({
    id: target.id, cwd: target.cwd, browser: target.browser, planMarkdown: markdown,
    rungs: [...new Set(target.commands.length ? target.commands : target.defaults)]
      .map(command => ({ command, id: classifyLadderCommand(command) ?? 'unit' })),
  }));
}

export async function runBoardVerification(targets, runLadder, options) {
  const results = [];
  let blocked = null;
  for (const target of targets) {
    const result = await runLadder({
      ...options, cwd: target.cwd, planMarkdown: target.planMarkdown, rungs: target.rungs,
      browser: options.browser && target.browser,
    });
    results.push({ id: target.id, ...result });
    if (result.outcome !== 'pass') {
      return { ...result, summary: `${target.id}: ${result.summary}`, evidence: { ...result.evidence, repos: results } };
    }
    if (result.evidence?.blockedRung === 'browser' && (!blocked || result.evidence?.browser?.reason !== 'no-observable-criteria')) blocked = result;
  }
  if (blocked) return { ...blocked, evidence: { ...blocked.evidence, repos: results } };
  return {
    outcome: 'pass', summary: `Final checks passed in ${results.map(row => row.id).join(', ')}.`,
    runInstructions: results.map(row => row.runInstructions).filter(Boolean).join('\n\n'),
    evidence: { repos: results },
  };
}
