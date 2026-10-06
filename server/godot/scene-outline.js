/** Bounded, read-only outline of a saved Godot 4 text scene. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';

const MAX_SCENE_BYTES = 2 * 1024 * 1024;
const MAX_SECTIONS = 4000;

function attributes(header) {
  const result = {};
  const pattern = /([a-z_]+)=("(?:\\.|[^"\\])*"|[^\s]+)/g;
  for (const match of header.matchAll(pattern)) {
    let value = match[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    }
    result[match[1]] = value;
  }
  return result;
}

/** The outline is intentionally not a validator or full resource deserializer. */
export function parseSceneOutline(text) {
  const lines = text.split(/\r?\n/);
  const nodes = [];
  const resources = [];
  const connections = [];
  const warnings = [];
  let descriptor = null;
  let currentNode = null;
  let sections = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      currentNode = null;
      const match = /^\[([a-z_]+)(?:\s+(.*))?\](?:\s*;.*)?$/.exec(line);
      if (!match) {
        warnings.push({ line: index + 1, message: 'Unrecognized section header' });
        continue;
      }
      if (++sections > MAX_SECTIONS) {
        warnings.push({ line: index + 1, message: 'Scene outline section limit reached' });
        break;
      }
      const kind = match[1];
      const fields = attributes(match[2] ?? '');
      if (kind === 'gd_scene') {
        descriptor = { format: Number(fields.format), uid: fields.uid ?? null };
      } else if (kind === 'ext_resource' || kind === 'sub_resource') {
        resources.push({ kind, id: fields.id ?? null, type: fields.type ?? null,
          path: fields.path ?? null, uid: fields.uid ?? null, line: index + 1 });
      } else if (kind === 'node') {
        const parent = fields.parent ?? null;
        const name = fields.name ?? null;
        currentNode = { name, type: fields.type ?? null,
          parent, nodePath: name === null ? null : parent === null ? '.' : parent === '.' ? name : `${parent}/${name}`,
          instance: fields.instance ?? null,
          script: null, line: index + 1 };
        nodes.push(currentNode);
        if (name === null) warnings.push({ line: index + 1, message: 'Node has no name' });
      } else if (kind === 'connection') {
        connections.push({ from: fields.from ?? null, to: fields.to ?? null,
          signal: fields.signal ?? null, method: fields.method ?? null, line: index + 1 });
      }
      continue;
    }
    if (currentNode) {
      const script = /^script\s*=\s*ExtResource\("([^"\r\n]+)"\)/.exec(line);
      if (script) currentNode.script = script[1];
    }
  }

  if (!descriptor) warnings.push({ line: 1, message: 'Missing gd_scene descriptor' });
  else if (descriptor.format !== 3) warnings.push({ line: 1, message: 'Only Godot 4 text scenes are supported' });
  if (nodes.length === 0) warnings.push({ line: 1, message: 'No scene nodes found' });
  if (nodes.length > 0 && nodes[0].parent !== null) {
    warnings.push({ line: nodes[0].line, message: 'First node has a parent; root may be missing' });
  }
  const externalById = new Map(resources.filter((resource) => resource.kind === 'ext_resource')
    .map((resource) => [resource.id, resource]));
  for (const node of nodes) {
    if (node.script) {
      const resource = externalById.get(node.script);
      node.script = resource?.path ?? null;
      if (!resource) warnings.push({ line: node.line, message: 'Script resource was not found' });
    }
  }
  return { descriptor, nodes, resources, connections, warnings,
    complete: warnings.length === 0 };
}

/** @param {string} projectRoot @param {string} relativePath */
export async function readSceneOutline(projectRoot, relativePath) {
  const normalized = String(relativePath ?? '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') ||
      normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
      path.isAbsolute(normalized) || !normalized.toLowerCase().endsWith('.tscn')) {
    throw Object.assign(new Error('Select a project-relative .tscn file'), { statusCode: 400 });
  }
  const absolute = path.resolve(projectRoot, normalized);
  if (!isResolvedPathUnderRoot(absolute, projectRoot)) {
    throw Object.assign(new Error('Scene path is outside the Godot project'), { statusCode: 400 });
  }
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw Object.assign(new Error('Scene is not a file'), { statusCode: 400 });
  if (stat.size > MAX_SCENE_BYTES) {
    throw Object.assign(new Error('Scene is too large for an outline'), { statusCode: 413 });
  }
  const buffer = await fs.readFile(absolute);
  if (buffer.length > MAX_SCENE_BYTES) {
    throw Object.assign(new Error('Scene is too large for an outline'), { statusCode: 413 });
  }
  return { path: normalized, ...parseSceneOutline(buffer.toString('utf8')) };
}
