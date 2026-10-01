import { isAgentCliProviderId } from '../models/runtime-ids.mjs';
import { getActiveChat } from '../state/sessions';
import { resolveEffectiveChatModelBinding } from './default-model';
import { isMainColumnOverlaySuppressingChatDom } from './main-column-overlay';
import { StreamEventSource } from '../api/stream-event-source';
import { withSessionToken } from '../api/session-token';

interface CliCapture {
  providerId: string;
  modelId: string;
  output: string;
  status: 'running' | 'exited';
  version: number;
  exitCode?: number | null;
}

interface CliSurface {
  host: HTMLElement;
  button: HTMLButtonElement;
  pane: HTMLElement;
  output: HTMLElement;
  status: HTMLElement;
  transcript: HTMLElement;
}

const surfaces: CliSurface[] = [];
let showingCli = false;
let outputStream: StreamEventSource | null = null;
let requestId = 0;
let lastKey = '';
let lastVersion = -1;

function activeBinding(): { chatId: string; providerId: string } | null {
  try {
    const chat = getActiveChat();
    const { providerId } = resolveEffectiveChatModelBinding(chat);
    return isAgentCliProviderId(providerId) ? { chatId: chat.id, providerId: providerId! } : null;
  } catch {
    return null;
  }
}

function buildSurface(host: HTMLElement, transcript: HTMLElement, app: boolean): CliSurface {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `agent-cli-view-toggle${app ? ' agent-cli-view-toggle--app' : ''}`;
  button.setAttribute('aria-pressed', 'false');
  button.textContent = 'CLI';
  button.title = 'Show agent CLI output';
  button.setAttribute('aria-label', 'Show agent CLI output');
  const pane = document.createElement('section');
  pane.className = 'agent-cli-view';
  pane.setAttribute('aria-label', 'Agent CLI output');
  pane.hidden = true;
  const status = document.createElement('div');
  status.className = 'agent-cli-view__status';
  status.textContent = 'Waiting for CLI output';
  const output = document.createElement('pre');
  output.className = 'agent-cli-view__output';
  output.tabIndex = 0;
  output.textContent = 'Send a message to start the agent CLI.';
  pane.append(status, output);
  host.append(pane, button);
  button.addEventListener('click', () => {
    showingCli = !showingCli;
    if (showingCli) lastVersion = -1;
    syncAgentCliView();
    if (showingCli) {
      void refreshAgentCliOutput();
      output.focus();
    }
  });
  return { host, button, pane, output, status, transcript };
}

async function refreshAgentCliOutput(): Promise<void> {
  const binding = activeBinding();
  if (!showingCli || !binding || document.hidden || outputStream) return;
  const key = `${binding.chatId}\0${binding.providerId}`;
  const currentRequest = ++requestId;
  let retained: CliCapture | null = null;
  outputStream = new StreamEventSource(withSessionToken(`/api/generations/agent-cli-output/stream?chatId=${encodeURIComponent(binding.chatId)}`));
  outputStream.onmessage = (event: MessageEvent) => {
    try {
      const body = JSON.parse(event.data) as { snapshot?: CliCapture | null; delta?: string } & Partial<CliCapture>;
      if (currentRequest !== requestId || !showingCli || key !== lastKey) return;
      if ('snapshot' in body) retained = body.snapshot?.providerId === binding.providerId ? body.snapshot : null;
      else if (body.providerId === binding.providerId && retained && (body.version ?? -1) > lastVersion) {
        retained = { ...retained, ...body, output: `${retained.output}${body.delta ?? ''}`.slice(-256 * 1024) };
      } else return;
      const capture = retained;
      lastVersion = capture?.version ?? -1;
      for (const surface of surfaces) {
        const pinned = surface.output.clientHeight === 0
          || surface.output.scrollTop + surface.output.clientHeight >= surface.output.scrollHeight - 24;
        surface.status.textContent = capture
          ? `${capture.providerId} · ${capture.status === 'running' ? 'Running' : `Exited${capture.exitCode == null ? '' : ` (${capture.exitCode})`}`}`
          : `${binding.providerId} · No process yet`;
        const next = capture?.output || 'Send a message to start the agent CLI.';
        if (surface.output.textContent !== next) {
          if (!('snapshot' in body) && capture && surface.output.textContent !== 'Send a message to start the agent CLI.') {
            surface.output.append(document.createTextNode(body.delta ?? ''));
            let extra = (surface.output.textContent?.length ?? 0) - 256 * 1024;
            while (extra > 0 && surface.output.firstChild) {
              const node = surface.output.firstChild;
              const length = node.textContent?.length ?? 0;
              if (length <= extra) { node.remove(); extra -= length; }
              else { node.textContent = node.textContent!.slice(extra); extra = 0; }
            }
          } else surface.output.textContent = next;
          if (pinned) surface.output.scrollTop = surface.output.scrollHeight;
        }
      }
    } catch {
      if (currentRequest !== requestId || !showingCli) return;
      for (const surface of surfaces) surface.status.textContent = 'CLI output unavailable';
    }
  };
  outputStream.onerror = () => {
    if (currentRequest === requestId && showingCli) for (const surface of surfaces) surface.status.textContent = 'Reconnecting to CLI output…';
  };
}

export function syncAgentCliView(): void {
  const binding = isMainColumnOverlaySuppressingChatDom() ? null : activeBinding();
  const key = binding ? `${binding.chatId}\0${binding.providerId}` : '';
  if (key !== lastKey) {
    lastKey = key;
    showingCli = false;
    lastVersion = -1;
    requestId += 1;
    outputStream?.close(); outputStream = null;
  }
  for (const surface of surfaces) {
    surface.button.hidden = !binding;
    surface.button.textContent = showingCli ? 'Chat' : 'CLI';
    surface.button.setAttribute('aria-pressed', showingCli ? 'true' : 'false');
    const label = showingCli ? 'Show chat transcript' : 'Show agent CLI output';
    surface.button.setAttribute('aria-label', label);
    surface.button.title = label;
    surface.pane.hidden = !showingCli;
    surface.transcript.hidden = showingCli;
    surface.host.classList.toggle('agent-cli-view-open', showingCli);
  }
  if (!showingCli || !binding || document.hidden) { outputStream?.close(); outputStream = null; requestId += 1; }
  else void refreshAgentCliOutput();
}

export function initAgentCliView(): void {
  if (surfaces.length) return;
  const code = document.querySelector<HTMLElement>('#mainColumn > .chat-viewport');
  const codeTranscript = document.getElementById('chatArea');
  if (code && codeTranscript) surfaces.push(buildSurface(code, codeTranscript, false));
  const appTop = document.querySelector<HTMLElement>('.chat-app-top');
  const appViewport = document.querySelector<HTMLElement>('.chat-app-viewport');
  const appTranscript = document.getElementById('chatAppArea');
  if (appTop && appViewport && appTranscript) {
    const surface = buildSurface(appViewport, appTranscript, true);
    appTop.appendChild(surface.button);
    surfaces.push(surface);
  }
  document.addEventListener('visibilitychange', () => {
    syncAgentCliView();
  });
  syncAgentCliView();
}
