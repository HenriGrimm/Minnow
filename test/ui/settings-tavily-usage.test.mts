import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { appendTavilyUsageSettings } from '../../src/ui/settings-tavily-usage.ts';

afterEach(() => mock.restoreAll());

function mount() {
  const win = new Window();
  Object.assign(globalThis, { document: win.document });
  const content = document.createElement('div');
  document.body.append(content);
  return { content, win };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const usage = (credits: number) => ({ key: { usage: credits, limit: 100, search_usage: credits },
  account: { current_plan: 'Free', plan_usage: 80, plan_limit: 1000, paygo_usage: null, paygo_limit: null },
  fetchedAt: '2026-10-07T12:00:00Z' });

test('Missing key and offline states do not fetch; usage distinguishes key and account', async () => {
  const { content } = mount();
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json(usage(15)));
  const ui = appendTavilyUsageSettings(content, true);
  ui.setSavedKey('');
  assert.match(content.textContent!, /Add and save/);
  assert.equal(fetchMock.mock.callCount(), 0);
  ui.setSavedKey('saved-key');
  await tick();
  assert.match(content.textContent!, /Saved key usage15 \/ 100 credits/);
  assert.match(content.textContent!, /Account plan usage80 \/ 1,000 credits/);
  assert.match(content.textContent!, /Unavailable/);
  assert.match(content.textContent!, /outside Minnow/);
  assert.match(content.textContent!, /Last refreshed/);
  const offline = appendTavilyUsageSettings(content, false);
  offline.setSavedKey('saved-key');
  assert.match(content.textContent!, /restart Minnow/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('Refresh updates usage and preserves the previous reading on errors', async () => {
  const { content, win } = mount();
  let calls = 0;
  mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    if (calls > 1) assert.match(String(url), /refresh=1/);
    return calls < 3 ? Response.json(usage(calls * 10)) : Response.json({ error: 'Invalid Tavily API key' }, { status: 502 });
  });
  const ui = appendTavilyUsageSettings(content, true);
  ui.setSavedKey('saved-key');
  await tick();
  const refresh = content.querySelector<HTMLButtonElement>('button')!;
  refresh.dispatchEvent(new win.Event('click') as unknown as Event);
  await tick();
  assert.match(content.textContent!, /20 \/ 100/);
  refresh.dispatchEvent(new win.Event('click') as unknown as Event);
  await tick();
  assert.match(content.textContent!, /Invalid Tavily API key/);
  assert.match(content.textContent!, /previously refreshed/);
  assert.match(content.textContent!, /20 \/ 100/);
  assert.equal(refresh.disabled, false);
});

test('Changing or removing the key discards old responses', async () => {
  const { content } = mount();
  let resolveOld!: (response: Response) => void;
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? new Promise<Response>((resolve) => { resolveOld = resolve; })
    : Response.json(usage(30)));
  const ui = appendTavilyUsageSettings(content, true);
  ui.setSavedKey('old-key');
  ui.setSavedKey('new-key');
  await tick();
  resolveOld(Response.json(usage(99)));
  await tick();
  assert.match(content.textContent!, /30 \/ 100/);
  assert.doesNotMatch(content.textContent!, /99 \/ 100/);
  ui.setSavedKey('');
  assert.doesNotMatch(content.textContent!, /30 \/ 100/);
  assert.equal(content.querySelector<HTMLButtonElement>('button')!.disabled, true);
});
