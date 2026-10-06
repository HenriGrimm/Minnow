/**
 * P4-F — V2 BoardState autonomy is a status enum plus a concurrency integer.
 *
 * PRD §6 deleted the leftover multi-flag blob. Those names must not appear on
 * the derived state. This test lists the live BoardState keys so a third
 * autonomy field cannot sneak in.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  DEFAULT_BOARD_CONCURRENCY,
  emptyState,
} from '../../server/orchestrator/core/derive.js';
import { stateToJSON } from '../../server/orchestrator/core/snapshot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const BOARD_STATE_KEYS = [
  'boardId',
  'name',
  'planPath',
  'workspacePath',
  'baseBranch',
  'waves',
  'status',
  'concurrency',
  'tasks',
  'taskOrder',
  'mergeQueue',
  'integrationSha',
  'model',
  'finalTest',
  'finished',
  'stopReason',
  'runSummary',
  'rerun',
];

const AUTONOMY_KEYS = ['status', 'concurrency'];

describe('V2 BoardState autonomy shape', () => {
  it('is status + concurrency, and those are the only autonomy fields', () => {
    const state = emptyState();
    assert.equal(state.status, 'created');
    assert.equal(typeof state.concurrency, 'number');
    assert.equal(state.concurrency, 1);
    assert.equal(DEFAULT_BOARD_CONCURRENCY, 2);

    const keys = Object.keys(state).sort();
    assert.deepEqual(keys, [...BOARD_STATE_KEYS].sort());
    assert.deepEqual(
      keys.filter((key) => AUTONOMY_KEYS.includes(key)),
      [...AUTONOMY_KEYS].sort(),
    );

    const json = /** @type {Record<string, unknown>} */ (stateToJSON(state));
    assert.ok(['created', 'running', 'stopped'].includes(String(json.status)));
    assert.equal(typeof json.concurrency, 'number');
    assert.equal(Object.hasOwn(json, 'status'), true);
    assert.equal(Object.hasOwn(json, 'concurrency'), true);
  });

  it('declares status and concurrency on BoardState in types.d.ts', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'server', 'orchestrator', 'core', 'types.d.ts'),
      'utf8',
    );
    const start = src.indexOf('export interface BoardState');
    assert.ok(start >= 0);
    const next = src.indexOf('export interface', start + 'export interface BoardState'.length);
    const body = src.slice(start, next === -1 ? undefined : next).replace(/\/\*\*[\s\S]*?\*\//g, '');
    assert.match(body, /status:\s*BoardStatus/);
    assert.match(body, /concurrency:\s*number/);
    const fieldNames = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    const autonomy = fieldNames.filter((name) => AUTONOMY_KEYS.includes(name));
    assert.deepEqual(autonomy, AUTONOMY_KEYS);
  });

  it('V2 board UI has Running / Stopped controls', () => {
    const render = fs.readFileSync(
      path.join(ROOT, 'src', 'orchestrator', 'board-render.ts'),
      'utf8',
    );
    assert.match(render, /label: 'Running'/);
    assert.match(render, /label: 'Stopped'/);
    const view = fs.readFileSync(path.join(ROOT, 'src', 'orchestrator', 'boards-view.ts'), 'utf8');
    assert.match(view, /textContent = running \? 'Stop'/);
    assert.match(view, /renderConcurrencyControl/);
  });
});
