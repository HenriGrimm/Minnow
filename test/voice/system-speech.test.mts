import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('system speech replaces playback, ignores stale events and stops on a second click', async () => {
  const dom = new Window();
  const keys = ['window', 'document', 'HTMLElement', 'SpeechSynthesisUtterance'] as const;
  const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let cancellations = 0;
  const utterances: FakeUtterance[] = [];
  const voice = { localService: true, default: true, voiceURI: 'local', name: 'Local' };
  class FakeUtterance {
    rate = 1; pitch = 1; volume = 1; voice: unknown;
    onend?: () => void;
    onerror?: () => void;
    constructor(public text: string) {}
  }
  Object.defineProperty(dom, 'speechSynthesis', { value: {
    cancel: () => { cancellations++; },
    getVoices: () => [voice],
    speak: (utterance: FakeUtterance) => utterances.push(utterance),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.document });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.HTMLElement });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: FakeUtterance });
  try {
    const { speakWithBrowser, playAssistantText } = await import('../../src/ui/voice-controls.ts');
    const first = dom.document.createElement('button') as unknown as HTMLButtonElement;
    const second = dom.document.createElement('button') as unknown as HTMLButtonElement;
    speakWithBrowser('First', '', 1, 1, 1, first);
    assert.equal(utterances[0].voice, voice);
    assert.equal(first.getAttribute('aria-label'), 'Stop reading');
    speakWithBrowser('Second', '', 1, 1, 1, second);
    assert.equal(first.getAttribute('aria-label'), 'Read aloud');
    utterances[0].onend?.();
    assert.equal(second.getAttribute('aria-label'), 'Stop reading');
    const before = cancellations;
    await playAssistantText('Second', second);
    assert.equal(cancellations, before + 1);
    assert.equal(second.getAttribute('aria-label'), 'Read aloud');
    assert.equal(utterances.length, 2);
  } finally {
    dom.close();
    for (const key of keys) {
      const descriptor = originals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
