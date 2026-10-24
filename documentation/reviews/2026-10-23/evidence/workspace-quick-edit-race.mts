// Review-only reproduction. Run from the repository root:
// node --experimental-test-module-mocks --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/workspace-quick-edit-race.mts
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Window } from 'happy-dom';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document });
const requests: Array<{ input: any; resolve: (value: any) => void }> = [];
mock.module(new URL('../../../../src/tools/client.ts', import.meta.url).href, {
  namedExports: { getLocalServerAvailable: () => true },
});
mock.module(new URL('../../../../src/ui/editor-quick-edit/client.ts', import.meta.url).href, {
  namedExports: {
    fetchQuickEditReplacement: async (input: any) => new Promise((resolve) => {
      requests.push({ input, resolve });
      input.signal.addEventListener('abort', () => resolve({ text: null }), { once: true });
    }),
  },
});
const { openQuickEditPanel, closeQuickEditPanel } = await import('../../../../src/ui/editor-quick-edit/panel.ts');
const view = (text: string): any => ({
  state: { selection: { main: { empty: false, from: 0, to: text.length } },
    doc: { sliceString: () => text, lineAt: () => ({ number: 1 }) } },
  coordsAtPos: () => ({ left: 10, bottom: 10 }),
});
openQuickEditPanel(view('aaa'), 'a.ts');
openQuickEditPanel(view('bbb'), 'b.ts');
requests[1].input.onPartial('B replacement still streaming');
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
const accept = document.querySelector<HTMLButtonElement>('.editor-quick-edit-btn--accept')!;
assert.equal(requests[1].input.signal.aborted, false);
assert.equal(accept.disabled, false, 'Current bug: old aborted request enables Accept for the new unfinished request');
console.log(JSON.stringify({ oldRequestAborted: requests[0].input.signal.aborted,
  newRequestStillPending: true, acceptEnabled: !accept.disabled }));
closeQuickEditPanel();
dom.close();
process.exit(0);
