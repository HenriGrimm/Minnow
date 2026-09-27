import {
  cancelAcpAgentRun,
  getAcpAgentRun,
  listAcpAgents,
  saveAcpAgent,
  startAcpAgentRun,
  verifyAcpAgent,
  type AcpAgentRegistration,
  type AcpRunEvent,
} from '../agents/acp-client';
import { getWorkspacePath } from '../state/workspace';
import { appendSettingsGroup } from './settings-layout';
import {
  appendAgentCenterSection,
  openAgentCenterLightbox,
} from './settings-agent-center-lightbox';
import { setStatus } from './status';

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

export function parseAcpArgs(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseAcpSecretEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) throw new Error('Private environment lines must use NAME=value');
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    env[key] = line.slice(equals + 1);
  }
  return env;
}

function field(labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', 'settings-acp-field');
  const label = el('label', 'settings-field-label', labelText);
  if (control.id) label.htmlFor = control.id;
  wrap.append(label, control);
  if (hint) wrap.appendChild(el('p', 'settings-field-hint', hint));
  return wrap;
}

function textInput(id: string, value = ''): HTMLInputElement {
  const input = document.createElement('input');
  input.id = id;
  input.className = 'settings-input';
  input.value = value;
  return input;
}

function textarea(id: string, value = ''): HTMLTextAreaElement {
  const input = document.createElement('textarea');
  input.id = id;
  input.className = 'settings-input settings-acp-textarea';
  input.value = value;
  input.rows = 3;
  return input;
}

function mountRegistrationFields(
  mount: HTMLElement,
  initial?: AcpAgentRegistration,
): {
  id: HTMLInputElement;
  label: HTMLInputElement;
  command: HTMLInputElement;
  args: HTMLTextAreaElement;
  secretEnv: HTMLTextAreaElement;
  enabled: HTMLInputElement;
} {
  const id = textInput(`acpAgentId-${initial?.id ?? 'new'}`, initial?.id ?? '');
  id.placeholder = 'my-agent';
  id.disabled = Boolean(initial);
  const label = textInput(`acpAgentLabel-${initial?.id ?? 'new'}`, initial?.label ?? '');
  label.placeholder = 'My ACP agent';
  const command = textInput(`acpAgentCommand-${initial?.id ?? 'new'}`, initial?.command ?? '');
  command.placeholder = 'agent-command';
  const args = textarea(`acpAgentArgs-${initial?.id ?? 'new'}`, initial?.args.join('\n') ?? '');
  args.placeholder = 'One argument per line';
  const secretEnv = textarea(`acpAgentEnv-${initial?.id ?? 'new'}`);
  secretEnv.placeholder = initial?.hasPrivateEnvironment
    ? `${initial.envKeys.join(', ')} saved. Leave blank to preserve.`
    : 'API_KEY=value';
  secretEnv.spellcheck = false;
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.id = `acpAgentEnabled-${initial?.id ?? 'new'}`;
  enabled.checked = initial?.enabled !== false;

  const grid = el('div', 'settings-acp-fields');
  grid.append(
    field('ID', id, 'Lowercase letters, numbers, and hyphens.'),
    field('Label', label),
    field('Command', command, 'Started directly with shell expansion disabled.'),
    field('Arguments', args, 'One argument per line.'),
    field(
      'Private environment',
      secretEnv,
      initial
        ? 'Values are encrypted. Blank preserves the saved environment.'
        : 'Values are encrypted and never returned to the interface.',
    ),
  );
  const enabledWrap = el('label', 'settings-acp-enabled');
  enabledWrap.append(enabled, document.createTextNode(' Enabled'));
  grid.appendChild(enabledWrap);
  mount.appendChild(grid);
  return { id, label, command, args, secretEnv, enabled };
}

function readFields(fields: ReturnType<typeof mountRegistrationFields>) {
  const secretText = fields.secretEnv.value.trim();
  return {
    id: fields.id.value.trim(),
    label: fields.label.value.trim(),
    command: fields.command.value.trim(),
    args: parseAcpArgs(fields.args.value),
    enabled: fields.enabled.checked,
    ...(secretText ? { secretEnv: parseAcpSecretEnv(secretText) } : {}),
  };
}

