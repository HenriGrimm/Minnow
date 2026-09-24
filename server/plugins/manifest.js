import fs from 'node:fs/promises';
import path from 'node:path';
import { compileParameters } from './schema.js';
import { parse } from 'acorn';
import { parseSkillFrontmatter } from '../skills/parse-frontmatter.js';
import { createHash } from 'node:crypto';

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const NAME = /^[a-z][a-z0-9_]{0,23}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|constructor|prototype)$/i;
export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;

export function pluginId(value) {
  if (typeof value !== 'string' || !ID.test(value) || RESERVED.test(value) || value === 'minnow') {
    throw new Error('Plugin id must be 1–32 lowercase letters, digits or hyphens, starting with a letter; reserved names are not allowed.');
  }
  return value;
}

export function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.includes('\0') || path.posix.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || RESERVED.test(p.split('.')[0]))) {
    throw new Error(`Invalid package-relative path: ${value}`);
  }
  return value;
}

function text(value, field, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} must be nonempty text (max ${max} characters)`);
  return value;
}

function entries(value, field, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${field} must be an array (max ${max})`);
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !NAME.test(item.id) || RESERVED.test(item.id) || seen.has(item.id)) throw new Error(`${field} requires unique snake_case ids (max 24 characters)`);
    seen.add(item.id);
  }
  return value;
}

export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plugin.json must be an object');
  if (raw.apiVersion !== 1) throw new Error('Unsupported plugin apiVersion; expected 1');
  const id = pluginId(raw.id);
  const name = text(raw.name, 'name', 100);
  const description = text(raw.description, 'description');
  if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(raw.version)) throw new Error('version must be semantic version text, e.g. 1.0.0');
  const tools = entries(raw.tools, 'tools', 32).map(t => {
    if (id.length + t.id.length + 10 > 64) throw new Error('Combined plugin and tool names must fit the 64-character tool name limit');
    text(t.description, 'tool description');
    if (!t.parameters || t.parameters.type !== 'object' || !t.parameters.properties || Array.isArray(t.parameters.properties)) throw new Error(`Tool ${t.id} needs an object parameters schema with properties`);
    compileParameters(t.parameters);
    if (t.timeoutMs !== undefined && (!Number.isInteger(t.timeoutMs) || t.timeoutMs < 100 || t.timeoutMs > 120000)) throw new Error('timeoutMs must be 100–120000');
    const handler = relativeFile(t.handler);
    if (!handler.endsWith('.mjs')) throw new Error('Tool handlers must use .mjs');
    return { id: t.id, description: t.description, parameters: t.parameters, handler, timeoutMs: t.timeoutMs ?? 30000 };
  });
  const panels = entries(raw.panels, 'panels', 12).map(p => ({ id: p.id, title: text(p.title, 'panel title', 100), entry: relativeFile(p.entry) }));
  const connections = entries(raw.connections, 'connections', 12).map(c => ({
    id: c.id, label: text(c.label, 'connection label', 100),
    fields: entries(c.fields, 'connection fields', 16).map(f => ({ id: f.id, label: text(f.label, 'field label', 100), secret: f.secret !== false, required: f.required === true })),
  }));
  const skills = entries(raw.skills, 'skills', 20).map(s => {
    if (s.id.includes('_')) throw new Error('Skill ids must use letters and digits');
    return { id: s.id, path: relativeFile(s.path) };
  });
  if (!tools.length && !panels.length && !skills.length) throw new Error('A plugin must contribute tools, panels or skills');
  return { apiVersion: 1, id, name, description, version: raw.version, tools, panels, connections, skills };
}

export async function readPackage(root) {
  const files = [];
  let bytes = 0;
  let entryCount = 0;
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (++entryCount > 512 || prefix.split('/').length > 16) throw new Error('Plugin directory tree is too large or deep');
      const name = prefix + entry.name;
      relativeFile(name);
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Links and special files are not allowed: ${name}`);
      if (stat.isDirectory()) await walk(full, `${name}/`);
      else {
        bytes += stat.size;
        if (bytes > MAX_PACKAGE_BYTES || files.length >= 256) throw new Error('Plugin exceeds 8 MiB or 256 files');
        const content = await fs.readFile(full);
        bytes += content.length - stat.size;
        if (bytes > MAX_PACKAGE_BYTES) throw new Error('Plugin exceeds 8 MiB');
        files.push({ name, bytes: content });
      }
    }
  }
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Plugin folder cannot be a symbolic link');
  await walk(root);
  const manifestFile = files.find(f => f.name === 'plugin.json');
  if (!manifestFile || manifestFile.bytes.length > 65536) throw new Error('plugin.json is missing or exceeds 64 KiB');
  const manifest = validateManifest(JSON.parse(manifestFile.bytes.toString('utf8')));
  for (const skill of manifest.skills) {
    const raw = files.find(f => f.name === skill.path)?.bytes.toString('utf8') ?? '';
    const { meta } = parseSkillFrontmatter(raw);
    if (meta.name !== `plugin-${manifest.id}-${skill.id}`) throw new Error(`Skill name must be plugin-${manifest.id}-${skill.id}`);
  }
  for (const name of [...manifest.tools.map(t => t.handler), ...manifest.panels.map(p => p.entry), ...manifest.skills.map(s => s.path)]) {
    if (!files.some(f => f.name === name)) throw new Error(`Missing declared file: ${name}`);
  }
  for (const file of files.filter(f => /\.(mjs|js)$/.test(f.name))) {
    const ast = parse(file.bytes.toString('utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    if (manifest.tools.some(t => t.handler === file.name) && !ast.body.some(n => n.type === 'ExportDefaultDeclaration')) throw new Error(`${file.name} must export a default handler`);
  }
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) hash.update(file.name).update('\0').update(String(file.bytes.length)).update('\0').update(file.bytes);
  return { manifest, files, digest: hash.digest('hex') };
}
