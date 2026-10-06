import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePlanDependencies } from '../../server/orchestrator/core/plan-dependencies.js';

const task = (id, overrides = {}) => ({
  id, line: 10, build: '', test: '', accept: '', touches: [], dependsOn: [], ...overrides,
});

test('rejects a consumer of a file and exported type created in another isolated task', () => {
  const producer = task('W1-B', {
    build: 'CREATE `src/settings.ts`: export interface GameSettings { masterVolume: number }',
    touches: ['src/settings.ts'],
  });
  const consumer = task('W1-C', {
    build: 'Use GameSettings in src/game/audio.ts and import `src/settings.ts`.',
    touches: ['src/game/audio.ts'],
    line: 31,
  });
  assert.deepEqual(validatePlanDependencies([producer, consumer], ['src/game/audio.ts']), [{
    line: 31,
    column: 1,
    message: 'task W1-C uses work introduced by W1-B without depending on it',
    hint: 'add `- **Depends on:** W1-B` (or include W1-B in the existing list) so its files are merged before W1-C starts',
  }]);
});

test('accepts direct and transitive dependencies, existing files, and unrelated tasks', () => {
  const producer = task('W1-A', {
    build: 'CREATE `src/settings.ts`: export interface GameSettings {}',
    touches: ['src/settings.ts'],
  });
  const bridge = task('W1-B', { dependsOn: ['W1-A'] });
  const consumer = task('W2-A', {
    build: 'Import GameSettings from `src/settings.ts`.',
    dependsOn: ['W1-B'],
  });
  assert.deepEqual(validatePlanDependencies([producer, bridge, consumer], []), []);
  assert.deepEqual(validatePlanDependencies([
    producer, task('W2-B', { build: 'Read `src/settings.ts`.' }),
  ], ['src/settings.ts']), []);
  assert.deepEqual(validatePlanDependencies([
    producer, task('W2-C', { build: 'Modify `src/game/arena.ts`.' }),
  ], []), []);
});

test('recognizes a referenced created file even without an exported symbol', () => {
  const producer = task('W1-A', { touches: ['tests/setup.ts'] });
  const consumer = task('W1-B', { test: 'Use `tests/setup.ts` with the suite.' });
  assert.equal(validatePlanDependencies([producer, consumer], []).length, 1);
});

test('recognizes a created file covered by a producer glob and edited by the consumer', () => {
  const producer = task('W1-A', {
    build: 'CREATE `src/ui/panel.ts`.', touches: ['src/ui/**'],
  });
  const consumer = task('W1-B', {
    build: 'Modify `src/ui/panel.ts`.', touches: ['src/ui/panel.ts'],
  });
  assert.equal(validatePlanDependencies([producer, consumer], []).length, 1);
});

test('requires the task that adds an npm script used by another task', () => {
  const setup = task('W1-A', {
    build: 'Add scripts `"test": "vitest run"` and install vitest.',
    touches: ['package.json', 'package-lock.json'],
  });
  const audio = task('W1-C', { test: '`npm run test` passes.' });
  assert.equal(validatePlanDependencies([setup, audio], ['package.json']).length, 1);
});
