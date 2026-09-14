/**
 * Long-session fixtures for the compactor. Shapes follow real Minnow chat
 * history rows (tool_calls JSON arguments, codeChange stats, screenshot
 * follow-ups), but every path, command and message is synthetic.
 */

let callSeq = 0;

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string} content
 * @param {Record<string, unknown>} [extra]
 */
export function toolRound(name, args, content, extra = {}) {
  callSeq += 1;
  const id = `call_${callSeq}`;
  return [
    {
      role: 'assistant',
      content: extra.prose ?? '',
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    { role: 'tool', tool_call_id: id, content, ...(extra.codeChange ? { codeChange: extra.codeChange } : {}) },
  ];
}

const FILE_BODY = (label, lines) =>
  Array.from({ length: lines }, (_, i) => `export const ${label}_${i} = computeValue(${i}, "${label}");`).join('\n');

/** A refactor session: reads, edits, a failing then passing test run, commits. */
export function refactorSession() {
  callSeq = 0;
  const rows = [{ role: 'system', content: 'You are Minnow, a coding agent.' }];
  rows.push({ role: 'user', content: 'Refactor the session store in src/state/store.ts so writes are batched. Always keep the public API unchanged.' });
  rows.push(...toolRound('read_file', { path: 'src/state/store.ts' }, FILE_BODY('store', 220)));
  rows.push(...toolRound('read_file', { path: 'src/state/persist.ts' }, FILE_BODY('persist', 160)));
  rows.push(...toolRound('replace_text_in_file', { path: 'src/state/store.ts', search: 'a', replace: 'b' }, 'Replaced 1 occurrence.', {
    codeChange: { additions: 24, deletions: 9, path: 'src/state/store.ts' },
  }));
  rows.push(...toolRound('execute_command', { command: 'npm test -- store' }, `${FILE_BODY('log', 60)}\n2 failing\nexit code: 1`));
  rows.push({ role: 'assistant', content: 'Two store tests fail because flush ordering changed. I will fix the queue drain.' });
  rows.push({ role: 'user', content: 'Actually, switch to a microtask queue instead of setTimeout.' });
  rows.push(...toolRound('replace_text_in_file', { path: 'src/state/store.ts', search: 'c', replace: 'd' }, 'Replaced 1 occurrence.', {
    codeChange: { additions: 6, deletions: 4, path: 'src/state/store.ts' },
  }));
  rows.push(...toolRound('save_file', { path: 'src/state/queue.ts', content: 'x' }, 'Saved src/state/queue.ts', {
    codeChange: { additions: 41, deletions: 0, path: 'src/state/queue.ts' },
  }));
  rows.push(...toolRound('execute_command', { command: 'npm test -- store' }, `${FILE_BODY('log2', 40)}\n14 passing`));
  rows.push(...toolRound('git_commit', { message: 'Batch session store writes' }, '[main 4f2a9c1] Batch session store writes\n 2 files changed'));
  rows.push({ role: 'assistant', content: 'Writes now batch through a microtask queue; all 14 store tests pass and the change is committed as 4f2a9c1.' });
  rows.push({ role: 'user', content: 'Now add a test for the flush-on-quit path.' });
  rows.push(...toolRound('todo_write', { todos: [
    { text: 'Write flush-on-quit test', status: 'in_progress' },
    { text: 'Run the full store suite', status: 'pending' },
  ] }, 'Todos updated.'));
  rows.push(...toolRound('read_file', { path: 'test/state/store.test.ts' }, FILE_BODY('test', 180)));
  rows.push(...toolRound('save_file', { path: 'test/state/flush-quit.test.ts', content: 'y' }, 'Saved test/state/flush-quit.test.ts', {
    codeChange: { additions: 38, deletions: 0, path: 'test/state/flush-quit.test.ts' },
  }));
  return rows;
}

/** A debugging session with sub-agents, errors that get resolved, and many turns. */
export function debugSession(turns = 14) {
  callSeq = 0;
  const rows = [{ role: 'system', content: 'You are Minnow.' }];
  rows.push({ role: 'user', content: 'The desktop build crashes on launch with ENOENT for config.json. Find out why.' });
  rows.push(...toolRound('spawn_sub_agent', { type: 'explorer', task: 'Find every reader of config.json in server/' }, 'Found 3 readers: server/config/home.js, server/config/load.js, electron/main.js'));
  rows.push(...toolRound('read_file', { path: 'server/config/load.js' }, FILE_BODY('load', 140)));
  rows.push(...toolRound('execute_command', { command: 'npm run package:dir' }, `${FILE_BODY('build', 30)}\nError: ENOENT: no such file or directory, open 'config.json'\nexit code: 2`));
  for (let t = 0; t < turns; t += 1) {
    rows.push({ role: 'user', content: t === 3 ? 'Never touch the release/ folder, please.' : `Keep going on step ${t + 1}.` });
    rows.push(...toolRound('read_file', { path: `server/config/part-${t}.js` }, FILE_BODY(`part${t}`, 90)));
    rows.push(...toolRound('replace_text_in_file', { path: `server/config/part-${t}.js`, search: 'p', replace: 'q' }, t === 5 ? 'Error: search text not found' : 'Replaced 1 occurrence.', {
      codeChange: t === 5 ? undefined : { additions: t + 1, deletions: 1, path: `server/config/part-${t}.js` },
    }));
    rows.push({ role: 'assistant', content: `Step ${t + 1} done: part-${t} now resolves config relative to the app root.` });
  }
  rows.push(...toolRound('execute_command', { command: 'npm run package:dir' }, `${FILE_BODY('build2', 30)}\nBuild complete.`));
  rows.push({ role: 'user', content: 'Great. Summarize what the root cause was.' });
  return rows;
}

/** A screenshot-heavy browser session (follow-up image rows between rounds). */
export function browserSession(rounds = 10) {
  callSeq = 0;
  const pixel = `data:image/png;base64,${'iVBORw0KGgo'.repeat(400)}`;
  const rows = [{ role: 'system', content: 'You are Minnow.' }];
  rows.push({ role: 'user', content: 'Check the settings page renders at 400px wide and fix any overflow.' });
  for (let r = 0; r < rounds; r += 1) {
    rows.push(...toolRound('browser_screenshot', { width: 400 }, `Screenshot ${r} captured.\n${FILE_BODY(`dom${r}`, 50)}`));
    rows.push({
      role: 'user',
      toolImageFollowUp: true,
      content: [
        { type: 'text', text: '[tool screenshot] Visual result of the preceding tool call. Inspect the image; do not fetch the file URL.' },
        { type: 'image_url', image_url: { url: pixel, detail: 'auto' } },
      ],
    });
    if (r % 3 === 2) {
      rows.push(...toolRound('replace_text_in_file', { path: 'src/styles/settings.css', search: 'm', replace: 'n' }, 'Replaced 1 occurrence.', {
        codeChange: { additions: 2, deletions: 2, path: 'src/styles/settings.css' },
      }));
    }
  }
  return rows;
}

/**
 * A multi-megabyte history: `turns` turns of four tool rounds each.
 * @param {number} turns
 */
export function hugeSession(turns = 300) {
  callSeq = 0;
  const rows = [{ role: 'system', content: 'You are Minnow.' }];
  for (let t = 0; t < turns; t += 1) {
    rows.push({ role: 'user', content: `Task ${t}: update module ${t} and run its tests.` });
    for (let r = 0; r < 4; r += 1) {
      rows.push(...toolRound(r % 2 ? 'execute_command' : 'read_file', r % 2 ? { command: `npm test -- m${t}` } : { path: `src/m${t}/index.ts` }, FILE_BODY(`m${t}r${r}`, 40)));
    }
    rows.push({ role: 'assistant', content: `Module ${t} updated and tested.` });
  }
  return rows;
}
