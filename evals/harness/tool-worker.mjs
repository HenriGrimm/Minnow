import fs from 'node:fs';
import { createInProcessToolDispatch } from '../../server/runner/tool-dispatch.js';
import { runWithViewWorkspace } from '../../server/runtime/path-access.js';
const profiles = JSON.parse(fs.readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));
const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
if (!profiles[request.profile]) throw new Error('Unknown benchmark profile');
if (request.name === 'execute_command' && request.args?.background) {
  process.stdout.write('MINNOW_RESULT:' + JSON.stringify({ content: 'Error: background command handles are unavailable in this benchmark adapter. Run foreground commands.' }) + '\n');
  process.exit(0);
}
const dispatch = createInProcessToolDispatch({ cwd: request.workspace, modeId: 'build',
  allowedToolNames: profiles[request.profile].tools });
const result = await runWithViewWorkspace(request.workspace, () =>
  dispatch.execute(request.name, request.args, { toolCallId: request.toolCallId }));
// Prefix makes unrelated server diagnostics distinguishable from the result.
process.stdout.write(`MINNOW_RESULT:${JSON.stringify(result)}\n`);
process.exit(0);
