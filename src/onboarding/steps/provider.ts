/**
 * S2 — Provider path choice and branch screens (local / managed / cloud).
 */

import {
  createProvider,
  updateProvider,
  updateProviderSecrets,
  listProviders,
  type CreateProviderPayload,
} from '../../providers/store';
import type { ProviderPublic } from '../../providers/types';
import { getDefaultPaths } from '../../providers/paths';
import { fetchModelsForProvider } from '../../providers/fetch-models';
import { createChoiceCard, createStatusPill, el, renderStepHeader } from '../ui-helpers';
import {
  firstReachableProbe,
  probeLocalProviders,
  type ProviderProbeResult,
} from '../provider-probe';
import { ONBOARDING_CLOUD_PRESETS } from '../../providers/presets';
import type { OnboardingContext, OnboardingStep, OnboardingStepActions } from '../types';
import {
  listConfiguredOnboardingCloudPresetIds,
  onboardingCloudProviderId,
  recordStepProgress,
} from '../state-core';

let selectedPath: OnboardingContext['providerPath'] = null;
let probeResults: ProviderProbeResult[] = [];
let localProviderId = '';
let localBaseUrl = '';
let cloudPreset = 'openrouter';
let cloudBaseUrl = 'https://openrouter.ai/api';
let cloudApiKey = '';
let connectionStatus: 'idle' | 'ok' | 'err' = 'idle';
let connectionError = '';
/** Preset chip ids the user has already tested and saved during this wizard session. */
const configuredCloudPresets = new Set<string>();
let cloudProviderLoadGen = 0;
let connectionGen = 0;

function choosePath(path: OnboardingContext['providerPath'], actions: OnboardingStepActions): void {
  selectedPath = path;
  connectionGen += 1;
  connectionStatus = 'idle';
  connectionError = '';
  localProviderId = '';
  actions.patchContext({ providerPath: path, providerId: null, modelId: null });
  actions.next();
}

export const providerChoiceStep: OnboardingStep = {
  id: 'provider-choice',
  title: 'How will you run models?',
  canSkip: true,

  isApplicable() {
    return true;
  },

  render(container, ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step';
    selectedPath = ctx.providerPath;

    renderStepHeader(container, providerChoiceStep, actions.stepIndex, actions.totalSteps);
    container.appendChild(
      el(
        'p',
        'mn-onboarding-step-desc',
        'Pick one path. You can add more providers later in Settings.',
      ),
    );

    const grid = el('div', 'mn-onboarding-choice-grid');
    const detected = probeResults.find((p) => p.reachable);
    const detectBadge = detected ? `${detected.label} detected` : undefined;

    grid.appendChild(
      createChoiceCard({
        title: 'I already run a local server',
        description: 'LM Studio, Ollama, or llama.cpp on this machine.',
        badge: detectBadge,
        selected: selectedPath === 'local',
        onSelect: () => {
          choosePath('local', actions);
        },
      }),
    );

    grid.appendChild(
      createChoiceCard({
        title: 'Let Minnow run models for me',
        description: 'Hardware-aware download and serve (requires Minnow running locally).',
        recommended: ctx.serverAvailable && !detected,
        selected: selectedPath === 'managed',
        onSelect: () => {
          choosePath('managed', actions);
        },
      }),
    );

    grid.appendChild(
      createChoiceCard({
        title: 'Use a cloud API',
        description: 'OpenAI-compatible hosted models with an API key.',
        selected: selectedPath === 'cloud',
        onSelect: () => {
          choosePath('cloud', actions);
        },
      }),
    );

    container.appendChild(grid);
    actions.setPrimaryEnabled(false);
    actions.setPrimaryLabel('Continue');
  },

  async commit(ctx) {
    ctx.state = recordStepProgress(ctx.state, 'provider-choice', {
      done: Boolean(selectedPath),
      data: { path: selectedPath },
    });
  },
};

