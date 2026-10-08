import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { actionRoot, inside, remoteContext, github, segment, pageNumber } from './action-common.js';

export function parseWorkflow(source, file) {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`${file}: ${doc.errors[0].message}`);
  const data = doc.toJS({ maxAliasCount: 50 });
  if (!data || typeof data !== 'object') throw new Error('Workflow must be a YAML object');
  const on = data.on;
  const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on || {});
  const inputs = Object.entries(on?.workflow_dispatch?.inputs || {}).map(([name, value]) => ({
    name,
    description: String(value?.description || name),
    type: value?.type || 'string',
    required: value?.required === true,
    default: value?.default,
    options: value?.options || [],
  }));
  const jobs = Object.entries(data.jobs || {}).map(([id, job]) => {
    const runner = job['runs-on'];
    // Dynamic runners cannot be safely assumed to mean Linux.
    const supported = typeof runner === 'string' && /^ubuntu-(latest|\d+\.\d+)$/.test(runner);
    return {
      id,
      label: String(job.name || id),
      runner,
      supported,
      needs: [].concat(job.needs || []),
    };
  });
  return {
    id: file,
    path: file,
    name: String(data.name || path.basename(file)),
    events,
    inputs,
    jobs,
    dispatchable: events.includes('workflow_dispatch'),
  };
}

export function validateInputs(definitions, supplied = {}) {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
    throw new Error('Inputs must be an object');
  const result = {};
  for (const key of Object.keys(supplied))
    if (!definitions.some((d) => d.name === key)) throw new Error(`Unknown input: ${key}`);
  for (const def of definitions) {
    let value = supplied[def.name] ?? def.default;
    if (value === undefined || value === '') {
      if (def.required) throw new Error(`${def.name} is required`);
      continue;
    }
    if (def.type === 'boolean') {
      if (![true, false, 'true', 'false'].includes(value))
        throw new Error(`${def.name} must be boolean`);
      value = value === true || value === 'true';
    } else if (def.type === 'number') {
      if (!Number.isFinite(Number(value))) throw new Error(`${def.name} must be a number`);
      value = Number(value);
    } else {
      if (typeof value !== 'string') throw new Error(`${def.name} must be text`);
      if (def.type === 'choice' && !def.options.includes(value))
        throw new Error(`Invalid choice for ${def.name}`);
    }
    Object.defineProperty(result, def.name, { value, enumerable: true });
  }
  return result;
}

export async function workflowList(args = {}) {
  if (args.location === 'local') {
    const root = await actionRoot(args.cwd);
    let files;
    try {
      files = await fs.readdir(await inside(root, '.github/workflows'));
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: true, workflows: [] };
      throw error;
    }
    const workflows = [];
    for (const name of files.filter((n) => /\.ya?ml$/i.test(n))) {
      const file = `.github/workflows/${name}`;
      try {
        workflows.push(parseWorkflow(await fs.readFile(await inside(root, file), 'utf8'), file));
      } catch (error) {
        workflows.push({
          id: file,
          path: file,
          name,
          error: error.message,
          dispatchable: false,
          jobs: [],
          inputs: [],
          events: [],
        });
      }
    }
    return { ok: true, workflows };
  }
  const context = await remoteContext(args.cwd);
  const page = pageNumber(args.page);
  const data = await github(context, `actions/workflows?per_page=50&page=${page}`);
  return { ok: true, workflows: data.workflows, hasMore: page * 50 < data.total_count };
}

export async function workflowView(args) {
  if (args.location === 'local') {
    const root = await actionRoot(args.cwd);
    if (!/^\.github\/workflows\/[^/\\]+\.ya?ml$/.test(args.path || ''))
      throw new Error('Invalid workflow path');
    return {
      ok: true,
      workflow: parseWorkflow(await fs.readFile(await inside(root, args.path), 'utf8'), args.path),
    };
  }
  if (!args.ref) throw new Error('Select a remote branch or tag');
  const context = await remoteContext(args.cwd);
  const workflow = await github(context, `actions/workflows/${segment(args.id)}`);
  const data = await github(
    context,
    `contents/${workflow.path.split('/').map(segment).join('/')}?ref=${segment(args.ref)}`,
  );
  return {
    ok: true,
    workflow: {
      ...parseWorkflow(Buffer.from(data.content, 'base64').toString('utf8'), workflow.path),
      id: workflow.id,
      state: workflow.state,
    },
  };
}

export async function workflowDispatch(args) {
  const context = await remoteContext(args.cwd);
  const { workflow } = await workflowView(args);
  if (!workflow.dispatchable || (workflow.state && workflow.state !== 'active'))
    throw new Error('This workflow is not available for manual dispatch');
  const inputs = validateInputs(workflow.inputs, args.inputs);
  try {
    await github(context, `actions/workflows/${segment(workflow.id)}/dispatches`, 'POST', {
      ref: args.ref,
      inputs,
    });
  } catch (error) {
    if (/timed? ?out|timeout|network|connection|fetch failed/i.test(error.message))
      return {
        ok: false,
        error: 'Dispatch status is unknown. Check GitHub run history before trying again.',
      };
    throw error;
  }
  return {
    ok: true,
    accepted: true,
    note: 'Dispatch accepted. GitHub run history will update when the run is created.',
  };
}

export async function actionRemoteOptions(args = {}) {
  const context = await remoteContext(args.cwd);
  const page = pageNumber(args.page);
  const kind = ['branches', 'tags', 'environments'].includes(args.kind) ? args.kind : 'branches';
  const data = await github(context, `${kind}?per_page=100&page=${page}`);
  const rows = Array.isArray(data) ? data : data.environments || [];
  return {
    ok: true,
    options: rows.map((row) => ({ name: row.name, sha: row.commit?.sha })),
    hasMore: rows.length === 100,
    repo: `${context.hostname}/${context.repo}`,
  };
}