export function mountAcpRegistration(
  mount: HTMLElement,
  onSaved: () => void,
): HTMLElement {
  const body = appendSettingsGroup(
    mount,
    'Register an ACP agent',
    'Connect a local Agent Client Protocol process over stdio.',
    'agents.acp.register',
    { emphasis: true },
  );
  const fields = mountRegistrationFields(body);
  const feedback = el('p', 'settings-acp-feedback');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  const save = el('button', 'settings-action-btn settings-action-btn--primary', 'Register agent');
  save.type = 'button';
  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true;
      feedback.textContent = 'Saving…';
      try {
        await saveAcpAgent(readFields(fields));
        feedback.textContent = 'Agent registered. Open its card to verify and run it.';
        fields.secretEnv.value = '';
        onSaved();
      } catch (error) {
        feedback.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        save.disabled = false;
      }
    })();
  });
  body.append(save, feedback);
  return body;
}

function appendRunEvent(output: HTMLElement, event: AcpRunEvent): void {
  if (event.type === 'message' && event.text) {
    output.append(document.createTextNode(event.text));
    return;
  }
  if (event.type === 'thought' && event.text) {
    output.appendChild(el('div', 'settings-acp-run__thought', `Thinking: ${event.text}`));
    return;
  }
  if (event.type === 'tool') {
    output.appendChild(el('div', 'settings-acp-run__event', `${event.title ?? 'Agent tool'}: ${event.status ?? 'updated'}`));
    return;
  }
  if (event.type === 'unsupported' || event.type === 'error') {
    output.appendChild(el('div', 'settings-acp-run__error', event.message ?? 'ACP run failed'));
  }
}

