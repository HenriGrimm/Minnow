import { loadImageGenerationConfig, saveImageGenerationConfig } from '../config/image-generation-meta';
import { listProviders } from '../providers/store';
import { getWorkspacePath } from '../state/workspace';
import { appendSettingsGroup, linkToSettingsSection } from './settings-layout';
import { createSettingsInputRow, createSettingsSelectRow } from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';

export async function renderImageGenerationSettings(mount: HTMLElement): Promise<void> {
  const body = appendSettingsGroup(mount, 'Image generation', 'Generate workspace assets with a separate image provider. Provider charges may apply.', 'models.routing.imageGeneration');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Loading image settings…';
  body.append(status);
  try {
    let saved = await loadImageGenerationConfig();
    const { providers } = await listProviders();
    const enabled = createSettingsToggleRow('Enable image generation', { checked: saved.enabled });
    const provider = createSettingsSelectRow('Provider', { value: saved.providerId, options: [{ value: '', label: 'Choose provider' }, ...providers.filter(p => p.enabled && p.apiKind !== 'agent-cli-v1').map(p => ({ value: p.id, label: p.label }))] });
    const adapter = createSettingsSelectRow('Image adapter', { value: saved.adapterId, options: [{ value: '', label: 'Choose adapter' }, { value: 'openai', label: 'OpenAI Images' }, { value: 'openrouter', label: 'OpenRouter Images' }] });
    const model = createSettingsInputRow('Image model ID', { value: saved.modelId, description: 'Use a model available to this provider. Check connection verifies metadata without generating.' });
    const modelList = document.createElement('datalist');
    modelList.id = `image-models-${crypto.randomUUID()}`;
    model.input.setAttribute('list', modelList.id);
    body.append(modelList);
    const defaults = document.createElement('div');
    const controls = document.createElement('div');
    controls.className = 'settings-row';
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'settings-btn'; save.textContent = 'Save';
    const check = document.createElement('button');
    check.type = 'button'; check.className = 'settings-btn'; check.textContent = 'Check connection';
    const test = document.createElement('button');
    test.type = 'button'; test.className = 'settings-btn'; test.textContent = 'Generate test image…';
    controls.append(save, check, test);
    body.append(enabled.row, provider.row, adapter.row, model.row, defaults, linkToSettingsSection('Manage provider credentials', 'providers'), controls);
    status.textContent = saved.enabled ? 'Verification required' : 'Not configured';
    let busy = false;
    let dirty = false;
    const update = (): void => {
      save.disabled = busy; check.disabled = busy || dirty || !saved.enabled; test.disabled = busy || dirty || !saved.enabled;
      for (const input of [enabled.input, provider.select, adapter.select, model.input, ...values.values()]) input.disabled = busy;
    };
    const changed = (): void => { dirty = true; status.textContent = 'Unsaved changes'; update(); };
    for (const input of [enabled.input, provider.select, adapter.select, model.input]) input.addEventListener('change', changed);
    const values = new Map<string, HTMLSelectElement>();
    save.addEventListener('click', async () => {
      busy = true; update();
      try {
        const bindingChanged = saved.providerId !== provider.select.value || saved.adapterId !== adapter.select.value || saved.modelId !== model.input.value;
        const next = { ...saved, enabled: enabled.input.checked, providerId: provider.select.value, adapterId: adapter.select.value, modelId: model.input.value, defaults: bindingChanged ? {} : values.size ? Object.fromEntries([...values].filter(([, control]) => control.value).map(([key, control]) => [key, control.value])) : saved.defaults };
        await saveImageGenerationConfig(next);
        if (bindingChanged) { values.clear(); defaults.replaceChildren(); }
        saved = next; dirty = false; status.textContent = 'Saved. Check connection to verify capabilities.';
      } catch (error) { status.textContent = String(error); save.textContent = 'Retry save'; }
      finally { busy = false; update(); }
    });
    check.addEventListener('click', async () => {
      busy = true; update(); status.textContent = 'Checking metadata…';
      try {
        const { executeTool } = await import('../tools/client');
        const result = await executeTool('image_generation_info', { check_connection: true });
        const info = JSON.parse(result.content);
        modelList.replaceChildren();
        for (const item of info.models ?? []) {
          const option = document.createElement('option'); option.value = item.id; modelList.append(option);
        }
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
  } catch { status.textContent = 'Image settings unavailable. Reopen this page to retry.'; }
}
