import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateToolRequiredArgs } from '../../src/tools/validate-tool-required-args.ts';

describe('validateToolRequiredArgs', () => {
  it('accepts literal replacement strings and rejects absent or non-string replacements', () => {
    const args = { path: 'file', search: 'remove' };
    for (const replace of ['', ' ', '\n']) assert.equal(validateToolRequiredArgs('replace_text_in_file', { ...args, replace }), null);
    for (const replace of [null, undefined, 0, false, {}]) assert.match(validateToolRequiredArgs('replace_text_in_file', { ...args, replace })!, /"replace"/);
  });
  it('returns null when required fields are present', () => {
    assert.equal(validateToolRequiredArgs('read_file', { path: 'src/foo.ts' }), null);
  });

  it('errors when path is missing for read_file', () => {
    const err = validateToolRequiredArgs('read_file', {});
    assert.ok(err);
    assert.match(err!, /requires argument.*"path"/);
  });

  it('errors when path is whitespace only', () => {
    const err = validateToolRequiredArgs('read_file', { path: '   ' });
    assert.ok(err);
    assert.match(err!, /"path"/);
  });

  it('ignores unknown tools', () => {
    assert.equal(validateToolRequiredArgs('not_a_real_tool', {}), null);
  });

  it('allows empty content for save_file (new empty file)', () => {
    assert.equal(
      validateToolRequiredArgs('save_file', { path: 'notes.txt', content: '' }),
      null,
    );
  });

  it('errors when content is missing for save_file', () => {
    const err = validateToolRequiredArgs('save_file', { path: 'notes.txt' });
    assert.ok(err);
    assert.match(err!, /"content"/);
  });
});
