/**
 * Web search setup, with Tavily recommended and optional alternatives.
 */

import { loadSearchConfig, saveSearchConfig, type SearchProvider } from '../../config/search-config';
import { el, renderStepHeader } from '../ui-helpers';
import type { OnboardingContext, OnboardingStep } from '../types';
import { recordStepProgress } from '../state-core';

let braveKey = '';
let tavilyKey = '';
let provider: SearchProvider = 'tavily';
let searxngUrl = 'http://localhost:8899';
let loadGeneration = 0;
let keysLoaded = false;
let currentContext: OnboardingContext | null = null;

export const apiKeysStep: OnboardingStep = {
  id: 'api-keys',
  title: 'Connect web search',
  canSkip: true,
  isApplicable: () => true,

  render(container, _ctx, actions) {
    if (currentContext !== _ctx) {
      resetApiKeysStepState();
      currentContext = _ctx;
      const savedProvider = _ctx.state.steps['api-keys']?.data?.provider;
      if (typeof savedProvider === 'string' && ['tavily', 'brave', 'duckduckgo', 'searxng', 'disabled'].includes(savedProvider)) {
        provider = savedProvider as SearchProvider;
      }
    }
    container.innerHTML = '';
    container.className = 'mn-onboarding-step';
    const generation = ++loadGeneration;
    let edited = false;
    renderStepHeader(container, apiKeysStep, actions.stepIndex, actions.totalSteps);
    if (!_ctx.configServerAvailable) {
      container.appendChild(el('p', 'mn-onboarding-notice', 'Connect a search provider when Minnow is running locally. You can continue setup now.'));
      actions.setPrimaryLabel('Continue');
      actions.setPrimaryEnabled(true);
      return;
    }

    container.appendChild(
      el(
        'p',
        'mn-onboarding-step-desc',
        'Give your agents access to current information, documentation, and sources. Tavily is recommended for a quick start.',
      ),
    );

    const chipRow = el('div', 'mn-onboarding-chip-row');
    (
      [
        ['tavily', 'Tavily · Recommended'],
        ['brave', 'Brave'],
        ['duckduckgo', 'DuckDuckGo'],
        ['searxng', 'SearXNG'],
        ['disabled', 'Off'],
      ] as const
    ).forEach(([id, label]) => {
      const chip = el('button', 'mn-onboarding-wallpaper-chip', label);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(provider === id));
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
      const guide = el('div', 'mn-onboarding-search-guide');
      guide.appendChild(el('h3', 'mn-onboarding-subtitle', 'Get your free Tavily key'));
      const instructions = el('ol', 'mn-onboarding-search-guide__steps');
      const first = el('li');
      first.append('Create a free account at ');
      const signup = el('a', 'mn-onboarding-settings-link', 'tavily.com');
      signup.href = 'https://www.tavily.com/';
      signup.target = '_blank';
      signup.rel = 'noopener noreferrer';
      first.append(signup, '.');
      const second = el('li');
      second.append('Open your ');
      const dashboard = el('a', 'mn-onboarding-settings-link', 'Tavily dashboard');
      dashboard.href = 'https://app.tavily.com/';
      dashboard.target = '_blank';
      dashboard.rel = 'noopener noreferrer';
      second.append(dashboard, ' and copy an API key.');
      instructions.append(first, second, el('li', undefined, 'Paste the key below and choose Save and continue.'));
      guide.append(instructions, el('p', 'mn-onboarding-muted', 'The free plan includes 1,000 API credits each month. No credit card required.'));
      keysWrap.appendChild(guide);
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
    } else if (provider === 'searxng') {
      keysWrap.appendChild(el('p', 'mn-onboarding-muted', 'Connect an existing SearXNG instance, or select its optional local install on the next step.'));
      const wrap = el('label', 'mn-onboarding-field-label', 'SearXNG URL');
      const input = el('input', 'mn-onboarding-field');
      input.type = 'url';
      input.value = searxngUrl;
      input.addEventListener('input', () => {
        edited = true;
        searxngUrl = input.value.trim();
        actions.setPrimaryEnabled(Boolean(searxngUrl));
      });
      wrap.appendChild(input);
      keysWrap.appendChild(wrap);
    } else if (provider === 'disabled') {
      keysWrap.appendChild(el('p', 'mn-onboarding-muted', 'Agents will work without web search. You can connect a search provider later.'));
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
      if (provider === 'searxng' && !edited) searxngUrl = config.searxngUrl || searxngUrl;
      if (input && !edited) input.value = provider === 'searxng' ? searxngUrl : provider === 'brave' ? braveKey : tavilyKey;
      actions.setPrimaryEnabled(canContinue());
    });

    actions.setPrimaryLabel('Save and continue');
    actions.setPrimaryEnabled(canContinue());
    return () => { loadGeneration += 1; };
  },

  async commit(ctx) {
    if (!ctx.configServerAvailable) {
      ctx.state = recordStepProgress(ctx.state, 'api-keys', { done: false, skipped: true });
      return;
    }
    const config = await loadSearchConfig();
    await saveSearchConfig({
      ...config,
      provider,
      searxngUrl: provider === 'searxng' ? searxngUrl : config.searxngUrl,
      keys: {
        ...config.keys,
        ...(provider === 'brave' ? { braveApiKey: braveKey } : {}),
        ...(provider === 'tavily' ? { tavilyApiKey: tavilyKey } : {}),
      },
    });
    ctx.state = recordStepProgress(ctx.state, 'api-keys', {
      done: true,
      data: { provider },
    });
  },
};

export function resetApiKeysStepState(): void {
  currentContext = null;
  braveKey = '';
  tavilyKey = '';
  provider = 'tavily';
  searxngUrl = 'http://localhost:8899';
  keysLoaded = false;
  loadGeneration += 1;
}

function canContinue(): boolean {
  return provider === 'duckduckgo' || provider === 'disabled' ||
    (provider === 'searxng' ? Boolean(searxngUrl) : Boolean(provider === 'brave' ? braveKey : tavilyKey));
}
