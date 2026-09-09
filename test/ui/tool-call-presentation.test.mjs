/**
 * Per-tool row presentation: action word, target, outcome measurement, structured bodies.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  buildToolRow,
  buildToolArgFields,
  buildFriendlyToolBody,
  describeToolFailure,
  extractProcessStdout,
  getToolAction,
  getToolIcon,
} = await import('../../src/ui/tool-call-presentation.ts');

describe('buildToolRow', () => {
  test('list_directory shows the path while running, no outcome yet', () => {
    const row = buildToolRow('list_directory', { path: 'documentation/plans' }, 'running');
    assert.equal(row.action, 'List');
    assert.equal(row.target, 'documentation/plans');
    assert.equal(row.targetKind, 'path');
    assert.equal(row.outcome, undefined);
  });

  test('list_directory counts entries with correct plurals', () => {
    const row = buildToolRow(
      'list_directory',
      { path: 'docs' },
      'done',
      '[dir] plans\n[file] a.md\n[file] b.md',
    );
    assert.equal(row.outcome, '1 folder · 2 files');
  });

  test('empty directory reads as empty, not "0 files"', () => {
    const row = buildToolRow('list_directory', { path: '.' }, 'done', '(empty directory)');
    assert.equal(row.target, 'workspace root');
    assert.equal(row.outcome, 'empty');
  });

  test('read_file measures lines', () => {
    const row = buildToolRow('read_file', { path: 'a/b/c.ts' }, 'done', 'one\ntwo\nthree\n');
    assert.equal(row.action, 'Read');
    assert.equal(row.target, 'a/b/c.ts');
    assert.equal(row.outcome, '3 lines');
  });

  test('read_file_range folds the line range into the target', () => {
    const row = buildToolRow(
      'read_file_range',
      { path: 'src/app.ts', start_line: 10, end_line: 20 },
      'running',
    );
    assert.equal(row.target, 'src/app.ts:10-20');
  });

  test('execute_command reports the exit code', () => {
    const row = buildToolRow(
      'execute_command',
      { command: 'npm test' },
      'done',
      'npm test (exit 0)\n\nstdout:\nok',
    );
    assert.equal(row.action, 'Run');
    assert.equal(row.target, 'npm test');
    assert.equal(row.targetKind, 'code');
    assert.equal(row.outcome, 'exit 0');
  });

  test('git_log counts commits from the stdout wrapper', () => {
    const result =
      'git log --oneline -n 5 (exit 0)\n\nstdout:\nc00ee39 docs: wave checklist\na1b2c3d fix: thing';
    assert.equal(buildToolRow('git_log', { count: 5 }, 'done', result).outcome, '2 commits');
  });

  test('git_status summarizes the working tree', () => {
    const result = '## main\n M src/a.ts\n?? src/b.ts';
    assert.equal(
      buildToolRow('git_status', {}, 'done', result).outcome,
      '1 modified · 1 untracked',
    );
  });

  test('git_status on a clean tree says clean', () => {
    assert.equal(buildToolRow('git_status', {}, 'done', '## main').outcome, 'clean');
  });

  test('grep counts matches and files', () => {
    const result = 'src/a.ts:12:const x = 1\nsrc/a.ts:40:const y = 2\nsrc/b.ts:3:const z = 3';
    const row = buildToolRow('grep', { pattern: 'const' }, 'done', result);
    assert.equal(row.target, 'const');
    assert.equal(row.outcome, '3 matches · 2 files');
  });

  test('grep with no hits says so instead of showing the sentence', () => {
    const row = buildToolRow('grep', { pattern: 'zzz' }, 'done', 'No matches for "zzz" under src');
    assert.equal(row.outcome, 'no matches');
  });

  test('find_files counts paths', () => {
    const row = buildToolRow('find_files', { pattern: '**/*.ts' }, 'done', 'a.ts\nb.ts');
    assert.equal(row.outcome, '2 files');
  });

  test('ask_question shows the prompt, never raw JSON', () => {
    const args = {
      questions: [{ id: 'q', prompt: 'Ask a few clarifying questions?', options: [] }],
    };
    const row = buildToolRow('ask_question', args, 'running');
    assert.equal(row.action, 'Ask');
    assert.equal(row.target, 'Ask a few clarifying questions?');
    assert.ok(!row.target.includes('{'));
  });

  test('failure carries a plain-language outcome in danger tone', () => {
    const row = buildToolRow(
      'read_file',
      { path: 'test/missing.md' },
      'failed',
      "Error: ENOENT: no such file or directory, stat 'C:\\p\\test\\missing.md'",
    );
    assert.equal(row.outcome, 'not found');
    assert.equal(row.outcomeTone, 'danger');
  });

  test('run_impeccable detect findings are a count, not a failure outcome', () => {
    const result =
      'Error: impeccable detect exited 2\n3 anti-patterns found.\nline 6: [design-system-color] text color';
    const row = buildToolRow(
      'run_impeccable',
      { command: 'detect', target: 'tool-test/impeccable-probe' },
      'done',
      result,
    );
    assert.equal(row.action, 'Design pass');
    assert.equal(row.target, 'tool-test/impeccable-probe');
    assert.equal(row.outcome, '3 anti-patterns');
    assert.equal(row.outcomeTone, 'neutral');
  });

  test('unknown tool falls back to spaced snake_case with no invented outcome', () => {
    const row = buildToolRow('my_custom_tool', {}, 'done', '{"ok":true,"data":[1,2,3]}');
    assert.equal(row.action, 'my custom tool');
    assert.equal(row.outcome, undefined);
  });
});

