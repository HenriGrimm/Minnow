/**
 * Code-map focus hint extraction. Terms order the injected map; they never
 * filter it, so a weak hint costs nothing and an empty list is a valid answer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractCodeMapFocusHints } from '../../../src/brain/code-map-focus.ts';

describe('extractCodeMapFocusHints', () => {
  it('collects attachment paths and path-like tokens from the message', () => {
    const hints = extractCodeMapFocusHints(
      'Fix bug in server/simulation/tick.ts — executeDay churn',
      ['src/components/Dashboard.tsx'],
    );
    assert.deepEqual(hints.focus, [
      'src/components/Dashboard.tsx',
      'server/simulation/tick.ts',
      'executeDay',
    ]);
  });

  it('keeps a single hinted path', () => {
    const hints = extractCodeMapFocusHints('bug in server/simulation/tick.ts', []);
    assert.deepEqual(hints.focus, ['server/simulation/tick.ts']);
  });

  it('picks up lowerCamelCase identifiers, not just PascalCase', () => {
    const hints = extractCodeMapFocusHints('why does getWorkspacePath return null?', []);
    assert.deepEqual(hints.focus, ['getWorkspacePath']);
  });

  it('returns no terms for prose with no identifier or path', () => {
    const hints = extractCodeMapFocusHints(
      'Please review the simulation and orchestrator wiring',
      [],
    );
    assert.deepEqual(hints.focus, []);
  });

  it('caps the term list', () => {
    const hints = extractCodeMapFocusHints(
      'oneThing twoThing threeThing fourThing fiveThing sixThing sevenThing eightThing nineThing',
      [],
    );
    assert.equal(hints.focus.length, 8);
  });
});