export const providerLocalStep: OnboardingStep = {
  id: 'provider-local',
  title: 'Local server',
  canSkip: true,

  isApplicable(ctx) {
    return ctx.providerPath === 'local';
  },

  render(container, ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step';

    const hit = firstReachableProbe(probeResults);
    renderStepHeader(container, providerLocalStep, actions.stepIndex, actions.totalSteps);
    container.appendChild(
      el(
        'p',
        'mn-onboarding-step-desc',
        hit
          ? `We found ${hit.label} at ${hit.baseUrl}. Confirm to register it.`
          : 'No server detected on common ports. Enter your base URL below.',
      ),
    );

    const statusRow = el('div', 'mn-onboarding-status-row');
    const status = createStatusPill(
      connectionStatus === 'ok' ? 'ok' : connectionStatus === 'err' ? 'err' : 'pending',
      connectionStatus === 'ok'
        ? 'Reachable'
        : connectionStatus === 'err'
          ? connectionError || 'Unreachable'
          : 'Not tested',
    );
    statusRow.appendChild(status);
    container.appendChild(statusRow);

    if (!localBaseUrl) {
      localBaseUrl = hit?.baseUrl ?? 'http://localhost:1234';
    }

    const urlInput = el('input', 'mn-onboarding-field') as HTMLInputElement;
    urlInput.type = 'url';
    urlInput.placeholder = 'http://localhost:1234';
    urlInput.value = localBaseUrl;
    urlInput.autocomplete = 'off';
    urlInput.setAttribute('aria-label', 'Local server base URL');
    urlInput.addEventListener('input', () => {
      localBaseUrl = urlInput.value.trim();
      connectionGen += 1;
      connectionStatus = 'idle';
      localProviderId = '';
      status.textContent = 'Not tested';
      status.className = 'mn-onboarding-status mn-onboarding-status--pending';
      actions.setPrimaryEnabled(false);
    });
    container.appendChild(urlInput);

    const testBtn = el('button', 'mn-onboarding-secondary-btn', 'Test connection');
    testBtn.type = 'button';
    testBtn.addEventListener('click', () => {
      localBaseUrl = urlInput.value.trim();
      testBtn.disabled = true;
      void testLocalConnection(localBaseUrl, actions, container, ctx).finally(() => { testBtn.disabled = false; });
    });
    container.appendChild(testBtn);

    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(connectionStatus === 'ok');

    if (hit && connectionStatus === 'idle') {
      void testLocalConnection(localBaseUrl, actions, container, ctx);
    }
    const view = container.firstElementChild;
    return () => { if (container.firstElementChild === view) connectionGen += 1; };
  },

  async commit(ctx) {
    if (!localProviderId) return;
    ctx.state = recordStepProgress(ctx.state, 'provider-local', {
      done: true,
      data: { path: 'local', providerId: localProviderId },
    });
    ctx.providerId = localProviderId;
  },
};

export { providerManagedStep } from './managed';

export const providerCloudStep: OnboardingStep = {
  id: 'provider-cloud',
  title: 'Cloud API',
  canSkip: true,

  isApplicable(ctx) {
    return ctx.providerPath === 'cloud';
  },

  render(container, ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step';

    renderStepHeader(container, providerCloudStep, actions.stepIndex, actions.totalSteps);
    container.appendChild(
      el('p', 'mn-onboarding-step-desc', 'Keys are stored encrypted on this machine only.'),
    );

    const presetRow = el('div', 'mn-onboarding-chip-row');
    ONBOARDING_CLOUD_PRESETS.forEach((preset) => {
      const chip = createCloudPresetChip(preset, configuredCloudPresets.has(preset.id), () => {
        connectionGen += 1;
        cloudPreset = preset.id;
        cloudApiKey = '';
        if (preset.baseUrl) cloudBaseUrl = preset.baseUrl;
        connectionError = '';
        if (configuredCloudPresets.has(preset.id)) {
          connectionStatus = 'ok';
          localProviderId = onboardingCloudProviderId(preset.id);
        } else {
          connectionStatus = 'idle';
          localProviderId = '';
          actions.setPrimaryEnabled(false);
        }
        rerenderCloud(container, ctx, actions);
      });
      if (preset.id === cloudPreset) chip.classList.add('is-selected');
      presetRow.appendChild(chip);
    });
    container.appendChild(presetRow);

    void refreshConfiguredCloudPresets(container, ctx, actions);

    const selectedPreset = ONBOARDING_CLOUD_PRESETS.find((preset) => preset.id === cloudPreset);
    if (selectedPreset?.authHint) {
      container.appendChild(el('p', 'mn-onboarding-muted', selectedPreset.authHint));
    }

    const urlInput = el('input', 'mn-onboarding-field') as HTMLInputElement;
    urlInput.type = 'url';
    urlInput.placeholder = 'https://api.example.com';
    urlInput.value = cloudBaseUrl;
    urlInput.disabled = cloudPreset !== 'custom';
    urlInput.setAttribute('aria-label', 'Cloud provider base URL');
    container.appendChild(urlInput);

    const keyInput = el('input', 'mn-onboarding-field') as HTMLInputElement;
    keyInput.type = 'password';
    keyInput.placeholder = 'API key';
    keyInput.autocomplete = 'off';
    keyInput.setAttribute('aria-label', 'Cloud provider API key');
    const invalidate = () => {
      connectionGen += 1;
      connectionStatus = 'idle';
      localProviderId = '';
      actions.setPrimaryEnabled(false);
    };
    urlInput.addEventListener('input', invalidate);
    keyInput.addEventListener('input', invalidate);
    container.appendChild(keyInput);

    const testBtn = el('button', 'mn-onboarding-secondary-btn', 'Test and save');
    testBtn.type = 'button';
    testBtn.addEventListener('click', () => {
      cloudBaseUrl = urlInput.value.trim();
      cloudApiKey = keyInput.value.trim();
      testBtn.disabled = true;
      void testCloudConnection(actions, container, ctx).finally(() => { testBtn.disabled = false; });
    });
    container.appendChild(testBtn);

    const statusRow = el('div', 'mn-onboarding-status-row');
    statusRow.appendChild(
      createStatusPill(
        connectionStatus === 'ok' ? 'ok' : connectionStatus === 'err' ? 'err' : 'pending',
        connectionStatus === 'ok'
          ? 'Connected'
          : connectionStatus === 'err'
            ? connectionError
            : 'Not tested',
      ),
    );
    container.appendChild(statusRow);

    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(
      connectionStatus === 'ok' && localProviderId === onboardingCloudProviderId(cloudPreset),
    );
    const view = container.firstElementChild;
    return () => { if (container.firstElementChild === view) connectionGen += 1; };
  },

  async commit(ctx) {
    if (!localProviderId) return;
    ctx.state = recordStepProgress(ctx.state, 'provider-cloud', {
      done: true,
      data: { path: 'cloud', providerId: localProviderId },
    });
    ctx.providerId = localProviderId;
  },
};

