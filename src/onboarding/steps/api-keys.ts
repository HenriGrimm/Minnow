/**
 * S9 — Search API keys when private SearXNG was skipped.
 */

import { loadSearchConfig, saveSearchConfig } from '../../config/search-config';
import { el, renderStepHeader } from '../ui-helpers';
import type { OnboardingStep } from '../types';
import { recordStepProgress } from '../state-core';

let braveKey = '';
let tavilyKey = '';
let provider: 'tavily' | 'brave' | 'duckduckgo' = 'tavily';
let loadGeneration = 0;
let keysLoaded = false;

export const apiKeysStep: OnboardingStep = {
  id: 'api-keys',
  title: 'Search API keys',
  canSkip: true,
  isApplicable: (ctx) => ctx.searxngSkipped,

  render(container, _ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step';
    const generation = ++loadGeneration;
    let edited = false;
    renderStepHeader(container, apiKeysStep, actions.stepIndex, actions.totalSteps);

    container.appendChild(
      el(
        'p',
        'mn-onboarding-step-desc',
        'You skipped local SearXNG. Add a hosted search key or use DuckDuckGo without a key.',
      ),
    );

    const chipRow = el('div', 'mn-onboarding-chip-row');
    (
      [
        ['tavily', 'Tavily'],
        ['brave', 'Brave'],
        ['duckduckgo', 'DuckDuckGo'],
      ] as const
    ).forEach(([id, label]) => {
      const chip = el('button', 'mn-onboarding-wallpaper-chip', label);
      chip.type = 'button';
      if (provider === id) chip.classList.add('is-selected');
      chip.addEventListener('click', () => {
        provider = id;
        apiKeysStep.render(container, _ctx, actions);
      });
      chipRow.appendChild(chip);
    });
    container.appendChild(chipRow);

    const keysWrap = el('div', 'mn-onboarding-form-grid');
    if (provider === 'tavily') {
      const wrap = el('label', 'mn-onboarding-field-label');
      wrap.appendChild(el('span', undefined, 'Tavily API key'));
      const input = el('input', 'mn-onboarding-field') as HTMLInputElement;
      input.type = 'password';
      input.value = tavilyKey;
      input.autocomplete = 'off';
      input.addEventListener('input', () => {
        edited = true;
        tavilyKey = input.value.trim();
        actions.setPrimaryEnabled(tavilyKey.length > 0);
      });
      wrap.appendChild(input);
      keysWrap.appendChild(wrap);
    } else if (provider === 'brave') {
      const wrap = el('label', 'mn-onboarding-field-label');
      wrap.appendChild(el('span', undefined, 'Brave Search API key'));
      const input = el('input', 'mn-onboarding-field') as HTMLInputElement;
      input.type = 'password';
      input.value = braveKey;
      input.autocomplete = 'off';
      input.addEventListener('input', () => {
        edited = true;
        braveKey = input.value.trim();
        actions.setPrimaryEnabled(braveKey.length > 0);
      });
      wrap.appendChild(input);
      keysWrap.appendChild(wrap);
    } else {
      keysWrap.appendChild(
        el('p', 'mn-onboarding-muted', 'DuckDuckGo needs no API key. Rate limits apply.'),
      );
    }
    container.appendChild(keysWrap);

    if (!keysLoaded) void loadSearchConfig().then((config) => {
      if (generation !== loadGeneration) return;
      keysLoaded = true;
      if (provider !== 'brave' || !edited) braveKey = config.keys.braveApiKey;
      if (provider !== 'tavily' || !edited) tavilyKey = config.keys.tavilyApiKey;
      const input = keysWrap.querySelector('input');
      if (input && !edited) input.value = provider === 'brave' ? braveKey : tavilyKey;
      actions.setPrimaryEnabled(provider === 'duckduckgo' || Boolean(provider === 'brave' ? braveKey : tavilyKey));
    });

    actions.setPrimaryLabel(provider === 'duckduckgo' ? 'Continue' : 'Save and continue');
    actions.setPrimaryEnabled(provider === 'duckduckgo' || Boolean(provider === 'brave' ? braveKey : tavilyKey));
    return () => { loadGeneration += 1; };
  },

  async commit(ctx) {
    const config = await loadSearchConfig();
    await saveSearchConfig({
      ...config,
      provider,
      keys: {
        braveApiKey: braveKey,
        tavilyApiKey: tavilyKey,
      },
    });
    ctx.state = recordStepProgress(ctx.state, 'api-keys', {
      done: true,
      data: { provider },
    });
  },
};

export function resetApiKeysStepState(): void {
  braveKey = '';
  tavilyKey = '';
  provider = 'tavily';
  keysLoaded = false;
  loadGeneration += 1;
}
