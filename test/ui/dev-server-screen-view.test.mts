import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  cyclePortsListSort,
  deriveDevServerRowView,
  deriveHubDevServersSummary,
  filterListeningPorts,
  sortListeningPorts,
} from '../../src/ui/dev-server-screen-view.ts';
import type { DevServerListItem, ListeningPortRow } from '../../src/config/dev-servers-api.ts';

const screenSource = readFileSync(
  new URL('../../src/ui/dev-server-screen.ts', import.meta.url),
  'utf8',
);

function item(partial: Partial<DevServerListItem> & { id: string }): DevServerListItem {
  const base: DevServerListItem = {
    id: partial.id,
    name: partial.name ?? partial.id,
    def: {
      id: partial.id,
      name: partial.name ?? partial.id,
      command: 'npm run dev',
      port: 5173,
      network: 'local',
      source: 'user',
    },
    status: 'stopped',
    runId: null,
    pid: null,
    healthOk: null,
    startedAt: null,
    portInUse: false,
    port: 5173,
    network: 'local',
    command: 'npm run dev',
    healthUrl: null,
    error: null,
  };
  return { ...base, ...partial };
}

describe('dev-server-screen-view', () => {
  test('Detect uses a regular Build chat instead of a sub-agent', () => {
    assert.match(screenSource, /createChatWithMode\(\{ modeId: 'build' \}\)/);
    assert.match(screenSource, /sendProgrammaticChatText\(chat, DETECT_USER_MESSAGE/);
    assert.doesNotMatch(screenSource, /spawnSubAgent|detectAgentRunId/);
  });

  test('offline row', () => {
    const view = deriveDevServerRowView(false, item({ id: 'a', status: 'stopped' }));
    assert.equal(view.uiState, 'offline');
    assert.equal(view.canStart, false);
  });

  test('setup / no_guide', () => {
    const view = deriveDevServerRowView(
      true,
      item({
        id: 'primary',
        status: 'no_guide',
        def: null,
        command: null,
      }),
    );
    assert.equal(view.uiState, 'setup');
  });

  test('running enables stop/restart', () => {
    const view = deriveDevServerRowView(
      true,
      item({ id: 'web', status: 'running', runId: 'r1', startedAt: Date.now() - 60_000 }),
    );
    assert.equal(view.uiState, 'running');
    assert.equal(view.canStop, true);
    assert.equal(view.canRestart, true);
    assert.equal(view.canStart, false);
  });

  test('port-conflict when stopped but port in use', () => {
    const view = deriveDevServerRowView(
      true,
      item({ id: 'web', status: 'stopped', portInUse: true }),
    );
    assert.equal(view.uiState, 'port-conflict');
    assert.ok(view.warning);
  });

  test('worktree label in meta', () => {
    const view = deriveDevServerRowView(
      true,
      item({
        id: 'web',
        status: 'stopped',
        worktreeRoot: 'C:/repo/.worktrees/feature-x',
      }),
      'C:/repo',
    );
    assert.equal(view.worktreeLabel, 'feature-x');
    assert.match(view.meta, /feature-x/);
  });

  test('hub summary counts running', () => {
    const summary = deriveHubDevServersSummary(true, [
      item({ id: 'a', status: 'running', port: 5173 }),
      item({ id: 'b', status: 'stopped', port: 3001 }),
    ]);
    assert.equal(summary.uiState, 'running');
    assert.match(summary.meta, /1 running/);
  });
});

function portRow(partial: Partial<ListeningPortRow> & { port: number; pid: number }): ListeningPortRow {
  return {
    address: '127.0.0.1',
    process: 'node',
    protected: false,
    ...partial,
  };
}

describe('filterListeningPorts', () => {
  const servers = [
    item({ id: 'web', status: 'running', port: 5173, pid: 100 }),
    item({ id: 'api', status: 'stopped', port: 3001, pid: null }),
  ];
  const rows: ListeningPortRow[] = [
    portRow({ port: 5173, pid: 100, process: 'vite' }),
    portRow({ port: 9473, pid: 200, process: 'minnow', protected: true }),
    portRow({ port: 4000, pid: 300, process: 'python' }),
  ];

  test('text search matches process and port', () => {
    const out = filterListeningPorts(rows, servers, { query: 'vite', scope: 'all' });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.port, 5173);
  });

  test('linked scope keeps dev-server rows only', () => {
    const out = filterListeningPorts(rows, servers, { query: '', scope: 'linked' });
    assert.deepEqual(
      out.map((r) => r.port),
      [5173],
    );
  });

  test('protected scope', () => {
    const out = filterListeningPorts(rows, servers, { query: '', scope: 'protected' });
    assert.deepEqual(
      out.map((r) => r.port),
      [9473],
    );
  });

  test('other scope excludes linked and protected', () => {
    const out = filterListeningPorts(rows, servers, { query: '', scope: 'other' });
    assert.deepEqual(
      out.map((r) => r.port),
      [4000],
    );
  });
});

describe('sortListeningPorts', () => {
  const servers = [item({ id: 'web', status: 'running', port: 5173, pid: 100 })];
  const rows: ListeningPortRow[] = [
    portRow({ port: 3000, pid: 50, process: 'api' }),
    portRow({ port: 5173, pid: 100, process: 'vite' }),
    portRow({ port: 8080, pid: 10, process: 'node' }),
  ];

  test('sorts by port ascending', () => {
    const out = sortListeningPorts(rows, servers, { key: 'port', direction: 'asc' });
    assert.deepEqual(
      out.map((r) => r.port),
      [3000, 5173, 8080],
    );
  });

  test('sorts by process descending', () => {
    const out = sortListeningPorts(rows, servers, { key: 'process', direction: 'desc' });
    assert.deepEqual(
      out.map((r) => r.process),
      ['vite', 'node', 'api'],
    );
  });

  test('cyclePortsListSort toggles direction on same column', () => {
    const first = cyclePortsListSort({ key: 'port', direction: 'asc' }, 'port');
    assert.deepEqual(first, { key: 'port', direction: 'desc' });
    const switched = cyclePortsListSort(first, 'pid');
    assert.deepEqual(switched, { key: 'pid', direction: 'asc' });
  });
});
