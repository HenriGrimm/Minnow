import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { actionRoot, inside, writeJson } from './action-common.js';
import { getMinnowHome } from '../config/home.js';
import { runProcess } from '../process-runner.js';
import { readEncryptedJsonFile, writeEncryptedJsonFile } from '../security/secret-box.js';

export function validateCommand(value) {
  if (!value || !/^[a-zA-Z0-9][\w.-]{0,79}$/.test(value.id || ''))
    throw new Error('Command ID must contain letters, numbers, dots, underscores or hyphens');
  if (
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    typeof value.command !== 'string' ||
    !value.command.trim()
  )
    throw new Error('Label and command are required');
  if (value.command.length > 16000) throw new Error('Command is too long');
  for (const field of ['env', 'secrets']) {
    if (value[field] && (typeof value[field] !== 'object' || Array.isArray(value[field])))
      throw new Error(`${field} must be an object`);
    for (const [key, item] of Object.entries(value[field] || {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string')
        throw new Error(`Invalid ${field} entry`);
    }
  }
  return {
    id: value.id,
    label: value.label.trim(),
    command: value.command,
    cwd: value.cwd || '.',
    shellProfile: value.shellProfile || '',
    env: value.env || {},
    secrets: value.secrets || {},
  };
}

export async function commandList(args = {}) {
  const root = await actionRoot(args.cwd);
  let config = { version: 1, commands: [] };
  try {
    config = JSON.parse(await fs.readFile(await inside(root, '.minnow/actions.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (config.version !== 1 || !Array.isArray(config.commands))
    throw new Error('Expected actions.json version 1 with a commands array');
  const commands = config.commands.map(validateCommand);
  if (new Set(commands.map((c) => c.id)).size !== commands.length)
    throw new Error('Duplicate command IDs');
  let pkg = {};
  try {
    pkg = JSON.parse(await fs.readFile(await inside(root, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let manager = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager || '')?.[1];
  if (!manager) {
    for (const [file, candidate] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun'],
    ]) {
      if (
        await fs.stat(path.join(root, file)).then(
          () => true,
          () => false,
        )
      ) {
        manager = candidate;
        break;
      }
    }
  }
  manager ||= 'npm';
  const scripts = Object.entries(pkg.scripts || {})
    .filter(([, script]) => typeof script === 'string')
    .map(([name, script]) => ({
      id: `script:${name}`,
      label: name,
      command: `${manager} run ${name}`,
      script,
      manager,
      scriptName: name,
      cwd: '.',
      env: {},
      secrets: {},
    }));
  return { ok: true, commands: [...scripts, ...commands], root };
}

const writes = new Map();
export async function commandSave(args) {
  const root = await actionRoot(args.cwd);
  const previous = writes.get(root) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const { commands } = await commandList({ cwd: root });
      const saved = commands.filter(
        (c) => !c.id.startsWith('script:') && c.id !== (args.command?.id || args.id),
      );
      if (!args.remove) {
        const command = validateCommand(args.command);
        await inside(root, command.cwd);
        saved.push(command);
      }
      const file = await inside(root, '.minnow/actions.json', false);
      await writeJson(file, { version: 1, commands: saved });
      return { ok: true };
    });
  writes.set(root, next);
  try {
    return await next;
  } finally {
    if (writes.get(root) === next) writes.delete(root);
  }
}

async function secretsPath(root) {
  const result = await runProcess(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root },
  );
  if (result.code !== 0) throw new Error('Cannot identify repository');
  const key = createHash('sha256')
    .update(await fs.realpath(result.stdout.trim()))
    .digest('hex');
  return path.join(getMinnowHome(), 'action-secrets', `${key}.json`);
}
export async function readActionSecrets(root) {
  return readEncryptedJsonFile(await secretsPath(root), {});
}
const secretWrites = new Map();
export async function actionSecrets(args) {
  const root = await actionRoot(args.cwd);
  const file = await secretsPath(root);
  const previous = secretWrites.get(file) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const values = await readEncryptedJsonFile(file, {});
      if ((args.remove || args.value !== undefined) && !args.name)
        throw new Error('Secret name is required');
      if (args.name) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.name)) throw new Error('Invalid secret name');
        if (args.remove) delete values[args.name];
        else {
          if (typeof args.value !== 'string') throw new Error('Secret value is required');
          Object.defineProperty(values, args.name, {
            value: args.value,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
        await writeEncryptedJsonFile(file, values);
      }
      return { ok: true, names: Object.keys(values) };
    });
  secretWrites.set(file, next);
  try {
    return await next;
  } finally {
    if (secretWrites.get(file) === next) secretWrites.delete(file);
  }
}
