import { watch, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';

const listeners = new Set();
const normalize = value => String(value ?? '').replaceAll('\\', '/').toLowerCase();
const relevant = value => /^(?:config\.json|tools\.json|sub-agents\.json|rules\.json|skills\.json|system-prompt\.json)(?:$|\.tmp-)/.test(value)
  || /^(?:work-agents|agents|mcp|plugins|prompts|tools|agent-packs|prompt-configs|profiles)(?:[/.]|$)/.test(value)
  || /^providers\/.*(?:secrets|credentials)/.test(value);
const policyDirectories = ['work-agents', 'agents', 'mcp', 'plugins', 'prompts', 'tools', 'agent-packs', 'prompt-configs', 'profiles', 'providers'];
const providerAuthority = profile => {
  if (!profile) return null;
  const { createdAt, updatedAt, label, pricing, ...rest } = profile;
  if (rest.agentCli) {
    const { nativeCodingTools, maxConcurrent, ...authority } = rest.agentCli;
    rest.agentCli = authority;
  }
  return JSON.stringify(rest);
};
export function invalidateNativeProviderBeforeWrite(before, after) {
  if (providerAuthority(before) === providerAuthority(after)) return;
  for (const invalidate of [...listeners]) invalidate();
}

/** Synchronous BEFORE-commit revocation. Catalog/settings discovery caches do
 * not carry these grants. Preference-only provider toggles are not revocations. */
export function invalidateNativePolicyBeforeWrite(relativeKey) {
  if (!relevant(normalize(relativeKey))) return;
  for (const invalidate of [...listeners]) invalidate();
}

/** External policy edits and watcher loss fail closed too. This is intentionally
 * conservative: a transient revoke/regrant retires the current admission. Native
 * workspace writes and sessions.db do NOT invalidate themselves. */
export function subscribeNativePolicyChanges({ home, cwd, providerId, onInvalidate, watchPath = watch }) {
  if (typeof onInvalidate !== 'function') throw new TypeError('Native policy monitoring requires invalidation');
  if (providerId != null && !/^[A-Za-z0-9_-]+$/.test(providerId)) throw new TypeError('Native policy monitoring requires an exact provider identity');
  const watchers = [];
  let disposed = false, invalidated = false;
  const invalidate = () => {
    if (disposed || invalidated) return;
    invalidated = true;
    onInvalidate();
  };
  listeners.add(invalidate);
  try {
    const profileKey = providerId && /^[A-Za-z0-9_-]+$/.test(providerId) ? `providers/${providerId}/profile.json` : null;
    const profileFile = profileKey && path.join(home, profileKey);
    const profileFingerprint = profileFile ? providerAuthority(JSON.parse(readFileSync(profileFile, 'utf8'))) : null;
    const changedPolicy = (event, filename) => {
      const changed = normalize(filename);
      if (filename == null || relevant(changed)) invalidate();
      else if (profileKey && event === 'rename' && (changed === 'providers' || changed === normalize(path.dirname(profileKey)))) invalidate();
      else if (profileKey && changed.startsWith(normalize(profileKey))) {
        try { if (providerAuthority(JSON.parse(readFileSync(profileFile, 'utf8'))) !== profileFingerprint) invalidate(); }
        catch { invalidate(); }
      }
    };
    const observe = (root, options, change) => {
      const watcher = watchPath(root, { ...options, persistent: false }, change);
      watchers.push(watcher); watcher.on('error', invalidate); watcher.on('close', invalidate);
    };
    // A shallow home watch catches policy-file/directory creation or replacement,
    // never SQLite/rollout writes beneath unrelated directories. Existing policy
    // trees alone get recursive watches; creation of an absent tree invalidates
    // this admission and a new admission installs its own recursive coverage.
    observe(home, {}, (event, filename) => changedPolicy(event, filename));
    for (const directory of policyDirectories) {
      const root = path.join(home, directory);
      let stat;
      try { stat = lstatSync(root); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A native policy directory cannot be monitored safely.');
      observe(root, { recursive: true }, (event, filename) => changedPolicy(event, filename == null ? null : path.join(directory, String(filename))));
    }
    // Detect replacement of the watched home too; watching an old directory
    // handle must not keep its successor's authority alive.
    const parents = new Map();
    for (const target of [cwd, home]) {
      const parent = path.dirname(target);
      if (!parents.has(parent)) parents.set(parent, new Set());
      parents.get(parent).add(normalize(path.basename(target)));
    }
    for (const [parent, names] of parents) observe(parent, {}, (event, filename) => {
      if (filename == null || event === 'rename' && names.has(normalize(filename))) invalidate();
    });
    if (invalidated) throw new Error('Native policy monitoring failed during admission.');
  } catch (error) {
    disposed = true; listeners.delete(invalidate); for (const watcher of watchers) watcher.close();
    throw Object.assign(new Error('Native execution cannot monitor live policy and checkout changes.'), { cause: error, cliPolicyRejected: true });
  }
  return () => { if (disposed) return; disposed = true; listeners.delete(invalidate); for (const watcher of watchers) watcher.close(); };
}
