const string = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const cwd = {
  type: 'string',
  description: 'Selected worktree path. Defaults to the current workspace.',
};
export const ACTION_READ_TOOLS = ['action_inspect', 'release_inspect'];
export const ACTION_WRITE_TOOLS = [
  'action_run',
  'action_cancel',
  'action_command',
  'release_manage',
  'release_asset',
];
const definitions = [
  [
    'action_inspect',
    'Inspect actions',
    'Discover workflows, commands, capabilities, remote refs, or runs. Remote runs use numeric IDs; local runs use local-* IDs. Input definitions are read at the selected remote ref.',
    {
      operation: {
        type: 'string',
        enum: ['workflows', 'workflow', 'commands', 'capabilities', 'refs', 'runs', 'run', 'log'],
      },
      cwd,
      location: { type: 'string', enum: ['remote', 'local'] },
      id: string,
      path: string,
      ref: string,
      page: number,
      offset: number,
      kind: { type: 'string', enum: ['branches', 'tags', 'environments'] },
      branch: string,
      workflow: string,
      status: string,
    },
    ['operation'],
  ],
  [
    'action_run',
    'Run action',
    'Dispatch a GitHub workflow, start a local act workflow or saved command, or rerun an existing run. Local runs use the selected checkout including edits. Inspect the action and inputs first. Does not wait for completion. Blocked in Plan mode.',
    {
      cwd,
      location: { type: 'string', enum: ['remote', 'local'] },
      kind: { type: 'string', enum: ['workflow', 'command'] },
      id: string,
      rerun: boolean,
      failedOnly: boolean,
      commandId: string,
      path: string,
      ref: string,
      event: string,
      job: string,
      image: string,
      inputsJson: {
        type: 'string',
        description: 'JSON object containing declared workflow input values.',
      },
      secretNames: { type: 'array', items: string },
    },
    ['location'],
  ],
  [
    'action_cancel',
    'Cancel action',
    'Cancel a remote or local run in the selected repository. Local cancellation stops owned processes and containers. Blocked in Plan mode.',
    { cwd, location: { type: 'string', enum: ['remote', 'local'] }, id: string },
    ['location', 'id'],
  ],
  [
    'action_command',
    'Manage saved command',
    'Save or remove a named native command in .minnow/actions.json. Secrets are references to locally configured secret names, never plaintext. Blocked in Plan mode.',
    {
      cwd,
      remove: boolean,
      id: string,
      label: string,
      command: string,
      directory: string,
      shellProfile: string,
      envJson: { type: 'string', description: 'JSON object of non-secret environment values.' },
      secretsJson: {
        type: 'string',
        description: 'JSON object mapping environment names to stored secret names.',
      },
    },
    ['id'],
  ],
  [
    'release_inspect',
    'Inspect releases',
    'List releases or inspect one including assets, immutability and write permissions.',
    { cwd, id: number, page: number },
    [],
  ],
  [
    'release_manage',
    'Manage release',
    'Create a draft, edit, publish, generate notes, or delete a GitHub release. New tags require an explicit remote commit SHA. Deletion retains the Git tag. Blocked in Plan mode.',
    {
      operation: { type: 'string', enum: ['create', 'edit', 'publish', 'notes', 'delete'] },
      cwd,
      id: number,
      tag: string,
      target: string,
      createTag: boolean,
      title: string,
      body: string,
      prerelease: boolean,
      previousTag: string,
      latest: { type: 'string', enum: ['true', 'false', 'legacy'] },
    },
    ['operation'],
  ],
  [
    'release_asset',
    'Manage release asset',
    'Upload, download, or delete an asset. File and directory paths are relative to the worktree. Replacement must be explicit. Blocked in Plan mode.',
    {
      operation: { type: 'string', enum: ['upload', 'download', 'delete'] },
      cwd,
      id: number,
      assetId: number,
      path: string,
      directory: string,
      replace: boolean,
    },
    ['operation', 'id'],
  ],
];
/** @type {import('../../src/tools/definitions').ToolDefinition[]} */
export const ACTION_TOOLS = definitions.map(([id, label, description, properties, required]) => ({
  id,
  label,
  description,
  category: 'git',
  serverRequired: true,
  definition: {
    type: 'function',
    function: { name: id, description, parameters: { type: 'object', properties, required } },
  },
}));