describe('getToolIcon / getToolAction', () => {
  test('file tools no longer share one folder glyph', () => {
    assert.equal(getToolIcon('list_directory'), 'folder');
    assert.equal(getToolIcon('read_file'), 'fileText');
    assert.equal(getToolIcon('save_file'), 'save');
    assert.equal(getToolIcon('delete_path'), 'trash');
  });

  test('unknown tools fall back to a category glyph', () => {
    assert.equal(getToolIcon('totally_unknown'), 'tools');
  });

  test('actions are verb-first where there is a target', () => {
    assert.equal(getToolAction('execute_command'), 'Run');
    assert.equal(getToolAction('git_commit'), 'Commit');
    assert.equal(getToolAction('replace_text_in_file'), 'Edit');
  });
});

describe('describeToolFailure', () => {
  test('translates ENOENT into words a user can act on', () => {
    const { short, sentence } = describeToolFailure(
      "Error: ENOENT: no such file or directory, stat 'C:\\p\\test\\sample.md'",
    );
    assert.equal(short, 'not found');
    assert.match(sentence, /^File or folder not found: /);
    assert.ok(!sentence.includes('ENOENT'));
  });

  test('translates permission errors', () => {
    assert.equal(describeToolFailure('Error: EACCES: permission denied').short, 'denied');
  });

  test('falls back to the first line rather than a stack', () => {
    const { short, sentence } = describeToolFailure('Error: something odd happened\n  at foo()');
    assert.equal(short, 'failed');
    assert.equal(sentence, 'something odd happened');
  });
});

describe('buildToolArgFields', () => {
  test('drops arguments the row already showed', () => {
    assert.deepEqual(buildToolArgFields('read_file', { path: 'a.ts' }), []);
    assert.deepEqual(buildToolArgFields('execute_command', { command: 'ls' }), []);
  });

  test('keeps the remainder as readable pairs', () => {
    const fields = buildToolArgFields('read_file', { path: 'a.ts', max_bytes: 2048 });
    assert.deepEqual(fields, [{ label: 'max bytes', value: '2048', block: false }]);
  });

  test('structured values become blocks, not inline JSON', () => {
    const [field] = buildToolArgFields('some_tool', { config: { a: 1 } });
    assert.equal(field.label, 'config');
    assert.equal(field.block, true);
    assert.match(field.value, /"a": 1/);
  });

  test('the argument the generic resolver used as the target is not repeated', () => {
    const args = { action: 'restart', id: 'primary' };
    assert.equal(buildToolRow('manage_dev_servers', args, 'running').target, 'restart');
    assert.deepEqual(
      buildToolArgFields('manage_dev_servers', args).map((f) => f.label),
      ['id'],
    );
  });
});

