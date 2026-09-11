/**
 * Jump-to-latest floats in the chat viewport dock.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const messagesCss = readFileSync(join(root, 'src/styles/messages.css'), 'utf8');

describe('chat viewport float dock', () => {
  test('index.html keeps only the jump chip in the dock', () => {
    const dockStart = html.indexOf('class="chat-viewport-dock"');
    const dockEnd = html.indexOf('id="toolApprovalHost"');
    assert.ok(dockStart > 0 && dockEnd > dockStart);
    const dock = html.slice(dockStart, dockEnd);
    assert.ok(dock.includes('id="chatJumpLatest"'), 'jump chip lives in the dock');
    assert.doesNotMatch(dock, /code-change-strip-wrap/);
  });

  test('dock is a column and hides when the jump chip is hidden', () => {
    assert.match(messagesCss, /\.chat-viewport-dock\s*\{[^}]*flex-direction:\s*column/s);
    assert.match(messagesCss, /\.chat-viewport-dock\s*\{[^}]*gap:\s*8px/s);
    assert.match(
      messagesCss,
      /\.chat-viewport-dock \.chat-jump-latest\.hidden\s*\{[^}]*display:\s*none\s*!important/s,
    );
    assert.match(
      messagesCss,
      /\.chat-viewport-dock:not\(:has\(\.chat-jump-latest:not\(\.hidden\)\)\)\s*\{[^}]*display:\s*none/s,
    );
  });
});
