import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  createCompanionControlMiddleware,
  resetCompanionControlPlaneForTests,
} from '../../server/companion/control-plane.js';
import { handleAcpRequest } from '../../server/acp/middleware.js';
import { createSchedulerMiddleware } from '../../server/scheduler/middleware.js';
import { createShipGateMiddleware } from '../../server/ship-gate/middleware.js';

function request({ url, method = 'GET', auth, body }) {
  return {
    url,
    method,
    minnowAuth: auth,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body ?? ''; },
  };
}

async function call(middleware, options) {
  const req = request(options);
  const res = response();
  let next = false;
  await middleware(req, res, () => { next = true; });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, next };
}

const host = { kind: 'host' };
const phone = { kind: 'device', deviceId: 'a'.repeat(24), deviceName: 'Phone' };

describe('LAN companion control plane', () => {
  afterEach(() => resetCompanionControlPlaneForTests());

  test('keeps host publishing and command consumption separate from paired devices', async () => {
    const middleware = createCompanionControlMiddleware({ now: () => 10_000 });
    assert.equal((await call(middleware, {
      url: '/api/companion/control/state',
      method: 'PUT',
      auth: phone,
      body: { tasks: [] },
    })).status, 403);
    assert.equal((await call(middleware, {
      url: '/api/companion/control/commands',
      method: 'POST',
      auth: host,
      body: { kind: 'message', chatId: 'c1', text: 'Ship it', delivery: 'steer' },
    })).status, 403);
    assert.equal((await call(middleware, {
      url: '/api/companion/control/commands',
      auth: phone,
    })).status, 403);
  });

  test('publishes bounded task state and relays steering commands without persistence', async () => {
    let now = 20_000;
    const middleware = createCompanionControlMiddleware({ now: () => now });
    const published = await call(middleware, {
      url: '/api/companion/control/state',
      method: 'PUT',
      auth: host,
      body: {
        tasks: [{
          id: 'chat-1',
          title: 'Build companion',
          status: 'running',
          queued: 2,
          updatedAt: 19_000,
          review: {
            status: 'running',
            outcome: 'Working through the tests',
            summary: 'Edited 2 files',
            actions: 4,
            failedActions: 0,
            files: [{ path: 'src/companion.ts', additions: 12, deletions: 1 }],
          },
        }],
        approvals: [],
      },
    });
    assert.equal(published.status, 200);

    const state = await call(middleware, { url: '/api/companion/control', auth: phone });
    assert.equal(state.status, 200);
    assert.equal(state.json.connected, true);
    assert.equal(state.json.tasks[0].status, 'running');
    assert.equal(state.json.tasks[0].review.files[0].path, 'src/companion.ts');

    const queued = await call(middleware, {
      url: '/api/companion/control/commands',
      method: 'POST',
      auth: phone,
      body: { kind: 'message', chatId: 'chat-1', text: 'Run the focused suite', delivery: 'steer' },
    });
    assert.equal(queued.status, 202);
    const claimed = await call(middleware, {
      url: '/api/companion/control/commands',
      auth: host,
    });
    assert.equal(claimed.status, 200);
    assert.deepEqual(claimed.json.commands[0], {
      id: queued.json.commandId,
      kind: 'message',
      createdAt: now,
      deviceId: phone.deviceId,
      deviceName: 'Phone',
      chatId: 'chat-1',
      text: 'Run the focused suite',
      delivery: 'steer',
    });
    assert.equal((await call(middleware, {
      url: `/api/companion/control/commands/${queued.json.commandId}`,
      method: 'DELETE',
      auth: host,
    })).status, 200);
    assert.deepEqual((await call(middleware, {
      url: '/api/companion/control/commands',
      auth: host,
    })).json.commands, []);
  });

  test('remote approvals permit one call or denial, never a persistent permission change', async () => {
    let now = 30_000;
    const middleware = createCompanionControlMiddleware({ now: () => now });
    await call(middleware, {
      url: '/api/companion/control/state',
      method: 'PUT',
      auth: host,
      body: {
        tasks: [],
        approvals: [{ id: 'approval-1', toolName: 'save_file', title: 'Save file', argsJson: '{}' }],
      },
    });
    assert.equal((await call(middleware, {
      url: '/api/companion/control/commands',
      method: 'POST',
      auth: phone,
      body: { kind: 'approval', approvalId: 'approval-1', decision: 'always-allow' },
    })).status, 400);
    assert.equal((await call(middleware, {
      url: '/api/companion/control/commands',
      method: 'POST',
      auth: phone,
      body: { kind: 'approval', approvalId: 'approval-1', decision: 'allow-once' },
    })).status, 202);
    assert.equal((await call(middleware, {
      url: '/api/companion/control/commands',
      method: 'POST',
      auth: phone,
      body: { kind: 'approval', approvalId: 'approval-1', decision: 'allow-once' },
    })).status, 409);

    now += 15_001;
    const stale = await call(middleware, { url: '/api/companion/control', auth: phone });
    assert.equal(stale.json.connected, false);
    assert.deepEqual(stale.json.approvals, []);
    assert.deepEqual(stale.json.tasks, []);
  });

  test('rejects unpublished targets and removes commands invalidated by a new host snapshot', async () => {
    let now = 40_000;
    const middleware = createCompanionControlMiddleware({ now: () => now });
    await call(middleware, {
      url: '/api/companion/control/state',
      method: 'PUT',
      auth: host,
      body: {
        tasks: [{ id: 'visible-chat', title: 'Visible', status: 'running' }],
        approvals: [{
          id: 'visible-approval',
          toolName: 'execute_command',
          title: 'Run',
          argsJson: '{"api_key":"private-value","command":"token=also-private npm test"}',
        }],
      },
    });

    assert.equal((await call(middleware, {
      url: '/api/companion/control/commands',
      method: 'POST',
      auth: phone,
      body: { kind: 'message', chatId: 'hidden-chat', text: 'Run this', delivery: 'send' },
    })).status, 409);
    assert.equal((await call(middleware, {
      url: '/api/companion/control/commands',
      method: 'POST',
      auth: phone,
      body: { kind: 'approval', approvalId: 'stale-approval', decision: 'allow-once' },
    })).status, 409);

    const visible = await call(middleware, { url: '/api/companion/control', auth: phone });
    assert.doesNotMatch(visible.body ?? JSON.stringify(visible.json), /private-value|also-private/);

    assert.equal((await call(middleware, {
      url: '/api/companion/control/commands',
      method: 'POST',
      auth: phone,
      body: { kind: 'message', chatId: 'visible-chat', text: 'Run this', delivery: 'steer' },
    })).status, 202);
    now += 1;
    await call(middleware, {
      url: '/api/companion/control/state',
      method: 'PUT',
      auth: host,
      body: { tasks: [], approvals: [] },
    });
    assert.deepEqual((await call(middleware, {
      url: '/api/companion/control/commands',
      auth: host,
    })).json.commands, []);
  });

  test('paired device credentials cannot reach privileged ACP, ship-gate, or Scheduler execution routes', async () => {
    const acpReq = request({
      url: '/api/models/acp-agents',
      method: 'POST',
      auth: phone,
      body: { id: 'unsafe', command: 'node' },
    });
    const acpRes = response();
    assert.equal(await handleAcpRequest(acpReq, acpRes, '/api/models/acp-agents'), true);
    assert.equal(acpRes.statusCode, 403);

    const shipGate = createShipGateMiddleware();
    assert.equal((await call(shipGate, {
      url: '/api/ship-gate/config',
      method: 'PUT',
      auth: phone,
      body: { config: { checks: [{ id: 'tests', command: 'malicious command' }] } },
    })).status, 403);

    const scheduler = createSchedulerMiddleware();
    assert.equal((await call(scheduler, {
      url: '/api/scheduler/jobs',
      method: 'POST',
      auth: phone,
      body: { label: 'Unsafe', prompt: 'Run a command' },
    })).status, 403);
  });
});
