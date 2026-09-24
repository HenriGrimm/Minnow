import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readResource, updateIssuesResource } from '../config/store.js';
import { validateIssuesState, normalizeWorkspacePath } from '../config/validators.js';

const text = { type: 'string', minLength: 1 };
const fields = {
  title: text, description: { type: 'string' }, type: text, status: text, priority: text,
  labels: { type: 'array', items: text }, project_id: { type: ['string', 'null'] },
};
function tool(name, description, properties = {}, required = [], readOnly = true) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: name === 'issue_edit', openWorldHint: false } };
}
export const issueHubTools = [
  tool('issue_list', 'List/search issues in the connected workspace. Includes closed issues when requested; returns compact rows and pagination.', {
    query: { type: 'string' }, status: text, project_id: text, include_closed: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 },
  }),
  tool('issue_get', 'Read one workspace issue, including description, comments and links.', { issue_id: text }, ['issue_id']),
  tool('issue_create', 'Create an issue in the connected workspace. Read issue_taxonomy for valid type/status/priority ids.', fields, ['title'], false),
  tool('issue_edit', 'Edit a workspace issue. Optional expected_updated_at rejects stale edits. project_id:null clears its project.', {
    issue_id: text, ...fields, expected_updated_at: { type: 'number' },
  }, ['issue_id'], false),
  tool('issue_comment', 'Append an external agent comment to a workspace issue.', { issue_id: text, body: text, author: text }, ['issue_id', 'body'], false),
  tool('issue_projects', 'List Minnow’s shared issue project catalog.'),
  tool('issue_taxonomy', 'Read configured issue types, statuses and priorities.'),
];

function normalize(value) {
  const result = String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(result) ? result.toLowerCase() : result;
}

export async function callIssueHubTool(name, args, workspace) {
  const taxonomy = await readResource('issues-taxonomy');
  const belongs = row => normalize(row.workspacePath) === normalize(workspace);
  const find = state => {
    const issue = state.issues.find(row => row.id === args.issue_id && belongs(row));
    if (!issue) throw new Error('Issue not found in the connected workspace.');
    return issue;
  };
  if (name === 'issue_taxonomy') return taxonomy;
  if (['issue_list', 'issue_get', 'issue_projects'].includes(name)) {
    const state = validateIssuesState(await readResource('issues'));
    if (name === 'issue_get') return find(state);
    if (name === 'issue_projects') return state.projects ?? [];
    const closed = new Set(taxonomy.statuses.filter(row => row.isClosed).map(row => row.id));
    const query = (args.query ?? '').toLowerCase();
    const rows = state.issues.filter(row => belongs(row)
      && (!args.status || row.status === args.status)
      && (!args.project_id || row.projectId === args.project_id)
      && (args.include_closed || args.status || !closed.has(row.status))
      && (!query || `${row.id} ${row.title} ${row.description}`.toLowerCase().includes(query)))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const offset = args.offset ?? 0, limit = args.limit ?? 30;
    return { total: rows.length, offset, limit, issues: rows.slice(offset, offset + limit).map(
      ({ id, title, status, type, priority, labels, projectId, updatedAt }) => ({ id, title, status, type, priority, labels, projectId, updatedAt }),
    ) };
  }
  let result;
  await updateIssuesResource(state => {
    const now = Date.now();
    if (name === 'issue_comment') {
      const issue = find(state);
      if (!args.body.trim()) throw new Error('Comment body must not be blank.');
      const comment = { id: randomUUID(), authorKind: 'agent', body: args.body.trim(), author: args.author ?? 'External agent', createdAt: now };
      issue.comments = [...(issue.comments ?? []), comment];
      issue.updatedAt = Math.max(now, issue.updatedAt + 1);
      result = comment;
      return state;
    }
    const patch = {};
    for (const [field, group] of [['type', 'types'], ['status', 'statuses'], ['priority', 'priorities']]) {
      if (args[field] !== undefined) {
        if (!taxonomy[group].some(row => row.id === args[field])) throw new Error(`Invalid ${field}; use issue_taxonomy to discover valid ids.`);
        patch[field] = args[field];
      }
    }
    if (args.title !== undefined) {
      if (!args.title.trim()) throw new Error('Title must not be blank.');
      patch.title = args.title.trim();
    }
    if (args.description !== undefined) patch.description = args.description;
    if (args.labels !== undefined) patch.labels = [...new Set(args.labels.map(label => label.trim()).filter(Boolean))];
    if (args.project_id !== undefined) {
      if (args.project_id !== null && !(state.projects ?? []).some(row => row.id === args.project_id)) throw new Error('Project not found.');
      patch.projectId = args.project_id ?? undefined;
    }
    if (name === 'issue_create') {
      const key = normalizeWorkspacePath(workspace);
      const existingKey = Object.keys(state.workspaces).find(value => normalize(value) === normalize(key)) ?? key;
      const segments = path.basename(workspace).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[-_.\s]+/).filter(Boolean);
      const suggested = (segments.length > 1
        ? segments.map(segment => segment.replace(/[^a-z0-9]/gi, '')[0] ?? '').join('')
        : (segments[0] ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 3)).toUpperCase().slice(0, 10);
      const config = state.workspaces[existingKey] ?? { projectKey: suggested.length >= 2 ? suggested : 'ISS', nextId: 1 };
      let id;
      do { id = `${config.projectKey}-${config.nextId++}`; } while (state.issues.some(row => row.id === id));
      state.workspaces[existingKey] = config;
      const status = taxonomy.statuses.find(row => row.role === 'backlog')?.id;
      if (!status && !patch.status) throw new Error('Configure a backlog status in Settings → Issues.');
      result = { id, title: args.title.trim(), description: '', type: taxonomy.types.find(row => row.id === 'task')?.id ?? taxonomy.types[0].id,
        priority: taxonomy.priorities.find(row => row.id === 'none')?.id ?? taxonomy.priorities[0].id,
        status, labels: [], workspacePath: workspace, source: 'agent', createdAt: now, updatedAt: now, ...patch };
      state.issues.push(result);
    } else if (name === 'issue_edit') {
      const issue = find(state);
      if (args.expected_updated_at !== undefined && args.expected_updated_at !== issue.updatedAt) throw new Error('Issue changed; read it again before editing.');
      if (!Object.keys(patch).length) throw new Error('Provide at least one field to edit.');
      Object.assign(issue, patch, { updatedAt: Math.max(now, issue.updatedAt + 1) });
      result = issue;
    } else throw new Error('Unknown issue tool.');
    return state;
  });
  return result;
}
