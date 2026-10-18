import { runSettingsAction } from './settings-controls';
import { showToast } from './toast';
import {
  activateSetupProfile,
  captureSetupProfile,
  deleteSetupProfile,
  duplicateSetupProfile,
  exportSetupProfileFile,
  fetchActiveSetupProfileId,
  importSetupProfile,
  isProfilesServerAvailable,
  listSetupProfiles,
  saveWorkspaceProfileAutoApply,
  setWorkspaceSetupProfileDefault,
} from '../config/profiles-client';
import type { MinnowProfileBundle, ProfileListItem } from '../config/profile-types';
import { getWorkspacePath } from '../state/workspace';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { refreshSettingsSection } from './settings-sections';
import { schedulePromptTokenEstimateRefresh } from './settings-prompt-estimate';
import { createSettingsToggleRow } from './settings-switch';
import { appConfirm, appPrompt } from './app-dialog';

type StatusFn = (kind: 'idle' | 'ok' | 'err', message: string) => void;

let profilesBound = false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function refreshProfileSelect(
  select: HTMLSelectElement,
  activeId: string | null,
): Promise<void> {
  const items = await listSetupProfiles();
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = items.length ? 'Select setup profile…' : 'No setup profiles yet';
  select.appendChild(placeholder);
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.label;
    select.appendChild(opt);
  }
  if (activeId) select.value = activeId;
}

function summarizeActivateImpact(bundle: MinnowProfileBundle): string {
  const workCount = Object.keys(bundle.agents?.workAgents ?? {}).length;
  const subTypes = Object.keys(
    (bundle.agents?.subAgents as { types?: Record<string, unknown> } | undefined)?.types ?? {},
  ).length;
  const toolCount = Object.keys(bundle.tools?.permissions ?? {}).length;
  return [
    `Prompt profile: ${bundle.prompt.promptProfile}`,
    `Tool permissions: ${toolCount} entries`,
    `Work agent overrides: ${workCount}`,
    `Sub-agent type overrides: ${subTypes}`,
  ].join('\n');
}

/**
 * Mount setup profile controls into the Prompting settings section.
 */
