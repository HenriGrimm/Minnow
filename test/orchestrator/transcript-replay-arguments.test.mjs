import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { recordTranscriptEvent, flushTranscripts, readTranscript, resetTranscripts, transcriptPathFor } from '../../server/orchestrator/transcripts.js';
import { turnEventsToMessages } from '../../server/orchestrator/transcript-messages.js';

test('cold recovery keeps long call arguments independent of display and marks missing legacy arguments', async (t) => {
  const entryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mn-args-'));
  t.after(() => fs.rm(entryDir, { recursive: true, force: true }));
  const attemptId = 'work';
  const args = { path: 'file.txt', content: 'x'.repeat(10_000) };
  for (const event of [
    { type: 'tool_call', id: 'save', name: 'save_file', arguments: JSON.stringify(args) },
    { type: 'tool_result', id: 'save', content: 'Saved file.txt' },
    { type: 'tool_call', id: 'huge', name: 'apply_patch', arguments: JSON.stringify({ patch: 'a'.repeat(600_000) }) },
  ]) recordTranscriptEvent({ entryDir, attemptId, event });
  await flushTranscripts(undefined, attemptId, { entryDir });
  await fs.appendFile(transcriptPathFor(entryDir, attemptId), JSON.stringify({
    type: 'tool_call', id: 'legacy', name: 'apply_patch', arguments: '{"patch":"part… [clipped]',
  }) + '\n');
  resetTranscripts();
  const display = await readTranscript(undefined, attemptId, { entryDir });
  assert.ok(display.events[0].arguments.endsWith('… [clipped]'));
  assert.equal(display.events[0].replayArguments, undefined);
  const recovery = await readTranscript(undefined, attemptId, { entryDir, forReplay: true });
  const messages = turnEventsToMessages(recovery.events);
  assert.deepEqual(JSON.parse(messages[0].tool_calls[0].function.arguments), args);
  assert.equal(messages[1].content, 'Saved file.txt');
  for (const event of recovery.events.slice(2)) assert.match(JSON.parse(event.arguments)._minnow_replay, /truncated/);
});
