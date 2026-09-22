import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { fallbackMtplxDescriptor } from './mtplx-descriptor.js';
import { normalizeMtplxSettings } from './mtplx-settings.js';

export async function readMtplxConfig() {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(getMinnowHome(), 'mtplx.json'), 'utf8'));
    return normalizeMtplxSettings(raw.defaults ?? raw);
  }
  catch { return {}; }
}
export function extraHasFlag(extra, flag) { return extra.some((arg) => arg === flag || arg.startsWith(`${flag}=`)); }
export function buildMtplxServeLaunch(opts) {
  const descriptor = opts.descriptor ?? fallbackMtplxDescriptor(opts.modelPath);
  const warning = [];
  const settings = normalizeMtplxSettings({
    ...(descriptor.draft?.supported ? { depth: descriptor.draft.default } : {}),
    ...(descriptor.contextWindow?.supported ? { context_window: descriptor.contextWindow.default } : {}),
    ...(descriptor.recommendedProfile ? { profile: descriptor.recommendedProfile } : {}),
    ...(descriptor.sampling ? { default_temperature: descriptor.sampling.temperature, default_top_p: descriptor.sampling.top_p, default_top_k: descriptor.sampling.top_k } : {}),
    ...opts.defaults, ...opts.saved, ...opts.settings,
  }, descriptor, warning);
  const extra = settings.extra_args ?? [];
  // Identity, transcript semantics and auth are controlled here, not by argv order.
  const reserved = ['--model', '--port', '--stats-footer', '--no-stats-footer', '--agent-rewrites', '--no-auth', '--api-key', '--api-key-file', '--yes'];
  if (extra.includes('--') || extra.some((arg) => arg.startsWith('--') && reserved.some((flag) => flag.startsWith(arg.split('=')[0])))) throw new Error('Extra MTPLX arguments cannot override model, port, authentication, stats footer, or agent rewrites.');
  if (extra.some((arg) => arg.startsWith('--') && arg.split('=')[0] !== '--host' && '--host'.startsWith(arg.split('=')[0]))) throw new Error('Use the full --host option for MTPLX bind addresses.');
  const hostIndex = extra.findLastIndex((arg) => arg === '--host' || arg.startsWith('--host='));
  const host = hostIndex < 0 ? '127.0.0.1' : extra[hostIndex].includes('=') ? extra[hostIndex].slice(7) : extra[hostIndex + 1];
  if (!host || host.startsWith('--')) throw new Error('--host requires a bind address');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const apiKeyFile = loopback ? null : path.join(os.homedir(), '.mtplx', 'api-key');
  const args = ['serve', '--model', opts.modelPath, '--port', String(opts.port)];
  if (hostIndex < 0) args.push('--host', host);
  for (const [key, value] of Object.entries(settings)) {
    if (['extra_args', 'env', 'idle_ttl_ms'].includes(key)) continue;
    const flag = `--${key.replaceAll('_', '-')}`;
    if (extraHasFlag(extra, flag) || extraHasFlag(extra, `--no-${key.replaceAll('_', '-')}`)) continue;
    if (typeof value === 'boolean') { if (value) args.push(flag); }
    else args.push(flag, String(value));
  }
  args.push(...extra, '--no-stats-footer', '--agent-rewrites', 'off', '--yes');
  args.push(...(apiKeyFile ? ['--api-key-file', apiKeyFile] : ['--no-auth']));
  return { args, warning: warning.join('\n'), settings, apiKeyFile, host };
}
