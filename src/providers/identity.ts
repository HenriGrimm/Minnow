import { listSettingsLocalPresets, PROVIDER_PRESETS } from './presets';
import type { ProviderPublic } from './types';

const HOST_LOGOS: Record<string, string> = {
  'openrouter.ai': 'openrouter',
  'api.openai.com': 'openai',
  'api.groq.com': 'groq',
  'api.mistral.ai': 'mistral',
  'opencode.ai': 'opencode',
  'api.anthropic.com': 'anthropic',
  'api.deepseek.com': 'deepseek',
  'generativelanguage.googleapis.com': 'google',
  'api.githubcopilot.com': 'githubcopilot',
  'api.business.githubcopilot.com': 'githubcopilot',
  'api.enterprise.githubcopilot.com': 'githubcopilot',
};

/** Resolve connection brands independently of the models they serve. */
export function providerLogoId(provider: Pick<ProviderPublic, 'id' | 'label' | 'baseUrl' | 'apiKind'> & { agentCli?: ProviderPublic['agentCli'] }): string | null {
  if (provider.id === 'llama-cpp-local' || provider.id === 'mlx-lm-local') return 'minnow';
  if (provider.apiKind === 'agent-cli-v1') {
    const kind = provider.agentCli?.kind ?? provider.id.replace(/-cli$/, '');
    if (kind === 'codex') return 'openai';
    if (kind === 'claude' || kind === 'claude-code') return 'anthropic';
    if (kind === 'cursor' || kind === 'cursor-agent') return 'cursor';
  }
  try {
    const host = new URL(provider.baseUrl).hostname.toLowerCase();
    if (HOST_LOGOS[host]) return HOST_LOGOS[host];
  } catch {
  }
  if (provider.apiKind === 'lm-studio-v0') return 'lmstudio';
  const presets = [...listSettingsLocalPresets(), ...PROVIDER_PRESETS];
  const preset = presets.find((entry) =>
    provider.id === entry.id || provider.id.startsWith(`${entry.id}-`) ||
    provider.id === `onboarding-cloud-${entry.id}` ||
    provider.label.toLowerCase() === entry.label.toLowerCase(),
  );
  if (!preset) return null;
  if (preset.id === 'lm-studio') return 'lmstudio';
  if (preset.id.startsWith('opencode-')) return 'opencode';
  if (preset.id === 'github-copilot') return 'githubcopilot';
  return preset.id;
}

export function createProviderLogo(provider: Parameters<typeof providerLogoId>[0]): HTMLElement {
  const mark = document.createElement('span');
  mark.className = 'settings-providers-logo';
  mark.setAttribute('aria-hidden', 'true');
  const id = providerLogoId(provider);
  if (id) {
    mark.dataset.logo = id;
    const glyph = document.createElement('span');
    glyph.className = 'settings-providers-logo-glyph';
    const path = id === 'minnow' ? '/logos/minnow-glyph.svg' : `/logos/providers/${id}.svg`;
    glyph.style.maskImage = `url("${path}")`;
    mark.append(glyph);
  } else {
    mark.textContent = provider.label.trim().slice(0, 2).toUpperCase() || '?';
  }
  return mark;
}