export function openAcpAgentEditor(
  agent: AcpAgentRegistration,
  onChanged: () => void,
): void {
  openAgentCenterLightbox({
    title: agent.label,
    subtitle: `${agent.command}${agent.args.length ? ` ${agent.args.join(' ')}` : ''}`,
    badge: 'ACP agent',
    render: (body) => {
      appendAgentCenterSection(body, 'Connection', (panel) => {
        const status = el('p', 'settings-acp-feedback');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = agent.lastValidation?.ok
          ? `ACP v${agent.lastValidation.protocolVersion} verified ${agent.lastValidation.checkedAt}`
          : agent.lastValidation?.error ?? 'Not verified yet.';
        const verify = el('button', 'settings-action-btn', 'Verify connection');
        verify.type = 'button';
        verify.addEventListener('click', () => {
          void (async () => {
            verify.disabled = true;
            status.textContent = 'Starting agent and negotiating ACP…';
            try {
              const result = await verifyAcpAgent(agent.id, getWorkspacePath());
              status.textContent = result.ok
                ? `ACP v${result.protocolVersion} ready. Text prompts supported.`
                : result.error ?? 'ACP validation failed.';
              setStatus(result.ok ? 'ok' : 'err', result.ok ? `${agent.label} verified` : 'ACP validation failed');
              onChanged();
            } catch (error) {
              status.textContent = error instanceof Error ? error.message : String(error);
            } finally {
              verify.disabled = false;
            }
          })();
        });
        panel.append(status, verify);
      });

      appendAgentCenterSection(body, 'Run prompt', (panel) => {
        const prompt = textarea(`acpAgentPrompt-${agent.id}`);
        prompt.rows = 5;
        prompt.placeholder = 'Ask this agent to work in the current workspace…';
        const actions = el('div', 'settings-actions');
        const runButton = el('button', 'settings-action-btn settings-action-btn--primary', 'Run agent');
        runButton.type = 'button';
        const cancelButton = el('button', 'settings-action-btn', 'Cancel');
        cancelButton.type = 'button';
        cancelButton.disabled = true;
        actions.append(runButton, cancelButton);
        const runStatus = el('p', 'settings-acp-feedback', 'Ready.');
        runStatus.setAttribute('role', 'status');
        runStatus.setAttribute('aria-live', 'polite');
        const output = el('div', 'settings-acp-run__output');
        output.setAttribute('aria-label', 'ACP agent output');
        output.setAttribute('aria-live', 'polite');
        panel.append(field('Prompt', prompt), actions, runStatus, output);

        let activeRunId = '';
        let lastSeq = 0;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        const stopPolling = () => {
          if (pollTimer) clearTimeout(pollTimer);
          pollTimer = null;
        };
        const poll = async (): Promise<void> => {
          if (!activeRunId) return;
          try {
            const run = await getAcpAgentRun(activeRunId, lastSeq);
            for (const event of run.events) {
              lastSeq = Math.max(lastSeq, event.seq);
              appendRunEvent(output, event);
            }
            runStatus.textContent = run.error
              ? `Failed: ${run.error}`
              : run.status === 'completed'
                ? `Completed: ${run.stopReason ?? 'end turn'}`
                : run.status;
            const terminal = ['completed', 'failed', 'cancelled'].includes(run.status);
            if (terminal) {
              activeRunId = '';
              runButton.disabled = false;
              cancelButton.disabled = true;
              stopPolling();
              return;
            }
            pollTimer = setTimeout(() => void poll(), 250);
          } catch (error) {
            runStatus.textContent = error instanceof Error ? error.message : String(error);
            activeRunId = '';
            runButton.disabled = false;
            cancelButton.disabled = true;
          }
        };

        runButton.addEventListener('click', () => {
          void (async () => {
            const text = prompt.value.trim();
            if (!text) {
              runStatus.textContent = 'Enter a prompt first.';
              return;
            }
            runButton.disabled = true;
            output.replaceChildren();
            runStatus.textContent = 'Starting…';
            try {
              const run = await startAcpAgentRun(agent.id, text, getWorkspacePath());
              activeRunId = run.id;
              lastSeq = 0;
              cancelButton.disabled = false;
              await poll();
            } catch (error) {
              runStatus.textContent = error instanceof Error ? error.message : String(error);
              runButton.disabled = false;
            }
          })();
        });
        cancelButton.addEventListener('click', () => {
          if (!activeRunId) return;
          cancelButton.disabled = true;
          runStatus.textContent = 'Cancelling…';
          void cancelAcpAgentRun(activeRunId).then(() => poll());
        });
      });

      appendAgentCenterSection(body, 'Registration', (panel) => {
        const fields = mountRegistrationFields(panel, agent);
        const feedback = el('p', 'settings-acp-feedback');
        feedback.setAttribute('role', 'status');
        const actions = el('div', 'settings-actions');
        const save = el('button', 'settings-action-btn', 'Save registration');
        save.type = 'button';
        const clear = el('button', 'settings-action-btn', 'Clear private environment');
        clear.type = 'button';
        clear.disabled = !agent.hasPrivateEnvironment;
        save.addEventListener('click', () => {
          void (async () => {
            try {
              await saveAcpAgent(readFields(fields), true);
              fields.secretEnv.value = '';
              feedback.textContent = 'Registration saved.';
              onChanged();
            } catch (error) {
              feedback.textContent = error instanceof Error ? error.message : String(error);
            }
          })();
        });
        clear.addEventListener('click', () => {
          clear.disabled = true;
          void saveAcpAgent({ ...readFields(fields), secretEnv: {} }, true)
            .then(() => {
              feedback.textContent = 'Private environment cleared.';
              onChanged();
            })
            .catch((error) => {
              clear.disabled = false;
              feedback.textContent = error instanceof Error ? error.message : String(error);
            });
        });
        actions.append(save, clear);
        panel.append(actions, feedback);
      });
    },
  });
}

export async function loadAcpAgentRegistrations(): Promise<AcpAgentRegistration[]> {
  try {
    return await listAcpAgents();
  } catch {
    return [];
  }
}
