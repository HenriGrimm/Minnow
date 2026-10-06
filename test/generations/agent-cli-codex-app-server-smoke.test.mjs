import { test } from 'node:test';
import { runCodexAppServerSmoke } from '../../scripts/codex-app-server-smoke.mjs';

test('installed Codex isolates inference, retains history and hands dynamic tools to the client', {
  skip: process.env.MINNOW_CODEX_APP_SERVER_SMOKE !== '1', timeout: 60_000,
}, async () => { await runCodexAppServerSmoke(); });

test('installed Codex compaction changes accepted history and needs Minnow reconciliation', {
  skip: process.env.MINNOW_CODEX_APP_SERVER_SMOKE !== '1', timeout: 60_000,
}, async () => { await runCodexAppServerSmoke({ compactThreshold: 1 }); });
