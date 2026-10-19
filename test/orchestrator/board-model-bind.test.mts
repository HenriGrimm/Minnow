import { DEFAULT_MODEL_STORAGE_KEY } from '../../src/models/selection.ts';
/**
 * Client seed: the board chip's menubar value becomes board.model.set.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { modelCache } from '../../src/api/models.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { ensureBoardModelBound } from '../../src/orchestrator/board-model-bind.ts';
import type { BoardState } from '../../server/orchestrator/core/types';

let activeWindow: Window | undefined;

function setupDom(selectValue: string): void {
  activeWindow?.close();
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: win.localStorage });
  localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, selectValue);
  const sel = document.createElement('select');
  sel.id = 'modelSelect';
  const opt = document.createElement('option');
  opt.value = selectValue;
  opt.textContent = 'Shown model';
  sel.appendChild(opt);
  document.body.appendChild(sel);
  sel.value = selectValue;
}

afterEach(() => {
  modelCache.clear();
  document.body.innerHTML = '';
  activeWindow?.close();
  activeWindow = undefined;
});

describe('ensureBoardModelBound', () => {
  test('unbound board + composite #modelSelect key POSTs that pair once', async () => {
    const key = encodeModelSelectKey('lmstudio', 'qwen/qwen3-8b');
    setupDom(key);
    /** @type {{ providerId: string, id: string }[]} */
    const posted = [];

    const ok = await ensureBoardModelBound({
      state: null,
      setModel: async (providerId, id) => {
        posted.push({ providerId, id });
      },
    });

    assert.equal(ok, true);
    assert.deepEqual(posted, [{ providerId: 'lmstudio', id: 'qwen/qwen3-8b' }]);
  });

  test('already-bound board does not POST again', async () => {
    const key = encodeModelSelectKey('lmstudio', 'qwen/qwen3-8b');
    setupDom(key);
    let calls = 0;

    const ok = await ensureBoardModelBound({
      state: {
        model: { providerId: 'anthropic', id: 'claude-opus-5', reasoning: null },
      } as BoardState,
      setModel: async () => {
        calls += 1;
      },
    });

    assert.equal(ok, true);
    assert.equal(calls, 0);
  });
});