describe('buildFriendlyToolBody', () => {
  test('parses a directory listing', () => {
    const body = buildFriendlyToolBody('list_directory', { path: 'docs' }, '[dir] plans\n[file] readme.md', false);
    assert.equal(body?.kind, 'listing');
    assert.deepEqual(body.dirs, ['plans']);
    assert.deepEqual(body.files, ['readme.md']);
  });

  test('find_files returns a path list, not an empty directory listing', () => {
    const body = buildFriendlyToolBody('find_files', { pattern: '*.ts' }, 'src/a.ts\nsrc/b.ts', false);
    assert.equal(body?.kind, 'paths');
    assert.deepEqual(body.paths, ['src/a.ts', 'src/b.ts']);
  });

  test('grep groups matches by file', () => {
    const result = 'src/a.ts:12:const x = 1\nsrc/a.ts:40:const y = 2\nsrc/b.ts:3:const z = 3';
    const body = buildFriendlyToolBody('grep', { pattern: 'const' }, result, false);
    assert.equal(body?.kind, 'matches');
    assert.equal(body.groups.length, 2);
    assert.equal(body.groups[0].path, 'src/a.ts');
    assert.equal(body.groups[0].lines.length, 2);
  });

  test('ask_question folds the chosen option into the prompt card', () => {
    const args = {
      questions: [
        {
          id: 'q',
          prompt: 'Pick one',
          options: [
            { id: 'a', label: 'Yes' },
            { id: 'b', label: 'No' },
          ],
        },
      ],
    };
    const result = JSON.stringify({
      status: 'answered',
      answers: [{ questionId: 'q', selectedIds: ['a'] }],
    });
    const body = buildFriendlyToolBody('ask_question', args, result, false);
    assert.equal(body?.kind, 'questions');
    assert.equal(body.items[0].prompt, 'Pick one');
    assert.deepEqual(body.items[0].options, [
      { label: 'Yes', selected: true },
      { label: 'No', selected: false },
    ]);
    assert.equal(body.cancelled, false);
  });

  test('ask_question marks a cancelled round', () => {
    const args = { questions: [{ id: 'q', prompt: 'Pick one', options: [] }] };
    const body = buildFriendlyToolBody('ask_question', args, '{"status":"cancelled"}', false);
    assert.equal(body.cancelled, true);
  });

  test('shell body keeps output and exit code', () => {
    const body = buildFriendlyToolBody(
      'execute_command',
      { command: 'npm test' },
      'npm test (exit 0)\n\nstdout:\nok\n',
      false,
    );
    assert.equal(body?.kind, 'shell');
    assert.equal(body.output.trim(), 'ok');
    assert.equal(body.exitCode, 0);
  });

  test('read_file preview reports how much was withheld', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const body = buildFriendlyToolBody('read_file', { path: 'a.ts' }, lines, false);
    assert.equal(body?.kind, 'text');
    assert.equal(body.lines.length, 14);
    assert.equal(body.truncated, 6);
  });

  test('failed runs get no structured body', () => {
    assert.equal(buildFriendlyToolBody('read_file', { path: 'a.ts' }, 'Error: ENOENT', true), null);
  });
});

describe('extractProcessStdout', () => {
  test('returns null when the marker is missing', () => {
    assert.equal(extractProcessStdout('plain text'), null);
  });
});
