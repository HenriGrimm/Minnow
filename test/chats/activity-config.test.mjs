import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSessionsDb, closeSessionsDb } from '../../server/config/sessions-db.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { readSessionSummariesState, patchSessionState } from '../../server/config/sessions-repo.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';

test('summary-only restart preserves canonical activity and old session writers cannot clear it or store forged live projections', t => {
  const home = mkdtempSync(join(tmpdir(), 'minnow-activity-config-')), previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  t.after(() => { closeSessionsDb(); if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache(); rmSync(home, { recursive: true, force: true }); });
  let db = getSessionsDb(), repository = createChatRepository({ db, now: () => 1000 });
  repository.createChat({ id: 'child', name: 'Child', workspacePath: '/fixture', providerId: 'provider', modelId: 'model' });
  const fence = repository.claimExecution({ chatId: 'child', executionId: 'failed-child', ownerId: 'host', captured: { secret: 'PRIVATE PROFILE' } });
  repository.appendMessage('child', { role: 'assistant', content: 'PRIVATE CANONICAL HISTORY' }, { fence, messageId: 'response' });
  repository.updateExecution('failed-child', { status: 'failed' }, { fence }); repository.releaseLease('child', fence);
  let summary = readSessionSummariesState().chats.find(chat => chat.id === 'child');
  assert.equal(summary.history, undefined); assert.equal(summary.agentExecution.executionId, 'failed-child');
  assert.equal(summary.unread, true); assert.equal(summary.turnError, true);
  assert.doesNotMatch(JSON.stringify(summary.agentExecution), /PRIVATE/);
  const oldWriter = normalizeChatRow({ ...summary, unread: false, turnError: false, agentExecution: { executionId: 'forged', status: 'completed' } });
  patchSessionState({ baseVersion: 5, chats: [oldWriter] });
  closeSessionsDb(); db = getSessionsDb(); repository = createChatRepository({ db, now: () => 1000 });
  summary = readSessionSummariesState().chats.find(chat => chat.id === 'child');
  assert.equal(summary.agentExecution.executionId, 'failed-child'); assert.equal(summary.unread, true); assert.equal(summary.turnError, true);
  repository.acknowledgeActivity('child', summary.agentActivityCursor);
  assert.equal(readSessionSummariesState().chats.find(chat => chat.id === 'child').unread, false);
  patchSessionState({ chats: [{ id: 'ordinary', name: 'Ordinary', modelId: 'model', history: [],
    agentRequestSummary: [{ requestId: 'fake', kind: 'approval' }], agentExecution: { executionId: 'fake', status: 'running' } }] });
  const raw = JSON.parse(db.prepare('SELECT meta_json FROM chats WHERE id=?').get('ordinary').meta_json);
  assert.equal(raw.agentRequestSummary, undefined); assert.equal(raw.agentExecution, undefined);
});
