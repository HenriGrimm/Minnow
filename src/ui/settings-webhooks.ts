import { appAlert, appConfirm, appPrompt } from './app-dialog';
/**
 * Settings → Webhooks — outgoing HMAC-signed event subscriptions.
 */

import { detectConfigServer, isServerStorageMode } from '../config/storage-mode';
import { appendSettingsGroup } from './settings-layout';
import { appendSettingsOfflineHint } from './settings-controls';
import { createSettingsToggleRow } from './settings-switch';
import { setStatus } from './status';

/** Events users can subscribe to (mirrors server/webhooks/constants.js). */
const SUBSCRIBABLE_EVENTS = [
  'chat.completed',
  'session.created',
  'scheduler.job_completed',
] as const;

/** Public subscription shape from the API (no secret material). */
export interface WebhookSubscriptionSummary {
  id: string;
  label: string;
  url: string;
  events: string[];
  enabled: boolean;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliverySummary {
  id: string;
  subscriptionId: string;
  event: string;
  statusCode?: number;
  error?: string;
  durationMs: number;
  attemptedAt: string;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function generateSigningSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function fetchSubscriptions(): Promise<WebhookSubscriptionSummary[]> {
  const res = await fetch('/api/webhooks/subscriptions');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { subscriptions?: WebhookSubscriptionSummary[] };
  return Array.isArray(data.subscriptions) ? data.subscriptions : [];
}

async function fetchDeliveries(): Promise<WebhookDeliverySummary[]> {
  const res = await fetch('/api/webhooks/deliveries');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { deliveries?: WebhookDeliverySummary[] };
  return Array.isArray(data.deliveries) ? data.deliveries : [];
}

// ── Subscriptions ────────────────────────────────────────────────────────────

/**
 * Render webhook subscription management into the settings mount node.
 */
export async function renderWebhooksSettingsSection(mount: HTMLElement): Promise<void> {
  mount.replaceChildren();

  if (!isServerStorageMode()) {
    appendSettingsOfflineHint(
      mount,
      'Webhook settings are saved on this device. Open Minnow to manage them.',
    );
    return;
  }

  const mode = await detectConfigServer();
  if (mode !== 'server') {
    appendSettingsOfflineHint(
      mount,
      'Open Minnow to manage outgoing webhooks.',
    );
    return;
  }

  mount.appendChild(
    el(
      'p',
      'settings-section-note',
      'Fire HMAC-signed JSON POSTs when chats complete or new sessions are created. Destinations and secrets are encrypted at rest; payloads never include prompt text or workspace paths.',
    ),
  );

  const listMount = el('div', 'settings-webhooks-list');
  const formMount = el('div', 'settings-webhooks-form');
  const deliveriesMount = el('div', 'settings-webhooks-deliveries');

  mount.append(listMount, formMount, deliveriesMount);

  const refresh = async (): Promise<void> => {
    await renderSubscriptionList(listMount, refresh);
    renderAddForm(formMount, refresh);
    await renderDeliveriesTable(deliveriesMount);
  };

  await refresh();
}

async function renderSubscriptionList(
  mount: HTMLElement,
  onChange: () => Promise<void>,
): Promise<void> {
  mount.replaceChildren();
  const groupBody = appendSettingsGroup(
    mount,
    'Subscriptions',
    'HTTPS endpoints only (optional local http when config.webhooks.allowLocalHttp is true).',
    'webhooks subscriptions',
  );

  let subscriptions: WebhookSubscriptionSummary[] = [];
  try {
    subscriptions = await fetchSubscriptions();
  } catch {
    groupBody.appendChild(el('p', 'settings-field-hint', 'Could not load subscriptions.'));
    return;
  }

  if (subscriptions.length === 0) {
    groupBody.appendChild(el('p', 'settings-field-hint', 'No webhook subscriptions yet.'));
    return;
  }

  const list = el('div', 'settings-mcp-list');
  list.setAttribute('role', 'list');

  for (const sub of subscriptions) {
    const row = el('article', 'settings-mcp-row');
    row.setAttribute('role', 'listitem');

    const head = el('div', 'settings-mcp-row-head');
    head.append(el('span', 'settings-mcp-name', sub.label));
    if (sub.hasSecret) {
      head.append(el('span', 'settings-mcp-badge', 'Signed'));
    }
    row.append(head);

    const detail = el('div', 'settings-mcp-detail');
    detail.append(el('p', 'settings-mcp-desc', sub.url));
    detail.append(
      el('p', 'settings-mcp-hint', `Events: ${sub.events.join(', ') || 'none'}`),
    );

    const { row: enabledRow, input: enabledCb } = createSettingsToggleRow('Enabled', {
      checked: sub.enabled,
    });
    enabledCb.addEventListener('change', () => {
      void (async () => {
        try {
          const res = await fetch(`/api/webhooks/subscriptions/${sub.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: enabledCb.checked }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setStatus('ok', 'Webhook subscription updated');
          await onChange();
        } catch {
          enabledCb.checked = !enabledCb.checked;
          setStatus('err', 'Could not update subscription');
        }
      })();
    });
    detail.append(enabledRow);

    const actions = el('div', 'settings-server-actions');
    const testBtn = el('button', 'settings-inline-btn', 'Test fire');
    testBtn.type = 'button';
    testBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const res = await fetch(`/api/webhooks/subscriptions/${sub.id}/test`, {
            method: 'POST',
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setStatus('ok', 'Test webhook queued');
          await onChange();
        } catch {
          setStatus('err', 'Test fire failed');
        }
      })();
    });

    const deleteBtn = el('button', 'settings-inline-btn settings-inline-btn--danger', 'Delete');
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', () => {
      void (async () => {
        if (!await appConfirm(`Delete webhook "${sub.label}"?`)) return;
        try {
          const res = await fetch(`/api/webhooks/subscriptions/${sub.id}`, {
            method: 'DELETE',
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setStatus('ok', 'Webhook deleted');
          await onChange();
        } catch {
          setStatus('err', 'Could not delete subscription');
        }
      })();
    });

    actions.append(testBtn, deleteBtn);
    detail.append(actions);
    row.append(detail);
    list.append(row);
  }

  groupBody.appendChild(list);
}

function renderAddForm(mount: HTMLElement, onSaved: () => Promise<void>): void {
  mount.replaceChildren();
  const groupBody = appendSettingsGroup(
    mount,
    'Add subscription',
    'A signing secret of at least 32 characters is required for receiver verification.',
    'webhooks add',
  );

  const form = el('form', 'settings-mcp-form');
  form.noValidate = true;

  const labelField = el('div', 'field');
  labelField.append(el('label', undefined, 'Label'));
  const labelInput = el('input') as HTMLInputElement;
  labelInput.required = true;
  labelInput.autocomplete = 'off';
  labelField.appendChild(labelInput);

  const urlField = el('div', 'field');
  urlField.append(el('label', undefined, 'HTTPS URL'));
  const urlInput = el('input') as HTMLInputElement;
  urlInput.type = 'url';
  urlInput.required = true;
  urlInput.placeholder = 'https://example.com/hooks/minnow';
  urlField.appendChild(urlInput);

  const secretField = el('div', 'field');
  secretField.append(el('label', undefined, 'Signing secret'));
  const secretInput = el('input') as HTMLInputElement;
  secretInput.type = 'password';
  secretInput.required = true;
  secretInput.minLength = 32;
  secretInput.maxLength = 4096;
  secretInput.autocomplete = 'new-password';
  const generateSecretBtn = el('button', 'settings-inline-btn', 'Generate secure secret');
  generateSecretBtn.type = 'button';
  generateSecretBtn.addEventListener('click', () => {
    secretInput.value = generateSigningSecret();
    secretInput.focus();
    secretInput.select();
    setStatus('ok', 'Secure signing secret generated and selected');
  });
  secretField.append(secretInput, generateSecretBtn);

  const eventsField = el('div', 'settings-field-stack');
  eventsField.dataset.settingsSearchKey = 'integrations.webhooks.events';
  const eventsLabel = el('span', 'settings-field-stack__label', 'Events');
  eventsLabel.id = 'settingsWebhooksEventsLabel';
  eventsField.appendChild(eventsLabel);

  const eventsList = el('div', 'settings-checklist');
  eventsList.setAttribute('role', 'group');
  eventsList.setAttribute('aria-labelledby', 'settingsWebhooksEventsLabel');

  const eventChecks: HTMLInputElement[] = [];
  for (const eventName of SUBSCRIBABLE_EVENTS) {
    const row = el('label', 'settings-checklist__option');
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.value = eventName;
    cb.name = 'webhook-events';
    if (eventName === 'chat.completed') cb.checked = true;
    eventChecks.push(cb);
    const name = el('code', 'settings-checklist__mono', eventName);
    row.append(cb, name);
    eventsList.append(row);
  }
  eventsField.appendChild(eventsList);

  const errorEl = el('p', 'settings-mcp-form-error hidden');
  errorEl.setAttribute('role', 'alert');

  const submitBtn = el('button', 'settings-action-btn', 'Add subscription');
  submitBtn.type = 'submit';

  form.append(labelField, urlField, secretField, eventsField, errorEl, submitBtn);
  groupBody.appendChild(form);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    errorEl.classList.add('hidden');
    const events = eventChecks.filter((cb) => cb.checked).map((cb) => cb.value);
    if (events.length === 0) {
      errorEl.textContent = 'Select at least one event.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (secretInput.value.trim().length < 32) {
      errorEl.textContent = 'Enter a signing secret of at least 32 characters.';
      errorEl.classList.remove('hidden');
      return;
    }
    void (async () => {
      try {
        const res = await fetch('/api/webhooks/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: labelInput.value.trim(),
            url: urlInput.value.trim(),
            secret: secretInput.value,
            events,
          }),
        });
        const payload = (await res.json()) as { error?: string };
        if (!res.ok) {
          throw new Error(payload.error || `HTTP ${res.status}`);
        }
        labelInput.value = '';
        urlInput.value = '';
        secretInput.value = '';
        setStatus('ok', 'Webhook subscription added');
        await onSaved();
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : 'Could not save subscription';
        errorEl.classList.remove('hidden');
      }
    })();
  });
}

// ── Deliveries ───────────────────────────────────────────────────────────────

async function renderDeliveriesTable(mount: HTMLElement): Promise<void> {
  mount.replaceChildren();
  const groupBody = appendSettingsGroup(
    mount,
    'Recent deliveries',
    'Last 100 attempts (errors are redacted).',
    'webhooks deliveries',
  );

  let deliveries: WebhookDeliverySummary[] = [];
  try {
    deliveries = await fetchDeliveries();
  } catch {
    groupBody.appendChild(el('p', 'settings-field-hint', 'Could not load delivery log.'));
    return;
  }

  if (deliveries.length === 0) {
    groupBody.appendChild(el('p', 'settings-field-hint', 'No deliveries yet.'));
    return;
  }

  const table = el('table', 'settings-webhooks-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const heading of ['Time', 'Event', 'Status', 'Duration', 'Error']) {
    headRow.appendChild(el('th', undefined, heading));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const entry of deliveries.slice(0, 50)) {
    const tr = el('tr');
    const time = new Date(entry.attemptedAt).toLocaleString();
    const status =
      typeof entry.statusCode === 'number' ? String(entry.statusCode) : '—';
    tr.append(
      el('td', undefined, time),
      el('td', undefined, entry.event),
      el('td', undefined, status),
      el('td', undefined, `${entry.durationMs} ms`),
      el('td', undefined, entry.error ?? ''),
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  groupBody.appendChild(table);
}
