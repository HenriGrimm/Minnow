import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { discoverBrowser, launchBrowser } from '../../server/browser-driver/index.js';

test('xterm resolves the live workbench sheet and accent to sRGB', { timeout: 30_000 }, async t => {
  const browser = await discoverBrowser();
  if (!browser.available) return t.skip(browser.detail);

  const [tokens, terminal, bundle] = await Promise.all([
    readFile(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8'),
    readFile(new URL('../../src/styles/terminal.css', import.meta.url), 'utf8'),
    build({
      entryPoints: [fileURLToPath(new URL('../../src/ui/terminal-xterm-theme.ts', import.meta.url))],
      bundle: true, write: false, format: 'iife', globalName: 'terminalTheme',
    }),
  ]);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'minnow-terminal-theme-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><style>${tokens}\n${terminal}</style>
      <div class="terminal-xterm-host"></div><script>${bundle.outputFiles[0].text}</script>`);
  });
  let session;
  t.after(async () => {
    await session?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const launched = await launchBrowser({
    executablePath: browser.executablePath, profileDir: path.join(scratch, 'profile'),
    allowedOriginPatterns: ['http://127.0.0.1:*'], hardTimeoutMs: 25_000,
  });
  assert.ok(launched.ok, launched.detail);
  session = launched.session;
  await session.navigate(`http://127.0.0.1:${server.address().port}/`);

  const themes = await session.evaluate(`(() => {
    const root = document.documentElement;
    const host = document.querySelector('.terminal-xterm-host');
    const ctx = document.createElement('canvas').getContext('2d');
    const pixel = color => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const testCases = [
      ['graphite-dark', 'none', 'amber'], ['graphite-dark', 'rich', 'amber'],
      ['graphite-light', 'subtle', 'violet'], ['ocean-dark', 'rich', 'teal'],
      ['matrix-light', 'none', 'teal'],
    ];
    return testCases.map(([theme, tint, accent]) => {
      Object.assign(root.dataset, { theme, tint, graphiteAccent: accent });
      const { background, cursor, white } = terminalTheme.buildTerminalXtermTheme(getComputedStyle(root));
      const hostStyle = getComputedStyle(host);
      return {
        theme, tint, background, cursor, white,
        cssBackground: pixel(hostStyle.backgroundColor),
        terminalBackground: pixel(background),
      };
    });
  })()`);

  for (const { theme, tint, background, cursor, white, cssBackground, terminalBackground } of themes) {
    for (const color of [background, cursor, white]) assert.match(color, /^#[0-9a-f]{6}$/);
    assert.deepEqual(terminalBackground, cssBackground, `${theme} / ${tint}`);
  }
  assert.notEqual(themes[0].background, themes[1].background, 'tint should reach xterm');
  assert.equal(themes[0].cursor, '#f5a524');
  assert.equal(themes[2].cursor, '#b79cff');
});