export function mountSetupProfilesPanel(
  container: HTMLElement,
  setStatus: StatusFn,
): void {
  if (profilesBound) return;
  profilesBound = true;

  const block = el('div', 'settings-setup-profiles');
  block.appendChild(
    el(
      'p',
      'settings-field-hint',
      'Setup profiles bundle prompt settings, agent bindings, and tool permissions into one portable file. (Not the same as terminal shell profiles.)',
    ),
  );

  const offline = el(
    'p',
    'settings-field-hint settings-setup-profiles__offline hidden',
    'Setup profiles require Minnow running locally. Capture and apply are disabled offline.',
  );
  block.appendChild(offline);

  const activeLine = el('p', 'settings-field-hint settings-setup-profiles__active', '');
  block.appendChild(activeLine);

  const row = el('div', 'settings-custom-bar');
  const select = document.createElement('select');
  select.id = 'settingsSetupProfileSelect';
  select.className = 'settings-select';
  select.setAttribute('aria-label', 'Setup profile');
  row.appendChild(select);

  const applyBtn = el('button', '', 'Apply');
  applyBtn.type = 'button';
  applyBtn.id = 'settingsSetupProfileApply';

  const captureBtn = el('button', '', 'Save current as…');
  captureBtn.type = 'button';
  captureBtn.id = 'settingsSetupProfileCapture';

  const exportBtn = el('button', '', 'Export');
  exportBtn.type = 'button';
  exportBtn.id = 'settingsSetupProfileExport';

  const importLabel = el('label', '', 'Import');
  importLabel.htmlFor = 'settingsSetupProfileImportFile';
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.json,application/json';
  importInput.id = 'settingsSetupProfileImportFile';
  importInput.className = 'hidden';

  const dupBtn = el('button', '', 'Duplicate');
  dupBtn.type = 'button';
  dupBtn.id = 'settingsSetupProfileDuplicate';

  const delBtn = el('button', '', 'Delete');
  delBtn.type = 'button';
  delBtn.id = 'settingsSetupProfileDelete';

  row.append(applyBtn, captureBtn, exportBtn, importLabel, importInput, dupBtn, delBtn);
  block.appendChild(row);

  const importErr = el('p', 'settings-field-hint settings-setup-profiles__import-error hidden', '');
  block.appendChild(importErr);

  const wsField = el('div', 'settings-field');
  wsField.appendChild(el('p', 'settings-field-label', 'Workspace default'));
  const { row: wsToggle, input: wsCheck } = createSettingsToggleRow(
    'Use selected profile as workspace default',
    { id: 'settingsWorkspaceProfileDefault' },
  );
  const wsHint = el(
    'p',
    'settings-field-hint',
    'When enabled, switching to this workspace auto-applies the selected setup profile.',
  );
  const { row: autoApplyRow, input: autoApplyCheck } = createSettingsToggleRow(
    'Auto-apply on workspace switch',
    { id: 'settingsWorkspaceProfileAutoApply' },
  );
  wsField.append(wsToggle, wsHint, autoApplyRow);
  block.appendChild(wsField);

  container.prepend(block);

  const syncOffline = async () => {
    const up = await isProfilesServerAvailable();
    offline.classList.toggle('hidden', up);
    applyBtn.toggleAttribute('disabled', !up);
    captureBtn.toggleAttribute('disabled', !up);
    exportBtn.toggleAttribute('disabled', !up);
    dupBtn.toggleAttribute('disabled', !up);
    delBtn.toggleAttribute('disabled', !up);
    importInput.toggleAttribute('disabled', !up);
  };

  const refreshActiveLabel = async () => {
    const activeId = await fetchActiveSetupProfileId();
    if (!activeId) {
      activeLine.textContent = 'No setup profile is currently active.';
      await refreshProfileSelect(select, null);
      return;
    }
    const items = await listSetupProfiles();
    const match = items.find((p) => p.id === activeId);
    activeLine.textContent = `Active setup profile: ${match?.label ?? activeId} (${activeId})`;
    await refreshProfileSelect(select, activeId);
  };

  void syncOffline();
  void refreshActiveLabel();

  applyBtn.addEventListener('click', () => {
    void runSettingsAction(applyBtn, 'Working…', async () => {
      const id = select.value;
      if (!id) {
        setStatus('err', 'Select a setup profile first');
        return;
      }
      const { loadSetupProfile } = await import('../config/profiles-client');
      const loaded = await loadSetupProfile(id);
      if (loaded instanceof Error) {
        setStatus('err', loaded.message);
        return;
      }
      const summary = summarizeActivateImpact(loaded);
      if (
        !(await appConfirm(
          `Apply setup profile "${loaded.label}"?\n\nThis updates:\n${summary}\n\nContinue?`,
        ))
      ) {
        return;
      }
      const result = await activateSetupProfile(id);
      if (result instanceof Error) {
        setStatus('err', result.message);
        return;
      }
      showToast(`Applied profile at ${result.appliedAt}`);
      await refreshActiveLabel();
      await refreshSettingsSection('prompting');
      schedulePromptTokenEstimateRefresh();
    });
  });

  captureBtn.addEventListener('click', () => {
    void runSettingsAction(captureBtn, 'Working…', async () => {
      const label = await appPrompt('Setup profile name:', 'My setup');
      if (!label?.trim()) return;
      const id = label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
      if (!id) return;
      const result = await captureSetupProfile({ id, label: label.trim() });
      if (result instanceof Error) {
        setStatus('err', result.message);
        return;
      }
      select.value = result.id;
      await refreshActiveLabel();
    });
  });

  exportBtn.addEventListener('click', () => {
    void runSettingsAction(exportBtn, 'Working…', async () => {
      const id = select.value;
      if (!id) {
        setStatus('err', 'Select a profile to export');
        return;
      }
      const result = await exportSetupProfileFile(id);
      showToast(result instanceof Error ? result.message : 'Export started', result instanceof Error ? 'error' : 'success');
    });
  });

  importInput.addEventListener('change', () => {
    void runSettingsAction(importLabel, 'Importing…', async () => {
      importErr.classList.add('hidden');
      const file = importInput.files?.[0];
      importInput.value = '';
      if (!file) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        importErr.textContent = 'Invalid JSON file';
        importErr.classList.remove('hidden');
        return;
      }
      const result = await importSetupProfile(parsed as MinnowProfileBundle, 'create');
      if (result instanceof Error) {
        importErr.textContent = result.message;
        importErr.classList.remove('hidden');
        return;
      }
      showToast(`Imported "${result.label}"`);
      await refreshActiveLabel();
    });
  });

  dupBtn.addEventListener('click', () => {
    void runSettingsAction(dupBtn, 'Working…', async () => {
      const id = select.value;
      if (!id) return;
      const newLabel = await appPrompt('Duplicate as:', 'Copy');
      if (!newLabel?.trim()) return;
      const newId = `${id}-copy`.slice(0, 48).replace(/[^a-z0-9-]/g, '-');
      const result = await duplicateSetupProfile(id, newId, newLabel.trim());
      if (result instanceof Error) {
        setStatus('err', result.message);
        return;
      }
      await refreshActiveLabel();
      select.value = newId;
    });
  });

  delBtn.addEventListener('click', () => {
    void runSettingsAction(delBtn, 'Working…', async () => {
      const id = select.value;
      if (!id) return;
      if (
        !(await appConfirm(`Delete setup profile "${id}"?`, {
          confirmLabel: 'Delete',
          danger: true,
        }))
      ) {
        return;
      }
      const result = await deleteSetupProfile(id);
      if (result instanceof Error) {
        setStatus('err', result.message);
        return;
      }
      await refreshActiveLabel();
    });
  });

  wsCheck.addEventListener('change', () => {
    void (async () => {
      const profileId = wsCheck.checked ? select.value || null : null;
      const path = getWorkspacePath();
      if (!path) {
        setStatus('err', 'No workspace path set');
        wsCheck.checked = false;
        return;
      }
      const result = await setWorkspaceSetupProfileDefault(path, profileId);
      if (result instanceof Error) {
        setStatus('err', result.message);
        wsCheck.checked = false;
        return;
      }
    })();
  });

  autoApplyCheck.addEventListener('change', () => {
    void (async () => {
      try {
        await saveWorkspaceProfileAutoApply(autoApplyCheck.checked);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus('err', message);
        autoApplyCheck.checked = !autoApplyCheck.checked;
      }
    })();
  });

  void (async () => {
    try {
      const res = await fetch('/api/config/meta', { cache: 'no-store' });
      if (res.ok) {
        const meta = (await res.json()) as {
          workspaceProfileAutoApply?: boolean;
          workspaceProfiles?: Record<string, string>;
        };
        autoApplyCheck.checked = meta.workspaceProfileAutoApply === true;
        const path = getWorkspacePath();
        if (path && meta.workspaceProfiles) {
          const key = normalizeWorkspacePath(path);
          const mapped = meta.workspaceProfiles[key];
          wsCheck.checked = Boolean(mapped);
          if (mapped) select.value = mapped;
        }
      }
    } catch {
    }
  })();
}

/** Reset bind flag for tests. */
export function resetSetupProfilesPanelForTests(): void {
  profilesBound = false;
}
