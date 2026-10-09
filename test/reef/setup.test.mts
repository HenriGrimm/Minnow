import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_REEF_PALETTE, REEF_CUSTOM_VIBE, REEF_SETUP_STEPS, REEF_THEME_VIBE, REEF_VIBES, composeReefLook, suggestReefNames } from '../../src/reef/setup.ts';

test('Reef setup asks for the idea, then the name, then the look', () => {
  assert.deepEqual(REEF_SETUP_STEPS.map(step => step.id), ['idea', 'name', 'look']);
});

test('Reef name ideas come from the subject of the idea, not its verbs', () => {
  const names = suggestReefNames('Split a dinner bill between friends, with a tip percentage.');
  assert.deepEqual(names.slice(0, 3), ['Dinner Buddy', 'Tiny Bill', 'Friends Pal']);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.length >= 5);
  assert.ok(suggestReefNames('Make a timer').every(name => name.includes('Timer')));
  const fallback = suggestReefNames('a tool to help me');
  assert.ok(fallback.length >= 3);
  assert.ok(fallback.every(name => name.length > 0 && name.length <= 100));
});

test('Reef look joins the chosen vibe and the person’s own notes', () => {
  const cozy = REEF_VIBES.find(vibe => vibe.id === 'cozy')!;
  assert.equal(composeReefLook('cozy', '  big numbers '), `${cozy.look}\nbig numbers`);
  assert.equal(composeReefLook(null, 'neon'), 'neon');
  assert.equal(composeReefLook('missing', '  '), '');
  for (const vibe of REEF_VIBES) assert.equal(vibe.swatch.length, 3);
});

test('Reef look spells out a custom palette and the matched Minnow theme as hex', () => {
  assert.equal(composeReefLook(REEF_CUSTOM_VIBE, '', { palette: ['#112233', '#445566', '#778899'] }),
    'Use this color palette: background #112233, main #445566, highlight #778899.');
  assert.match(composeReefLook(REEF_CUSTOM_VIBE, ''), new RegExp(DEFAULT_REEF_PALETTE[0]));
  assert.equal(composeReefLook(REEF_THEME_VIBE, 'rounded', { theme: { scheme: 'dark', colors: { background: '#0e1116', accent: '#9cc7a4' } } }),
    'Match the Minnow app\'s current dark theme: background #0e1116, accent #9cc7a4.\nrounded');
  assert.equal(composeReefLook(REEF_THEME_VIBE, ''), 'Match the Minnow app\'s current theme.');
});
