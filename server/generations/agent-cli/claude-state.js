import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cliHash } from './checkpoints.js';
import { resolveAgentCliBin } from './resolve-bin.js';
import { getEffectiveWorkspaceRoot } from '../../runtime/path-access.js';
import { cliAccountIdentity } from './auth-identity.js';

function configRoot() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
export async function agentCliIdentity(settings, secrets = {}) {
  const kind = settings.kind === 'cursor-agent' ? 'cursor' : settings.kind;
  const bin = await resolveAgentCliBin({ kind: kind === 'cursor' ? 'cursor-agent' : kind, binPath: settings.binPath });
  const stat = await fs.stat(bin.command).catch(() => ({}));
  const authFiles = kind === 'claude'
    ? [path.join(configRoot(), '.credentials.json'), path.join(configRoot(), '.claude.json'), path.join(os.homedir(), '.claude.json')]
    : [path.join(process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), '.cursor'), 'auth.json')];
  const auth = await Promise.all(authFiles.map(async file => {
    const data = await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    // Claude updates telemetry/preferences in .claude.json on ordinary turns.
    if (file.endsWith('.claude.json') && data.length) {
      try { return JSON.stringify(JSON.parse(data).oauthAccount ?? null); } catch { return ''; }
    }
    return cliAccountIdentity(data);
  }));
  const envAuth = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN']
    .map(key => process.env[key] || '');
  // Claude OAuth access tokens are opaque. Its account metadata supplies the
  // stable identity when available; refresh must not invalidate every turn.
  if (kind === 'claude' && auth.slice(1).some(value => {
    try { const account = JSON.parse(value); return account?.accountUuid || account?.userId; } catch { return false; }
  })) auth[0] = 'oauth-account-metadata';
  return { workspace: getEffectiveWorkspaceRoot(), binary: [bin.command, bin.argsPrefix, stat.size, stat.mtimeMs],
    settings, account: cliHash([...auth.map(cliHash), secrets, envAuth]), configRoot: kind === 'claude' ? configRoot() : undefined };
}

/** Native transcripts remain opaque; never synthesize or modify their records. */
export async function snapshotClaudeSession(session, { allowClosed = false } = {}) {
  const projects = path.join(session.identity.configRoot, 'projects');
  const expectedKey = session.tempDir.replace(/[^a-zA-Z0-9]/g, '-');
  const projectFile = path.join(projects, expectedKey, `${session.nativeId}.jsonl`);
  const destination = path.join(session.cacheDir, `${session.nativeId}.jsonl`);
  const text = content => typeof content === 'string' ? content : (content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
  let data;
  let file;
  let reason = 'Native transcript has not been written; restart will rebuild.';
  const deadline = Date.now() + 2000;
  do {
    if (session.closed && !allowClosed) return null;
    for (const source of session.resume ? [destination, projectFile] : [projectFile]) {
      const parent = await fs.lstat(path.dirname(source)).catch(() => null);
      const stat = await fs.lstat(source).catch(() => null);
      if (parent?.isDirectory() && !parent.isSymbolicLink() && stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024) {
        const candidate = await fs.readFile(source);
        const prefix = session.nativeVerifiedPrefix;
        if (prefix && (candidate.length < prefix.bytes || cliHash(candidate.subarray(0, prefix.bytes)) !== prefix.digest)) {
          session.reason = 'Native conversation history changed; restart will rebuild.';
          return null;
        }
        try {
          const rows = candidate.toString('utf8').trim().split('\n').map(JSON.parse);
          const assistant = rows.findLast(row => row.type === 'assistant' && row.message?.content?.some(part => part.type === 'text'));
          const user = rows.findLast(row => row.type === 'user' && (typeof row.message?.content === 'string'
            || Array.isArray(row.message?.content) && row.message.content.some(part => part.type === 'text' || part.type === 'image')));
          if (assistant && user && (!session.completedNativeMessageId || assistant.message.id === session.completedNativeMessageId)
            && text(assistant.message.content) === session.completedText
            && text(user.message.content) === text(session.lastNativeInput)) { data = candidate; file = source; break; }
          reason = !assistant || !user ? 'Native transcript is missing the completed exchange; restart will rebuild.'
            : text(assistant.message.content) !== session.completedText ? 'Native transcript has not committed the final response; restart will rebuild.'
              : 'Native transcript has not committed the latest input; restart will rebuild.';
        } catch { /* A buffered native write can leave the final JSONL row incomplete. */ }
      }
    }
    if (data) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  if (!data || session.closed && !allowClosed) { session.reason = reason; return null; }
  if (file !== destination) {
    await fs.writeFile(`${destination}.tmp`, data, { mode: 0o600 });
    await fs.rename(`${destination}.tmp`, destination);
  }
  session.nativeSource = file;
  const digest = cliHash(data);
  session.nativeVerifiedPrefix = { bytes: data.length, digest };
  return digest;
}
export async function verifyClaudeContinuation(session) {
  if (!session.nativeSource || !session.nativeVerifiedPrefix) return false;
  const stat = await fs.lstat(session.nativeSource).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) return false;
  const data = await fs.readFile(session.nativeSource).catch(() => null);
  const prefix = session.nativeVerifiedPrefix;
  return Boolean(data && data.length >= prefix.bytes && cliHash(data.subarray(0, prefix.bytes)) === prefix.digest);
}
export async function verifyClaudeSnapshot(record) {
  if (!record?.nativeDigest || !/^[a-f0-9-]{36}$/i.test(record.nativeId)) return false;
  const file = path.join(record.dir, `${record.nativeId}.jsonl`);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) return false;
  return cliHash(await fs.readFile(file)) === record.nativeDigest;
}
export async function removeOwnedClaudeTranscript(session) {
  if (!session.nativeSource || !session.identity?.configRoot) return;
  const projects = path.resolve(session.identity.configRoot, 'projects');
  const parent = path.dirname(path.resolve(session.nativeSource));
  if (path.dirname(parent) !== projects || path.basename(parent) !== session.tempDir.replace(/[^a-zA-Z0-9]/g, '-')
    || path.basename(session.nativeSource) !== `${session.nativeId}.jsonl`) return;
  await fs.rm(session.nativeSource, { force: true });
}
