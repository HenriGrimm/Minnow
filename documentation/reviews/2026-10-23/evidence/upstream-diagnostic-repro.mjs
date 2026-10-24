/** Execute the exact diagnostic function with filesystem spies; no real write. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const source = await fs.readFile(new URL('../../../../server/generations/upstream.js', import.meta.url), 'utf8');
const start = source.indexOf('function dumpUpstreamFailure(info)');
const end = source.indexOf('// ── Prepare', start);
assert.ok(start >= 0 && end > start);
const writes = [];
const dump = new Function('homedir', 'join', 'mkdirSync', 'writeFileSync',
  `${source.slice(start, end)}\nreturn dumpUpstreamFailure;`)(
  () => '/review-os-home', path.posix.join, () => {},
  (target, content) => writes.push({ target, content: JSON.parse(content) }),
);
process.env.MINNOW_HOME = '/review-isolated-home';
delete process.env.MINNOW_DEBUG;
dump({ status: 400, url: 'https://review.invalid/v1/chat/completions', providerId: 'fixture', modelId: 'fixture',
  requestBody: Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'PRIVATE_REVIEW_SENTINEL' }] })),
  responseText: 'Raw vendor response sentinel',
});
assert.equal(writes.length, 1);
assert.equal(writes[0].target, '/review-os-home/.minnow/debug/openai-upstream-last-error.json');
assert.equal(writes[0].content.requestBody.messages[0].content, 'PRIVATE_REVIEW_SENTINEL');
console.log(JSON.stringify({ writesWithoutDebugOptIn: writes.length, ignoresMinnowHome: true, retainsFullPrompt: true, actualFilesystemWrites: 0 }));