function rerenderLocal(
  container: HTMLElement,
  ctx: OnboardingContext,
  actions: OnboardingStepActions,
): void {
  providerLocalStep.render(container, ctx, actions);
}

function rerenderCloud(
  container: HTMLElement,
  ctx: OnboardingContext,
  actions: OnboardingStepActions,
): void {
  providerCloudStep.render(container, ctx, actions);
}

/** Cloud preset chip with an optional saved-key confirmation mark. */
function createCloudPresetChip(
  preset: (typeof ONBOARDING_CLOUD_PRESETS)[number],
  isConfigured: boolean,
  onSelect: () => void,
): HTMLButtonElement {
  const chip = el('button', 'mn-onboarding-wallpaper-chip');
  chip.type = 'button';
  if (preset.authHint) chip.title = preset.authHint;
  if (isConfigured) chip.classList.add('is-added');

  const label = el('span', 'mn-onboarding-wallpaper-chip__label', preset.label);
  chip.appendChild(label);

  if (isConfigured) {
    const check = el('span', 'mn-onboarding-wallpaper-chip__check', '✓');
    check.setAttribute('aria-hidden', 'true');
    chip.appendChild(check);
    chip.setAttribute('aria-label', `${preset.label}, added`);
  }

  chip.addEventListener('click', onSelect);
  return chip;
}

/** Merge saved onboarding cloud providers from the registry into chip state. */
async function refreshConfiguredCloudPresets(
  container: HTMLElement,
  ctx: OnboardingContext,
  actions: OnboardingStepActions,
): Promise<void> {
  const gen = ++cloudProviderLoadGen;
  const view = container.firstElementChild;
  const connection = connectionGen;
  try {
    const { providers } = await listProviders();
    if (gen !== cloudProviderLoadGen || !container.isConnected || container.firstElementChild !== view || connection !== connectionGen) return;
    const beforeSize = configuredCloudPresets.size;
    for (const presetId of listConfiguredOnboardingCloudPresetIds(providers)) {
      configuredCloudPresets.add(presetId);
    }
    if (configuredCloudPresets.has(cloudPreset) && connectionStatus !== 'err') {
      connectionStatus = 'ok';
      localProviderId = onboardingCloudProviderId(cloudPreset);
      actions.setPrimaryEnabled(true);
    }
    if (configuredCloudPresets.size === beforeSize) return;
    rerenderCloud(container, ctx, actions);
  } catch {}
}

/** Create provider or update when npm start already seeded the same id. */
async function ensureOnboardingProvider(
  payload: CreateProviderPayload,
): Promise<{ ok: true; provider: ProviderPublic } | { ok: false; error: string }> {
  const created = await createProvider(payload);
  if (created.ok === false) {
    if (!created.error.includes('already exists')) {
      return created;
    }
    return updateProvider(payload.id, {
      label: payload.label,
      baseUrl: payload.baseUrl,
      apiKind: payload.apiKind,
      authStyle: payload.authStyle,
      enabled: payload.enabled,
      modelsPath: payload.modelsPath,
      chatCompletionsPath: payload.chatCompletionsPath,
      messagesPath: payload.messagesPath,
      autoApi: payload.autoApi,
    });
  }
  return created;
}

