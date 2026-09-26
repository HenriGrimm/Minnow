/**
 * Models header status distinguishes the local runtime from default/chat model bindings.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveModelsRuntimeHeaderStatus } from '../../src/ui/models/store.ts';

type RuntimeSnapshot = Parameters<typeof resolveModelsRuntimeHeaderStatus>[0];

function status(
  serves: Array<Record<string, unknown>> = [],
  loads: Array<Record<string, unknown>> = [],
) {
  return resolveModelsRuntimeHeaderStatus({ serves, loads } as RuntimeSnapshot);
}

describe('Models local runtime header status', () => {
  test('names the stopped local runtime instead of implying no model is selected', () => {
    assert.deepEqual(status(), {
      tone: 'stopped',
      label: 'Local runtime: stopped',
    });
  });

  test('names a running model and endpoint as local runtime state', () => {
    assert.deepEqual(
      status([
        {
          status: 'running',
          modelLabel: 'Qwen 2.5 7B',
          baseUrl: 'http://127.0.0.1:1234',
        },
      ]),
      {
        tone: 'running',
        label: 'Local runtime: Qwen 2.5 7B · http://127.0.0.1:1234',
      },
    );
  });

  test('keeps load progress and failure scoped to the local runtime', () => {
    assert.deepEqual(status([], [{ percent: 42, error: null }]), {
      tone: 'starting',
      label: 'Local runtime: Loading 42%',
    });
    assert.deepEqual(status([], [{ percent: null, error: 'Out of memory' }]), {
      tone: 'error',
      label: 'Local runtime: model load failed',
    });
  });
});
