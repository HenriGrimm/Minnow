/**
 * S5, S6, S12 — permissions, memory, and finish steps.
 */

import { fetchMemoryEnabled } from '../../memory/client';
import {
  fetchMemoryInjectionEnabled,
  saveMemorySettings,
} from '../../memory/config';
import { setPermissionLevel } from '../../config/tool-security-meta';
import { PERMISSION_LEVEL_META, type PermissionLevel } from '../../lib/permissions.mjs';
import { el, createChoiceCard, renderStepHeader } from '../ui-helpers';
import type { OnboardingContext, OnboardingStep } from '../types';
import { recordStepProgress } from '../state-core';

let permissionPreset: PermissionLevel = 'auto';
let memoryStoreEnabled = true;
let memoryInjectionEnabled = true;

/** Toggle row for onboarding brain/memory preferences. */
function createMemoryToggleRow(options: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): HTMLLabelElement {
  const row = el('label', 'mn-onboarding-toggle-row');
  const copy = el('div', 'mn-onboarding-toggle-row__copy');
  copy.appendChild(el('span', 'mn-onboarding-toggle-row__title', options.title));
  copy.appendChild(el('span', 'mn-onboarding-toggle-row__desc', options.description));
  const input = el('input', 'mn-onboarding-toggle-row__input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = options.checked;
  input.addEventListener('change', () => {
    options.onChange(input.checked);
  });
  row.append(copy, input);
  return row;
}

export const permissionsStep: OnboardingStep = {
  id: 'permissions',
  title: 'Permissions',
  canSkip: true,
  isApplicable: () => true,
  render(container, ctx, actions) {
    const savedPreset = ctx.state.steps.permissions?.data?.preset;
    permissionPreset = savedPreset === 'manual' || savedPreset === 'full' ? savedPreset : 'auto';
    container.innerHTML = '';
    container.className = 'mn-onboarding-step';
    renderStepHeader(container, permissionsStep, actions.stepIndex, actions.totalSteps);
    container.appendChild(
      el(
        'p',
        'mn-onboarding-step-desc',
        'Choose what the agent may do without asking. It applies everywhere — tools, commands, the browser, MCP and plugins — and you can change it any time from the composer (Shift+Tab).',
      ),
    );

    const grid = el('div', 'mn-onboarding-choice-grid');
    const presets: { id: typeof permissionPreset; title: string; desc: string; rec?: boolean }[] = (
      ['manual', 'auto', 'full'] as const
    ).map((id) => ({
      id,
      title: PERMISSION_LEVEL_META[id].label,
      desc: PERMISSION_LEVEL_META[id].description,
      rec: id === 'auto',
    }));

    presets.forEach((preset) => {
      grid.appendChild(
        createChoiceCard({
          title: preset.title,
          description: preset.desc,
          recommended: preset.rec,
          selected: permissionPreset === preset.id,
          onSelect: () => {
            permissionPreset = preset.id;
            actions.setPrimaryEnabled(true);
            providerPermissionsRerender(grid, presets);
          },
        }),
      );
    });
    container.appendChild(grid);
    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(true);
  },
  async commit(ctx) {
    await setPermissionLevel(permissionPreset);
    ctx.state = recordStepProgress(ctx.state, 'permissions', {
      done: true,
      data: { preset: permissionPreset },
    });
  },
};

function providerPermissionsRerender(
  grid: HTMLElement,
  presets: { id: typeof permissionPreset }[],
): void {
  grid.querySelectorAll('.mn-onboarding-choice').forEach((node, i) => {
    (node as HTMLElement).classList.toggle('is-selected', presets[i]?.id === permissionPreset);
    node.setAttribute('aria-pressed', String(presets[i]?.id === permissionPreset));
  });
}

export const memoryStep: OnboardingStep = {
  id: 'memory',
  title: 'Memory and Brain',
  canSkip: true,
  isApplicable: () => true,
  render(container, ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step';
    let active = true;
    renderStepHeader(container, memoryStep, actions.stepIndex, actions.totalSteps);
    container.appendChild(
      el(
        'p',
        'mn-onboarding-step-desc',
        'Minnow remembers facts locally under ~/.minnow and files them into your Brain wiki. Both stay on by default.',
      ),
    );

    const card = el('div', 'mn-onboarding-info-card');
    const toggles = el('div', 'mn-onboarding-toggle-list');

    const storeToggle = createMemoryToggleRow({
      title: 'Enable memory store',
      description: 'Save facts locally under ~/.minnow for recall across chats.',
      checked: memoryStoreEnabled,
      onChange: (checked) => {
        memoryStoreEnabled = checked;
      },
    });
    const injectionToggle = createMemoryToggleRow({
      title: 'Semantic recall on send',
      description: 'Inject matching memories into new messages when relevant.',
      checked: memoryInjectionEnabled,
      onChange: (checked) => {
        memoryInjectionEnabled = checked;
      },
    });
    toggles.append(storeToggle, injectionToggle);
    card.appendChild(toggles);
    card.appendChild(
      el(
        'p',
        'mn-onboarding-toggle-footnote',
        'View and edit memories anytime in the Brain app.',
      ),
    );
    container.appendChild(card);

    if (!ctx.configServerAvailable) {
      container.appendChild(
        el('p', 'mn-onboarding-notice', 'Full memory features need Minnow running locally.'),
      );
    } else {
      const inputs = toggles.querySelectorAll('input');
      inputs.forEach(input => { input.disabled = true; });
      void (async () => {
        const [store, injection] = await Promise.all([fetchMemoryEnabled(), fetchMemoryInjectionEnabled()]);
        if (!active) return;
        memoryStoreEnabled = store;
        memoryInjectionEnabled = injection;
        const storeInput = storeToggle.querySelector('input') as HTMLInputElement | null;
        const injectionInput = injectionToggle.querySelector('input') as HTMLInputElement | null;
        if (storeInput) storeInput.checked = memoryStoreEnabled;
        if (injectionInput) injectionInput.checked = memoryInjectionEnabled;
        inputs.forEach(input => { input.disabled = false; });
        actions.setPrimaryEnabled(true);
      })().catch(() => {
        if (!active) return;
        container.appendChild(el('p', 'mn-onboarding-notice', 'Could not load memory settings. Go back to retry, or set up later.'));
      });
    }

    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(!ctx.configServerAvailable);
    return () => { active = false; };
  },
  async commit(ctx) {
    if (ctx.configServerAvailable) {
      await saveMemorySettings({
        storeEnabled: memoryStoreEnabled,
        injectionEnabled: memoryInjectionEnabled,
      });
    }
    ctx.state = recordStepProgress(ctx.state, 'memory', {
      done: true,
      data: {
        memoryStore: memoryStoreEnabled,
        memoryInjection: memoryInjectionEnabled,
      },
    });
  },
};

export const doneStep: OnboardingStep = {
  id: 'done',
  title: 'You are set up',
  canSkip: false,
  isApplicable: () => true,
  render(container, ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step mn-onboarding-step--done';

    const badge = el('div', 'mn-onboarding-done-badge', '✓');
    container.appendChild(badge);

    renderStepHeader(container, doneStep, actions.stepIndex, actions.totalSteps);
    container.appendChild(
      el('p', 'mn-onboarding-step-desc', 'Open a project in Code to start building. You can finish any skipped setup in Settings.'),
    );

    const checklist = el('ul', 'mn-onboarding-checklist');
    const rows: [string, boolean][] = [
      ['Theme', Boolean(ctx.state.steps.theme?.done)],
      [
        'Provider',
        Boolean(
            ctx.state.steps['provider-local']?.done ||
              ctx.state.steps['provider-cli']?.done ||
            ctx.state.steps['provider-cloud']?.done ||
            ctx.state.steps['provider-managed']?.done,
        ),
      ],
      [
        'Model',
        Boolean(ctx.state.steps['model-pick']?.done || ctx.state.steps['provider-managed']?.done),
      ],
      ['Extras', Boolean(ctx.state.steps.extras?.done)],
      ['GitHub', Boolean(ctx.state.steps.github?.done)],
      ['Permissions', Boolean(ctx.state.steps.permissions?.done)],
      ['Memory and Brain', Boolean(ctx.state.steps.memory?.done)],
      ['Context7 library docs', Boolean(ctx.state.steps.context7?.done)],
    ];
    rows.forEach(([label, ok]) => {
      const li = el('li', 'mn-onboarding-checklist__row');
      li.appendChild(el('span', ok ? 'is-ok' : 'is-muted', ok ? '✓' : '–'));
      li.appendChild(el('span', undefined, label));
      checklist.appendChild(li);
    });
    container.appendChild(checklist);

    actions.setPrimaryLabel('Open Minnow');
    actions.setPrimaryEnabled(true);
  },
  commit(ctx) {
    ctx.state = recordStepProgress(ctx.state, 'done', { done: true });
  },
};
