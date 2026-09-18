import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type {
  LlamaEngineBuildJob,
  LlamaEnginesView,
  LlamaRuntimeStatus,
} from '../../src/models/api-client.ts';
import type { ManagedServerSummary } from '../../src/servers/client.ts';

const MLX_UNSUPPORTED: ManagedServerSummary = {
  id: 'mlx-lm',
  label: 'MLX',
  description: 'Metal-native inference for MLX weights on Apple Silicon (mlx-lm).',
  kind: 'python-venv',
  healthPath: '/v1/models',
  enabled: false,
  autoStart: false,
  port: 8087,
  defaultPort: 8087,
  installed: false,
  running: false,
  phase: 'pending',
  job: null,
  supported: false,
  installable: false,
  reason:
    'MLX runs only on Apple Silicon Macs (macOS 13 or later). Use GGUF weights with llama.cpp on this machine.',
};

const UPGRADE_RUNTIME: LlamaRuntimeStatus = {
  path: 'C:\\Users\\me\\.minnow\\models-runtime\\llama-cpp\\llama-server.exe',
  source: 'managed',
  variant: 'cpu',
  version: 'b9628',
  pinnedVersion: 'b10448',
  installedVersion: 'b9628',
  upgradeAvailable: true,
  assetNames: [],
  installedAt: '2020-01-01T00:00:00.000Z',
  installable: true,
  gpuCapable: false,
  preferredVariant: 'cpu',
  installableVariants: ['cpu', 'vulkan'],
  engineId: 'upstream',
  engineLabel: 'llama.cpp',
};

function enginesView(overrides: Partial<LlamaEnginesView> = {}): LlamaEnginesView {
  return {
    active: 'upstream',
    build: null,
    engines: [
      {
        id: 'upstream',
        label: 'llama.cpp',
        description: 'The official ggml-org build, pinned and downloaded by Minnow.',
        kind: 'upstream',
        origin: 'approved',
        installed: true,
        binaryPath: UPGRADE_RUNTIME.path,
        supported: true,
        unsupportedReason: null,
      },
      {
        id: 'turbo3',
        label: 'TurboQuant (turbo3-cuda)',
        description: 'TurboQuant KV cache compression.',
        kind: 'fork',
        origin: 'approved',
        source: 'github',
        repo: 'Madreag/turbo3-cuda',
        branch: 'release/cuda-optimized',
        homepage: 'https://github.com/Madreag/turbo3-cuda',
        backend: 'cuda',
        minCudaSm: 86,
        cmakeFlags: [],
        binaryPath: null,
        installed: false,
        pinnedSha: '369a73549d9862c47981fe51bb2c5dd3cd2bab7e',
        commitsBehind: 3,
        supported: true,
        unsupportedReason: null,
        prereqs: {
          ok: false,
          missing: [{ tool: 'CUDA Toolkit', hint: 'Install it.', url: 'https://developer.nvidia.com/cuda-downloads' }],
        },
        kvCacheTypes: ['turbo3'],
        asymmetricKv: true,
      },
    ],
    ...overrides,
  };
}

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeEventSource.last = this;
  }
  emit(job: LlamaEngineBuildJob): void {
    this.onmessage?.({ data: JSON.stringify(job) } as MessageEvent);
  }
  close(): void {}
}

const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