async function testLocalConnection(
  baseUrl: string,
  actions: OnboardingStepActions,
  container?: HTMLElement,
  ctx?: OnboardingContext,
): Promise<void> {
  const gen = ++connectionGen;
  const view = container?.firstElementChild;
  const current = () => gen === connectionGen && (!container || container.isConnected && container.firstElementChild === view);
  connectionStatus = 'idle';
  connectionError = '';
  localBaseUrl = baseUrl;
  actions.setPrimaryEnabled(false);
  const match =
    probeResults.find((p) => p.baseUrl === baseUrl) ??
    ({
      id: `onboarding-local-${Date.now()}`,
      label: 'Local server',
      baseUrl,
      apiKind: baseUrl.includes('1234') ? 'lm-studio-v0' : 'openai-v1',
      reachable: false,
    } as ProviderProbeResult);

  const paths = getDefaultPaths(match.apiKind);
  try {
    const result = await ensureOnboardingProvider({
      id: match.id,
      label: match.label,
      baseUrl,
      apiKind: match.apiKind,
      enabled: true,
      modelsPath: paths.modelsPath,
      chatCompletionsPath: paths.chatCompletionsPath,
    });
    if (!current()) return;

    if (result.ok === false) {
      connectionStatus = 'err';
      connectionError = result.error;
      actions.setPrimaryEnabled(false);
      if (container && ctx) rerenderLocal(container, ctx, actions);
      return;
    }

    await fetchModelsForProvider(result.provider, new AbortController().signal);
    if (!current()) return;
    connectionStatus = 'ok';
    localProviderId = result.provider.id;
    actions.setPrimaryEnabled(true);
  } catch (err) {
    if (!current()) return;
    connectionStatus = 'err';
    connectionError = err instanceof Error ? err.message : 'Connection failed';
    actions.setPrimaryEnabled(false);
  }
  if (container && ctx) rerenderLocal(container, ctx, actions);
}

async function testCloudConnection(
  actions: OnboardingStepActions,
  container?: HTMLElement,
  ctx?: OnboardingContext,
): Promise<void> {
  const gen = ++connectionGen;
  const view = container?.firstElementChild;
  const current = () => gen === connectionGen && (!container || container.isConnected && container.firstElementChild === view);
  if (!cloudBaseUrl || !cloudApiKey) {
    connectionStatus = 'err';
    connectionError = 'Base URL and API key required';
    actions.setPrimaryEnabled(false);
    if (container && ctx) rerenderCloud(container, ctx, actions);
    return;
  }

  const preset = ONBOARDING_CLOUD_PRESETS.find((p) => p.id === cloudPreset);
  const presetId = cloudPreset;
  const apiKey = cloudApiKey;
  cloudApiKey = '';
  connectionStatus = 'idle';
  actions.setPrimaryEnabled(false);
  const apiKind = preset?.apiKind ?? 'openai-v1';
  const paths = getDefaultPaths(apiKind);
  const id = onboardingCloudProviderId(cloudPreset);
  try {
    const result = await ensureOnboardingProvider({
      id,
      label: preset?.label ?? 'Cloud',
      baseUrl: cloudBaseUrl,
      apiKind,
      authStyle: preset?.authStyle ?? 'bearer',
      autoApi: preset?.autoApi,
      enabled: true,
      modelsPath: paths.modelsPath,
      chatCompletionsPath: paths.chatCompletionsPath,
      messagesPath: paths.messagesPath,
    });
    if (!current()) return;

    if (result.ok === false) {
      connectionStatus = 'err';
      connectionError = result.error;
      actions.setPrimaryEnabled(false);
      if (container && ctx) rerenderCloud(container, ctx, actions);
      return;
    }

    const keyRes = await updateProviderSecrets(id, { apiKey });
    if (!current()) return;
    if (keyRes.ok === false) {
      connectionStatus = 'err';
      connectionError = keyRes.error;
      actions.setPrimaryEnabled(false);
      if (container && ctx) rerenderCloud(container, ctx, actions);
      return;
    }

    await fetchModelsForProvider(result.provider, new AbortController().signal);
    if (!current()) return;
    connectionStatus = 'ok';
    localProviderId = id;
    configuredCloudPresets.add(presetId);
    actions.setPrimaryEnabled(true);
  } catch (err) {
    if (!current()) return;
    connectionStatus = 'err';
    connectionError = err instanceof Error ? err.message : 'Connection failed';
    actions.setPrimaryEnabled(false);
  }
  if (container && ctx) rerenderCloud(container, ctx, actions);
}

/** Warm probe cache before provider-choice renders. */
export async function warmProviderProbes(): Promise<void> {
  connectionGen += 1;
  connectionStatus = 'idle';
  connectionError = '';
  localProviderId = '';
  localBaseUrl = '';
  cloudApiKey = '';
  configuredCloudPresets.clear();
  probeResults = await probeLocalProviders();
}
