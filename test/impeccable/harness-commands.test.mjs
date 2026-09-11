/**
 * Harness command matrix — parse, reference API, patched content (v3 routing).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  HARNESS_COMMANDS,
  parseImpeccableSubcommand,
  resolveHarnessCommand,
} from '../../server/impeccable/command-routing.js';
import { readImpeccableReference } from '../../server/impeccable/reference-handler.js';
import {
  commandsForImpeccableAugment,
  parseImpeccableSubcommand as parseClientSubcommand,
} from '../../src/skills/impeccable-client.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SKILL_DIR = path.join(PROJECT_ROOT, 'src', 'skills', 'impeccable');

/** Upstream template tokens — exclude JSX `style={{…}}` false positives. */
const TEMPLATE_TOKEN_RE = /\{\{[^}]+\}\}/;

function hasUnpatchedTemplateTokens(content) {
  const withoutJsxStyle = content.replace(/style=\{\{[^}]*\}\}/g, '');
  return TEMPLATE_TOKEN_RE.test(withoutJsxStyle);
}

/** Spot-check anchors per harness command. */
const SPOT_CHECKS = {
  polish: /Pre-Polish/i,
  init: /PRODUCT\.md/,
};

const HARNESS_LIST = [...HARNESS_COMMANDS].sort();

describe('Impeccable harness command matrix', () => {
  it('HARNESS_COMMANDS has 23 workflow commands', () => {
    assert.equal(HARNESS_COMMANDS.size, 23);
    assert.equal(HARNESS_LIST.length, 23);
    assert.equal(HARNESS_COMMANDS.has('init'), true);
    assert.equal(HARNESS_COMMANDS.has('teach'), false);
  });

  for (const cmd of HARNESS_LIST) {
    it(`${cmd}: server parse, reference API, clean patched content`, () => {
      const parsed = parseImpeccableSubcommand(cmd);
      assert.equal(parsed.command, cmd, 'server parse first token');
      assert.equal(parsed.target, '');

      const withTarget = parseImpeccableSubcommand(`${cmd} sidebar panel`);
      assert.equal(withTarget.command, cmd);
      assert.equal(withTarget.target, 'sidebar panel');

      const payload = readImpeccableReference(SKILL_DIR, cmd);
      assert.ok(payload, `${cmd} reference missing`);
      assert.equal(payload.command, cmd);
      assert.ok(payload.content.length > 100, `${cmd} content too short`);
      assert.equal(
        hasUnpatchedTemplateTokens(payload.content),
        false,
        `${cmd} still has {{template}} tokens`,
      );

      if (SPOT_CHECKS[cmd]) {
        assert.match(payload.content, SPOT_CHECKS[cmd]);
      }
    });
  }

  it('craft → commandsForImpeccableAugment includes shape', () => {
    assert.deepEqual(commandsForImpeccableAugment('craft'), ['craft', 'shape']);
  });

  it('teach alias resolves to init (server + client parse + API)', () => {
    assert.equal(resolveHarnessCommand('teach'), 'init');

    const serverParsed = parseImpeccableSubcommand('teach');
    assert.equal(serverParsed.command, 'teach');

    const clientParsed = parseClientSubcommand('teach');
    assert.equal(clientParsed.command, 'init');

    const payload = readImpeccableReference(SKILL_DIR, 'teach');
    assert.ok(payload);
    assert.equal(payload.command, 'init');
    assert.match(payload.content, /# Init Flow/i);
    assert.match(payload.content, /PRODUCT\.md/);
    assert.equal(hasUnpatchedTemplateTokens(payload.content), false);
  });
});
