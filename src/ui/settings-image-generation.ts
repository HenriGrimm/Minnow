import { loadImageGenerationConfig, saveImageGenerationConfig } from '../config/image-generation-meta';
import { listProviders } from '../providers/store';
import type { ProviderPublic } from '../providers/types';
import { getWorkspacePath } from '../state/workspace';
import { appendSettingsGroup, linkToSettingsSection } from './settings-layout';
import { createSettingsActionsRow, createSettingsInputRow, createSettingsSelectRow } from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';

function supportedImageAdapter(provider: ProviderPublic): 'openai' | 'openrouter' | null {
  if (!provider.enabled || provider.apiKind !== 'openai-v1') return null;
  try {
    const url = new URL(provider.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (url.hostname === 'api.openai.com') return 'openai';
    if (url.hostname === 'openrouter.ai') return 'openrouter';
  } catch { /* Invalid connections cannot generate images. */ }
  return null;
}

export async function renderImageGenerationSettings(mount: HTMLElement): Promise<void> {
  const body = appendSettingsGroup(mount, 'Image generation', 'Generate workspace assets with a separate image provider. Provider charges may apply.', 'models.routing.imageGeneration');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Loading image settings…';
  body.append(status);
  try {
    let saved = await loadImageGenerationConfig();
    const { providers } = await listProviders();
    const supportedProviders = providers.filter(p => supportedImageAdapter(p));
    const enabled = createSettingsToggleRow('Enable image generation', { checked: saved.enabled });
    const provider = createSettingsSelectRow('Provider', { value: saved.providerId, description: 'Enabled OpenAI and OpenRouter API connections.', options: [{ value: '', label: 'Choose provider' }, ...supportedProviders.map(p => ({ value: p.id, label: p.label }))] });
    provider.select.value ||= '';
    const adapter = createSettingsSelectRow('Image adapter', { description: 'Selected automatically for this provider.' });
    const selectAdapter = (): void => {
      const connection = supportedProviders.find(p => p.id === provider.select.value);
      const id = connection ? supportedImageAdapter(connection) : null;
      const option = document.createElement('option');
      option.value = id ?? ''; option.textContent = id === 'openai' ? 'OpenAI Images' : id === 'openrouter' ? 'OpenRouter Images' : 'Choose provider first';
      adapter.select.replaceChildren(option); adapter.select.value = id ?? '';
    };
    selectAdapter();
    const customModelValue = '__custom_image_model__';
    const model = createSettingsSelectRow('Image model', { description: 'Choose a model from this provider. Save and check connection to verify its options.' });
    const customModel = createSettingsInputRow('Custom model ID', { value: saved.modelId, description: 'Use an exact model ID supported by the selected provider and adapter.', spellcheck: false });
    const modelStatus = document.createElement('p');
    modelStatus.setAttribute('role', 'status');
    const modelActions = createSettingsActionsRow([{ label: 'Refresh models' }]);
    const refresh = modelActions.querySelector<HTMLButtonElement>('button')!;
    const defaults = document.createElement('div');
    const controls = createSettingsActionsRow([
      { label: 'Save', variant: 'primary' },
      { label: 'Check connection' },
      { label: 'Generate test image…' },
    ]);
    const [save, check, test] = controls.querySelectorAll<HTMLButtonElement>('button');
    controls.append(linkToSettingsSection('Manage provider credentials', 'providers'));
    body.append(enabled.row, provider.row, adapter.row, model.row, customModel.row, modelStatus, modelActions, defaults, controls);
    const unavailableSavedProvider = !!saved.providerId && !provider.select.value;
    status.textContent = unavailableSavedProvider ? 'Saved image provider is unsupported or disabled. Choose an OpenAI or OpenRouter connection.' : saved.enabled ? 'Verification required' : 'Not configured';
    let busy = false;
    let dirty = !!provider.select.value && adapter.select.value !== saved.adapterId;
    if (dirty) status.textContent = 'Image adapter updated. Save to use this connection.';
    let loadingModels = false;
    let discoveryVersion = 0;
    let discoveryController: AbortController | undefined;
    const modelId = (): string => model.select.value === customModelValue ? customModel.input.value.trim() : model.select.value;
    const populateModels = (models: { id: string }[], selected: string): void => {
      model.select.replaceChildren();
      const options = [{ value: '', label: 'Choose image model' }, ...models.map(item => ({ value: item.id, label: item.id }))];
      if (selected && selected !== customModelValue && !models.some(item => item.id === selected)) options.push({ value: selected, label: `${selected} (not listed)` });
      options.push({ value: customModelValue, label: 'Enter model ID manually…' });
      for (const item of options) {
        const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; model.select.append(option);
      }
      model.select.value = selected;
      customModel.row.hidden = selected !== customModelValue;
    };
    populateModels([], saved.modelId);
    const values = new Map<string, HTMLSelectElement>();
    const update = (): void => {
      save.disabled = busy || (enabled.input.checked && !provider.select.value);
      check.disabled = busy || dirty || !saved.enabled || !provider.select.value; test.disabled = check.disabled;
      refresh.disabled = busy || loadingModels || !provider.select.value || !adapter.select.value;
      refresh.textContent = loadingModels ? 'Refreshing models…' : 'Refresh models';
      for (const input of [enabled.input, provider.select, customModel.input, ...values.values()]) input.disabled = busy;
      adapter.select.disabled = true;
      model.select.disabled = busy || loadingModels || !provider.select.value || !adapter.select.value;
    };
    const changed = (): void => { dirty = true; status.textContent = 'Unsaved changes'; update(); };
    const discoverModels = async (): Promise<void> => {
      const version = ++discoveryVersion;
      discoveryController?.abort();
      discoveryController = new AbortController();
      if (!provider.select.value || !adapter.select.value) {
        loadingModels = false; modelStatus.textContent = supportedProviders.length ? 'Choose an OpenAI or OpenRouter connection to load image models.' : 'Add and enable an OpenAI or OpenRouter API connection in Providers to load image models.'; update(); return;
      }
      loadingModels = true; modelStatus.textContent = 'Loading available image models…'; update();
      try {
        const { executeTool } = await import('../tools/client');
        if (version !== discoveryVersion) return;
        const result = await executeTool('image_generation_info', { list_models: true, provider_id: provider.select.value, adapter_id: adapter.select.value }, { signal: discoveryController.signal });
        if (version !== discoveryVersion) return;
        const info = JSON.parse(result.content);
        if (info.status !== 'Available') throw new Error('Model discovery unavailable');
        populateModels(info.models ?? [], model.select.value);
        modelStatus.textContent = info.models?.length ? 'Models loaded. Select one to finish setup.' : 'No supported image models found. Try another provider or adapter, or enter a model ID manually.';
      } catch {
        if (version !== discoveryVersion) return;
        modelStatus.textContent = 'Could not load image models. Check provider credentials and the image adapter, then refresh or enter a model ID manually.';
      } finally {
        if (version === discoveryVersion) { loadingModels = false; update(); }
      }
    };
    enabled.input.addEventListener('change', changed);
    model.select.addEventListener('change', () => { customModel.row.hidden = model.select.value !== customModelValue; changed(); });
    customModel.input.addEventListener('input', changed);
    customModel.input.addEventListener('change', changed);
    provider.select.addEventListener('change', () => {
      selectAdapter();
      populateModels([], ''); customModel.input.value = ''; values.clear(); defaults.replaceChildren(); changed(); void discoverModels();
    });
    refresh.addEventListener('click', () => { void discoverModels(); });
    save.addEventListener('click', async () => {
      busy = true; update();
      try {
        const bindingChanged = saved.providerId !== provider.select.value || saved.adapterId !== adapter.select.value || saved.modelId !== modelId();
        const next = { ...saved, enabled: enabled.input.checked, providerId: provider.select.value, adapterId: adapter.select.value, modelId: modelId(), defaults: bindingChanged ? {} : values.size ? Object.fromEntries([...values].filter(([, control]) => control.value).map(([key, control]) => [key, control.value])) : saved.defaults };
        await saveImageGenerationConfig(next);
        if (bindingChanged) { values.clear(); defaults.replaceChildren(); }
        saved = next; dirty = false; save.textContent = 'Save'; status.textContent = 'Saved. Check connection to verify capabilities.';
      } catch (error) { status.textContent = String(error); save.textContent = 'Retry save'; }
      finally { busy = false; update(); }
    });
    check.addEventListener('click', async () => {
      busy = true; update(); status.textContent = 'Checking metadata…';
      try {
        const { executeTool } = await import('../tools/client');
        const result = await executeTool('image_generation_info', { check_connection: true });
        const info = JSON.parse(result.content);
        status.textContent = info.status === 'Ready' ? 'Ready. No image was generated.' : info.error ?? info.status;
        defaults.replaceChildren(); values.clear();
        for (const [key, options] of Object.entries(info.capabilities?.options ?? {})) {
          const field = createSettingsSelectRow(key.replace('_', ' '), { value: saved.defaults[key as keyof typeof saved.defaults] ?? '', options: [{ value: '', label: 'Provider default' }, ...(options as string[]).map(value => ({ value, label: value }))] });
          values.set(key, field.select); field.select.addEventListener('change', changed); defaults.append(field.row);
        }
      } catch { status.textContent = 'Could not verify image capabilities. Check provider credentials and retry.'; }
      finally { busy = false; update(); }
    });
    test.addEventListener('click', async () => {
      busy = true; update(); status.textContent = 'Waiting for image tool…';
      try {
        const { executeTool } = await import('../tools/client');
        const result = await executeTool('generate_image', { prompt: 'A small blue fish on a plain background, simple illustration.' }, { modeId: 'build', workspaceRoot: getWorkspacePath(), toolCallId: crypto.randomUUID() });
        status.textContent = result.content;
      } catch { status.textContent = 'Test image did not complete. Inspect the image job before generating again.'; }
      finally { busy = false; update(); }
    });
    update();
    void discoverModels();
  } catch { status.textContent = 'Image settings unavailable. Reopen this page to retry.'; }
}
