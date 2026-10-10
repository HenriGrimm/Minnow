import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) { console.log('2.1.296 (Claude Code)'); process.exit(0); }
if (process.argv.includes('auth')) { console.log('{"loggedIn":true}'); process.exit(0); }

const trace = process.env.CLAUDE_CATALOG_TRACE;
const respond = row => process.stdout.write(`${JSON.stringify(row)}\n`);
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (trace) await fs.appendFile(trace, `${JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), request })}\n`);
  if (request.type !== 'control_request' || request.request?.subtype !== 'initialize') process.exit(2);
  const scenario = process.env.CLAUDE_CATALOG_SCENARIO;
  if (scenario === 'hang') return;
  if (scenario === 'exit') { process.exit(1); }
  const models = JSON.parse(await fs.readFile(process.env.CLAUDE_CATALOG_MODELS, 'utf8'));
  respond({ type: 'control_response', response: { request_id: request.request_id,
    subtype: scenario === 'error' ? 'error' : 'success', error: 'secret-must-not-appear',
    response: { account: { email: 'private-must-not-appear' }, models: scenario === 'malformed' ? {} : models } } });
});
