/**
 * llama-server log parsing — progress, severity, and load phase.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyLogLine,
  describeLoadPhase,
  foldServeLogEvent,
  matchServeLoadPhase,
  parseLoadProgress,
  toLogLines,
} from '../../src/models/serve-log.ts';

describe('parseLoadProgress', () => {
  test('reads a percentage the runtime printed', () => {
    assert.equal(parseLoadProgress('load_tensors: loading model, progress = 9.17 %'), 9.17);
  });

  test('reads the fractional form', () => {
    assert.equal(parseLoadProgress('progress = 0.25'), 25);
  });

  test('takes the most recent value', () => {
    const log = ['loading 10.00 %', 'loading 42.50 %'].join('\n');
    assert.equal(parseLoadProgress(log), 42.5);
  });

  test('returns null rather than inventing a number', () => {
    assert.equal(parseLoadProgress('llama_model_loader: loaded meta data'), null);
    assert.equal(parseLoadProgress(''), null);
  });

  test('rejects out-of-range values', () => {
    assert.equal(parseLoadProgress('loading 480 %'), null);
  });

  test('does not treat tokenizer or jinja `{%` as a load percent', () => {
    assert.equal(
      parseLoadProgress('llama_model_loader: - kv  12: tokenizer.chat_template str = {%- if tools %}'),
      null,
    );
    assert.equal(parseLoadProgress('{%- set x = 35 %}\n{% endif %}'), null);
  });
});

describe('classifyLogLine', () => {
  test('tags severities', () => {
    assert.equal(classifyLogLine('[ERROR] failed to load model'), 'error');
    assert.equal(classifyLogLine('warning: deprecated flag'), 'warn');
    assert.equal(classifyLogLine('[DEBUG] slot state'), 'debug');
    assert.equal(classifyLogLine('server is listening on port 8085'), 'info');
    assert.equal(classifyLogLine('....'), 'plain');
  });
});

describe('describeLoadPhase', () => {
  test('names the phase the log is in', () => {
    assert.equal(describeLoadPhase(''), 'Starting runtime');
    assert.equal(describeLoadPhase('load_tensors: loading model tensors'), 'Loading weights');
    assert.equal(describeLoadPhase('llama_kv_cache: size = 512.00 MiB'), 'Allocating context');
    assert.equal(describeLoadPhase('clip_model_loader: model name:   Qwen3.8-27B'), 'Warming up');
    assert.equal(describeLoadPhase('main: server is listening'), 'Starting the server');
  });

  test('exposes the same phase as a keyed band, so labels and the bar cannot drift', () => {
    const weights = matchServeLoadPhase('load_tensors: loading model tensors');
    assert.equal(weights.key, 'weights');
    assert.equal(weights.label, describeLoadPhase('load_tensors: loading model tensors'));
    assert.ok(weights.ceiling > weights.floor);
  });

  test('the furthest phase in the log wins, not the last line', () => {
    // A real b9628 load reaches "listening" but keeps printing slot lines after it.
    const log = [
      'common_init_result: fitting params to device memory ...',
      'load_tensors: loading model tensors, this can take a while...',
      'srv  llama_server: server is listening on http://127.0.0.1:8085',
      'srv  update_slots: all slots are idle',
    ].join('\n');
    assert.equal(matchServeLoadPhase(log).key, 'listening');
  });
});

describe('foldServeLogEvent', () => {
  test('replaces on the initial tail, then appends deltas', () => {
    const afterTail = foldServeLogEvent('', {
      text: 'load_tensors: loading model tensors\n',
      initial: true,
    });
    assert.equal(afterTail, 'load_tensors: loading model tensors\n');
    const afterDots = foldServeLogEvent(afterTail, { text: '....' });
    assert.equal(afterDots, 'load_tensors: loading model tensors\n....');
  });

  test('an initial event after a reconnect replaces, it does not double the tail', () => {
    const folded = foldServeLogEvent('stale buffer', {
      text: 'llama_kv_cache: size = 512.00 MiB\n',
      initial: true,
    });
    assert.equal(folded, 'llama_kv_cache: size = 512.00 MiB\n');
  });
});

describe('toLogLines', () => {
  test('caps history so a long-running server cannot grow the DOM forever', () => {
    const text = Array.from({ length: 800 }, (_, i) => `line ${i}`).join('\n');
    const lines = toLogLines(text, 100);
    assert.equal(lines.length, 100);
    assert.equal(lines.at(-1), 'line 799');
  });

  test('keeps the full log including idle messages, blank lines and partial tokens', () => {
    const idle = 'srv  update_slots: all slots are idle';
    const real = Array.from({ length: 20 }, (_, i) => `I srv real ${i}`);
    const text = [...real, ...Array.from({ length: 80 }, () => idle)].join('\n');
    const lines = toLogLines(text);
    assert.equal(lines.length, 100);
    assert.equal(lines.at(-1), idle);
    assert.deepEqual(toLogLines('next token: hello\n\npart'), ['next token: hello', '', 'part']);
    assert.equal(toLogLines(Array.from({ length: 800 }, () => 'token').join('\n')).length, 800);
  });
});
