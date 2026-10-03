/**
 * Workspace — Context7 MCP API key setup for live library docs in Plan/Build.
 */

import { fetchMcpSecrets, updateMcpSecrets } from '../../mcp/client';
import { createStatusPill, el, renderStepHeader } from '../ui-helpers';
import type { OnboardingStep } from '../types';
import { recordStepProgress } from '../state-core';

const CONTEXT7_API_KEY_URL = 'https://context7.com';

let apiKeyInput = '';
let keySaved = false;
let saveError = '';

export const context7Step: OnboardingStep = {
  id: 'context7',
  title: 'Library docs (Context7)',
  canSkip: true,
  isApplicable: (ctx) => ctx.serverAvailable,

  render(container, _ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step';
    let active = true;
    let edited = false;
    renderStepHeader(container, context7Step, actions.stepIndex, actions.totalSteps);

    container.appendChild(
      el(
        'p',
        'mn-onboarding-step-desc',
        'Context7 is built into Minnow and gives agents up-to-date library and framework docs during Plan and Build.',
      ),
    );

    const notice = el('p', 'mn-onboarding-notice');
    notice.appendChild(
      document.createTextNode('Get a free API key at '),
    );
    const link = el('a', 'mn-onboarding-settings-link') as HTMLAnchorElement;
    link.href = CONTEXT7_API_KEY_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'context7.com';
    notice.appendChild(link);
    notice.appendChild(
      document.createTextNode(
        '. Keys are encrypted at rest under ~/.minnow/mcp/secrets.json (or set CONTEXT7_API_KEY).',
      ),
    );
    container.appendChild(notice);

    const form = el('div', 'mn-onboarding-form-grid');
    const wrap = el('label', 'mn-onboarding-field-label');
    wrap.htmlFor = 'onbContext7Key';
    wrap.appendChild(el('span', undefined, 'Context7 API key'));
    const input = el('input', 'mn-onboarding-field') as HTMLInputElement;
    input.id = 'onbContext7Key';
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder = 'Paste your Context7 API key';
    input.value = apiKeyInput;
    input.addEventListener('input', () => {
      edited = true;
      apiKeyInput = input.value.trim();
      keySaved = false;
      saveError = '';
      statusPill.className = 'mn-onboarding-status mn-onboarding-status--pending';
      statusPill.textContent = 'Not saved';
      saveBtn.textContent = 'Save key';
      saveBtn.disabled = false;
      actions.setPrimaryEnabled(false);
    });
    wrap.appendChild(input);
    form.appendChild(wrap);
    container.appendChild(form);

    const saveBtn = el('button', 'mn-onboarding-secondary-btn', keySaved ? 'Saved' : 'Save key');
    saveBtn.type = 'button';
    saveBtn.disabled = keySaved;

    const statusPill = createStatusPill(
      keySaved ? 'ok' : saveError ? 'err' : 'pending',
      keySaved ? 'Key saved' : saveError || 'Not saved',
    );

    saveBtn.addEventListener('click', () => {
      if (!apiKeyInput) {
        saveError = 'Enter a Context7 API key';
        statusPill.className = 'mn-onboarding-status mn-onboarding-status--err';
        statusPill.textContent = saveError;
        return;
      }

      saveBtn.disabled = true;
      input.disabled = true;
      saveBtn.textContent = 'Saving…';
      saveError = '';
      statusPill.className = 'mn-onboarding-status mn-onboarding-status--pending';
      statusPill.textContent = 'Saving…';

      void (async () => {
        const result = await updateMcpSecrets({ context7ApiKey: apiKeyInput });
        if (!active) return;
        input.disabled = false;
        if (result.ok === false) {
          saveError = result.error;
          statusPill.className = 'mn-onboarding-status mn-onboarding-status--err';
          statusPill.textContent = saveError;
          saveBtn.textContent = 'Retry';
          saveBtn.disabled = false;
          return;
        }

        keySaved = result.flags.hasContext7ApiKey;
        apiKeyInput = '';
        input.value = '';
        input.placeholder = 'Key saved — leave blank or paste a new key to replace';
        statusPill.className = 'mn-onboarding-status mn-onboarding-status--ok';
        statusPill.textContent = 'Key saved';
        saveBtn.textContent = 'Saved';
        actions.setPrimaryEnabled(keySaved);
      })().catch(() => {
        if (!active) return;
        input.disabled = false;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Retry';
        statusPill.className = 'mn-onboarding-status mn-onboarding-status--err';
        statusPill.textContent = 'Could not save the key. Try again.';
      });
    });
    container.appendChild(saveBtn);

    const statusRow = el('div', 'mn-onboarding-status-row');
    statusRow.appendChild(statusPill);
    container.appendChild(statusRow);

    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(keySaved);

    void fetchMcpSecrets().then((flags) => {
      if (!active || edited || !flags?.hasContext7ApiKey) return;
      keySaved = true;
      input.placeholder = 'Key saved — leave blank or paste a new key to replace';
      statusPill.className = 'mn-onboarding-status mn-onboarding-status--ok';
      statusPill.textContent = 'Key saved';
      saveBtn.textContent = 'Saved';
      saveBtn.disabled = true;
      actions.setPrimaryEnabled(true);
    }).catch(() => {});
    return () => { active = false; };
  },

  commit(ctx) {
    ctx.state = recordStepProgress(ctx.state, 'context7', {
      done: keySaved,
      skipped: !keySaved,
      data: { hasKey: keySaved },
    });
  },
};

export function resetContext7StepState(): void {
  apiKeyInput = '';
  keySaved = false;
  saveError = '';
}