async function waitFor(check: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the engine panel');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Models → Engine panel', () => {
  let originalFetch: typeof fetch;
  let view: LlamaEnginesView;
  let requests: Array<{ url: string; method: string; body?: string }>;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    Object.assign(globalThis, { EventSource: FakeEventSource, CSS: { escape: (s: string) => s } });
    document.body.innerHTML = '<div id="modelsEngineBody"></div>';

    view = enginesView();
    requests = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === '/api/models/llama-engines' && method === 'GET') return json(view);
      if (url === '/api/models/llama-engines/active' && method === 'PUT') {
        view = { ...view, active: JSON.parse(String(init?.body)).id };
        return json(view);
      }
      if (url === '/api/models/llama-runtime') return json(UPGRADE_RUNTIME);
      if (url === '/api/models/serve') return json({ serves: [] });
      if (url === '/api/servers') return json({ servers: [MLX_UNSUPPORTED] });
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;
  });

  afterEach(async () => {
    const { teardownEngineSection } = await import('../../src/ui/models/engine-panel.ts');
    teardownEngineSection();
    globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
  });

  test('lists upstream and turbo3, with the upstream upgrade and the missing CUDA toolkit', async () => {
    const { mountEngineSection } = await import('../../src/ui/models/engine-panel.ts');
    await mountEngineSection();

    const upstream = document.querySelector<HTMLElement>('[data-engine-id="upstream"]');
    const turbo = document.querySelector<HTMLElement>('[data-engine-id="turbo3"]');
    assert.ok(upstream && turbo);

    assert.equal(upstream.querySelector<HTMLButtonElement>('[data-llama-install="upstream"]')?.textContent, 'Upgrade');
    assert.match(upstream.textContent ?? '', /b10448/);
    assert.match(upstream.textContent ?? '', /In use/);

    // Not built: cannot be selected, shows the missing tool, Build disabled until it is installed.
    const turboRadio = turbo.querySelector<HTMLInputElement>('input[type="radio"]');
    assert.equal(turboRadio?.disabled, true);
    assert.match(turbo.textContent ?? '', /CUDA Toolkit/);
    assert.match(turbo.textContent ?? '', /SM 8\.6\+/);
    assert.match(turbo.textContent ?? '', /3 newer commits on release\/cuda-optimized/);
    const build = [...turbo.querySelectorAll('button')].find((b) => b.textContent === 'Build');
    assert.equal(build?.disabled, true);
  });

  test('opens build prerequisite links in the system browser inside Electron', async () => {
    const opened: string[] = [];
    Object.assign(window, {
      minnow: {
        app: {
          openExternal: async (url: string) => {
            opened.push(url);
          },
        },
      },
    });

    const { mountEngineSection } = await import('../../src/ui/models/engine-panel.ts');
    await mountEngineSection();

    const link = document.querySelector<HTMLAnchorElement>(
      '[data-engine-id="turbo3"] .models-engine__prereq-list a',
    );
    assert.ok(link);
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    assert.equal(click.defaultPrevented, true);
    assert.deepEqual(opened, ['https://developer.nvidia.com/cuda-downloads']);
  });

  test('shows the MLX unsupported reason with no Install button', async () => {
    const { mountEngineSection } = await import('../../src/ui/models/engine-panel.ts');
    await mountEngineSection();

    const mlx = document.getElementById('modelsEngineMlx');
    assert.ok(mlx);
    assert.equal(mlx.querySelector('[data-server-install="mlx-lm"]'), null);
    assert.match(mlx.querySelector('[data-server-install-reason="mlx-lm"]')?.textContent ?? '', /Apple Silicon/);
  });

  test('selecting a built fork makes it active', async () => {
    const built = enginesView();
    const turbo = built.engines[1];
    Object.assign(turbo, {
      installed: true,
      installedSha: turbo.pinnedSha,
      prereqs: { ok: true, missing: [] },
      binaryPath: 'C:\\turbo\\llama-server.exe',
    });
    view = built;

    const { mountEngineSection } = await import('../../src/ui/models/engine-panel.ts');
    await mountEngineSection();

    const radio = document.querySelector<HTMLInputElement>('[data-engine-id="turbo3"] input[type="radio"]');
    assert.ok(radio && !radio.disabled);
    radio.checked = true;
    radio.dispatchEvent(new window.Event('change'));

    await waitFor(() =>
      Boolean(document.querySelector('[data-engine-id="turbo3"]')?.classList.contains('is-active')),
    );
    const put = requests.find((r) => r.method === 'PUT');
    assert.deepEqual(JSON.parse(put?.body ?? '{}'), { id: 'turbo3' });
  });

  test('streams build progress into the fork card', async () => {
    const built = enginesView();
    built.engines[1].prereqs = { ok: true, missing: [] };
    view = built;

    const { mountEngineSection } = await import('../../src/ui/models/engine-panel.ts');
    await mountEngineSection();
    assert.ok(FakeEventSource.last);

    FakeEventSource.last.emit({
      engineId: 'turbo3',
      phase: 'building',
      percent: 40,
      message: 'Compiling llama-server',
      error: null,
      logTail: ['[ 10%] Building CUDA object fattn.cu.o'],
      sha: '369a73549d9862c47981fe51bb2c5dd3cd2bab7e',
      startedAt: Date.now(),
    });
    const card = document.querySelector<HTMLElement>('[data-engine-id="turbo3"]');
    const panel = card?.querySelector<HTMLElement>('[data-build-panel="turbo3"]');
    assert.ok(panel);
    assert.match(panel.textContent ?? '', /Compiling llama-server/);
    assert.match(panel.textContent ?? '', /fattn\.cu\.o/);
    assert.ok([...(card?.querySelectorAll('button') ?? [])].some((b) => b.textContent === 'Cancel build'));

    // A second tick patches the same panel in place (log scroll survives).
    FakeEventSource.last.emit({
      engineId: 'turbo3',
      phase: 'building',
      percent: 60,
      message: 'Compiling llama-server',
      error: null,
      logTail: ['[ 10%] Building CUDA object fattn.cu.o', '[ 60%] Linking llama-server'],
      sha: '369a73549d9862c47981fe51bb2c5dd3cd2bab7e',
      startedAt: Date.now(),
    });
    assert.equal(card?.querySelector('[data-build-panel="turbo3"]'), panel);
    assert.match(panel.textContent ?? '', /Linking llama-server/);
  });
});
