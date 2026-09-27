import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveLadderRungs } from '../orchestrator/final-test.js';

export const SHIP_GATE_CONFIG_FILE = 'minnow.ship.json';
export const SHIP_GATE_EVIDENCE_FILE = path.join('.minnow', 'ship-gate-evidence.json');
export const SHIP_GATE_CHECK_IDS = /** @type {const} */ ([
  'typecheck',
  'tests',
  'build',
  'performance',
  'secrets',
  'dependencies',
]);

const CHECK_LABELS = {
  typecheck: 'Typecheck',
  tests: 'Tests',
  build: 'Build',
  performance: 'Performance budgets',
  secrets: 'Secret scan',
  dependencies: 'Dependency audit',
};

function scriptCommand(scripts, names) {
  const name = names.find((candidate) => typeof scripts[candidate] === 'string' && scripts[candidate].trim());
  return name ? `npm run ${name}` : '';
}

function cleanCommand(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : fallback;
}

function cleanCheck(raw, fallback) {
  const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const command = cleanCommand(candidate.command, fallback.command);
  return {
    id: fallback.id,
    label: fallback.label,
    enabled: candidate.enabled == null ? fallback.enabled : candidate.enabled === true,
    command,
  };
}

/** Build safe defaults from the project's existing scripts and final-test ladder. */
export function defaultShipGateConfig(packageJson = {}) {
  const scripts = packageJson && typeof packageJson === 'object' && packageJson.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts
    : {};
  const ladder = resolveLadderRungs({ packageJson });
  const byId = Object.fromEntries(ladder.map((rung) => [rung.id, rung.command]));
  const performance = scriptCommand(scripts, ['check:performance-budgets', 'performance', 'perf']);
  const secrets = scriptCommand(scripts, ['check:secrets', 'security:secrets', 'secret-scan', 'secrets']);
  const dependencies = scriptCommand(scripts, ['check:dependencies', 'security:dependencies', 'audit']);

  return {
    version: 1,
    enabled: true,
    policy: 'warn',
    checks: [
      { id: 'typecheck', label: CHECK_LABELS.typecheck, enabled: true, command: byId.typecheck || 'npx tsc --noEmit' },
      { id: 'tests', label: CHECK_LABELS.tests, enabled: true, command: byId.unit || 'npm test' },
      { id: 'build', label: CHECK_LABELS.build, enabled: true, command: byId.build || 'npm run build' },
      { id: 'performance', label: CHECK_LABELS.performance, enabled: Boolean(performance), command: performance },
      { id: 'secrets', label: CHECK_LABELS.secrets, enabled: Boolean(secrets), command: secrets },
      { id: 'dependencies', label: CHECK_LABELS.dependencies, enabled: Boolean(dependencies), command: dependencies || 'npm audit --audit-level=high' },
    ],
  };
}

/** Merge a checked-in project override over detected defaults. Unknown fields are discarded. */
export function normalizeShipGateConfig(raw, packageJson = {}) {
  const defaults = defaultShipGateConfig(packageJson);
  const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawChecks = Array.isArray(candidate.checks) ? candidate.checks : [];
  const byId = new Map(rawChecks
    .filter((check) => check && typeof check === 'object' && SHIP_GATE_CHECK_IDS.includes(check.id))
    .map((check) => [check.id, check]));
  return {
    version: 1,
    enabled: candidate.enabled == null ? defaults.enabled : candidate.enabled === true,
    policy: candidate.policy === 'block' ? 'block' : 'warn',
    checks: defaults.checks.map((fallback) => cleanCheck(byId.get(fallback.id), fallback)),
  };
}

export function shipGateConfigSignature(config) {
  return JSON.stringify({
    enabled: config.enabled,
    policy: config.policy,
    checks: config.checks.map(({ id, enabled, command }) => ({ id, enabled, command })),
  });
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function assertSafeProjectTarget(root, file, { createParent = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const parent = path.dirname(file);
  if (createParent) await fs.mkdir(parent, { recursive: true });
  const [realRoot, realParent] = await Promise.all([fs.realpath(resolvedRoot), fs.realpath(parent)]);
  const relative = path.relative(realRoot, realParent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Ship gate path resolves outside the workspace');
  }
  if (parent !== resolvedRoot) {
    const parentStat = await fs.lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error('Ship gate storage directory must be a local workspace directory');
    }
  }
  try {
    const targetStat = await fs.lstat(file);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error('Ship gate file must be a regular workspace file');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function readSafeProjectJson(root, file) {
  try {
    await assertSafeProjectTarget(root, file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return readJson(file);
}

async function atomicWriteProjectJson(root, file, value, options = {}) {
  await assertSafeProjectTarget(root, file, options);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rm(file, { force: true });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function loadShipGateState(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const packageJson = await readJson(path.join(root, 'package.json')) ?? {};
  const configFile = path.join(root, SHIP_GATE_CONFIG_FILE);
  const evidenceFile = path.join(root, SHIP_GATE_EVIDENCE_FILE);
  const rawConfig = await readSafeProjectJson(root, configFile);
  const config = normalizeShipGateConfig(rawConfig, packageJson);
  const evidence = await readSafeProjectJson(root, evidenceFile);
  return {
    config,
    configSignature: shipGateConfigSignature(config),
    configPath: configFile,
    evidence: evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : null,
  };
}

export async function saveShipGateConfig(workspaceRoot, raw) {
  const root = path.resolve(workspaceRoot);
  const packageJson = await readJson(path.join(root, 'package.json')) ?? {};
  const config = normalizeShipGateConfig(raw, packageJson);
  await atomicWriteProjectJson(root, path.join(root, SHIP_GATE_CONFIG_FILE), config);
  return config;
}

export async function saveShipGateEvidence(workspaceRoot, raw) {
  const root = path.resolve(workspaceRoot);
  const evidence = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const checks = Array.isArray(evidence.checks) ? evidence.checks.slice(0, SHIP_GATE_CHECK_IDS.length) : [];
  const normalized = {
    version: 1,
    outcome: evidence.outcome === 'pass' ? 'pass' : evidence.outcome === 'cancelled' ? 'cancelled' : 'fail',
    startedAt: typeof evidence.startedAt === 'string' ? evidence.startedAt : new Date().toISOString(),
    completedAt: typeof evidence.completedAt === 'string' ? evidence.completedAt : new Date().toISOString(),
    headSha: typeof evidence.headSha === 'string' ? evidence.headSha.slice(0, 80) : null,
    gitFingerprint: typeof evidence.gitFingerprint === 'string' ? evidence.gitFingerprint.slice(0, 20_000) : '',
    configSignature: typeof evidence.configSignature === 'string' ? evidence.configSignature.slice(0, 20_000) : '',
    checks: checks.map((check) => ({
      id: SHIP_GATE_CHECK_IDS.includes(check?.id) ? check.id : 'tests',
      command: cleanCommand(check?.command),
      outcome: check?.outcome === 'pass' ? 'pass' : check?.outcome === 'cancelled' ? 'cancelled' : 'fail',
      exitCode: Number.isInteger(check?.exitCode) ? check.exitCode : null,
      durationMs: Number.isFinite(check?.durationMs) ? Math.max(0, Math.round(check.durationMs)) : 0,
      runId: typeof check?.runId === 'string' ? check.runId.slice(0, 160) : '',
      outputTail: typeof check?.outputTail === 'string' ? check.outputTail.slice(-12_000) : '',
    })),
  };
  const file = path.join(root, SHIP_GATE_EVIDENCE_FILE);
  await atomicWriteProjectJson(root, file, normalized, { createParent: true });
  return normalized;
}
