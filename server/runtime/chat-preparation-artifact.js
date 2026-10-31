import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHAT_PREPARATION_BUNDLE } from '../constants/headless-runner.js';
import { ChatContractError } from '../chats/contracts.js';

const builds = new Map();
async function file(full) {
  try { const stat = await fs.stat(full); return stat.isFile() && stat.size > 0; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

/** Source checkouts can build before listen; installed runtimes never need esbuild. */
export async function ensureChatPreparationArtifact({ appRoot, env = process.env, importBuilder = url => import(url) } = {}) {
  if (typeof appRoot !== 'string' || !path.isAbsolute(appRoot)) throw new TypeError('An absolute app root is required');
  const outfile = path.join(appRoot, CHAT_PREPARATION_BUNDLE);
  if (await file(outfile)) return { outfile, built: false };
  const script = path.join(appRoot, 'scripts/build-headless-runner.mjs');
  const source = path.join(appRoot, 'src/headless/chat-preparation.ts');
  const sourceCheckout = env.NODE_ENV !== 'production' && await file(source) && await file(script);
  if (!sourceCheckout) throw new ChatContractError('capability_unavailable',
    'The installed chat preparation bundle is missing. Rebuild or reinstall Minnow before starting the conversation host.');
  let pending = builds.get(outfile);
  if (!pending) {
    pending = (async () => {
      const builder = await importBuilder(pathToFileURL(script).href);
      if (typeof builder.buildChatPreparation !== 'function') throw new ChatContractError('capability_unavailable', 'The source checkout has no chat preparation builder');
      await builder.buildChatPreparation({ outfile });
      if (!await file(outfile)) throw new ChatContractError('capability_unavailable', 'The chat preparation build did not produce a runtime artifact');
      return { outfile, built: true };
    })();
    builds.set(outfile, pending);
  }
  try { return await pending; }
  finally { if (builds.get(outfile) === pending) builds.delete(outfile); }
}
