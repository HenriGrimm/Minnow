import fs from 'node:fs/promises';
import path from 'node:path';

/** Observe native thinking chunks without changing Claude's request or response. */
export async function prepareClaudeReasoningMod(cwd, { url, token, sessionId }) {
  const dir = path.join(cwd, 'minnow-reasoning');
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(dir, 'hooks'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'minnow-reasoning', version: '1.0.0', description: 'Streams available thinking summaries to Minnow.',
  }), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.js'] }), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'hooks', 'register.js'), `
export function register(on) {
  on('turn.step', async function* ($, event, next) {
    if (event.agentId) return yield* next(event);
    const stream = next(event);
    const indices = new Map();
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) return item.value;
        const chunk = item.value;
        if (chunk.kind === 'thinking' && chunk.text) {
          const index = indices.get(chunk.index) ?? 0;
          indices.set(chunk.index, index + 1);
          try {
            await $.http.fetch(${JSON.stringify(url)}, {
              method: 'POST', headers: { Authorization: ${JSON.stringify(`Bearer ${token}`)} },
              body: JSON.stringify({ session_id: ${JSON.stringify(sessionId)}, cwd: ${JSON.stringify(cwd)},
                turn_id: event.turnId, step_index: event.index, block_index: chunk.index, index, delta: chunk.text }),
            });
          } catch {}
        }
        yield chunk;
      }
    } finally { await stream.return(); }
  });
}
`, { mode: 0o600 });
  return dir;
}
