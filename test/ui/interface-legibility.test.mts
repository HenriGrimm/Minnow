import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('meaningful metadata uses the shared readable-size token', () => {
  const tokens = read('src/styles/tokens.css');
  assert.match(tokens, /--mn-text-meta-size:\s*12px/);
  assert.match(tokens, /--mn-text-telemetry-size:\s*11px/);

  for (const [path, selector] of [
    ['src/styles/home.css', '.home-resume-label'],
    ['src/styles/sidebar.css', '.chat-item-name'],
    ['src/styles/code-chrome.css', '.code-status-bar__btn'],
    ['src/styles/file-panel.css', '.file-sidebar-title'],
    ['src/styles/issues.css', '.issues-list-head'],
    ['src/styles/issues.css', '.issues-filter-chip'],
  ]) {
    const css = read(path);
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(css, new RegExp(`${escaped}\\s*\\{[^}]*font-size:\\s*var\\(--mn-text-meta-size\\)`, 's'), `${selector} should meet the metadata minimum`);
  }
});

test('Recent workspaces heading uses readable muted contrast', () => {
  const css = read('src/styles/workspace-welcome-page.css');
  assert.match(css, /\.welcome-page__recents-title\s*\{[^}]*font-size:\s*var\(--mn-text-meta-size\)[^}]*color:\s*var\(--mn-fg-muted\)/s);
});

test('Code view labels are visible until the stage becomes compact', () => {
  const css = read('src/styles/code-chrome.css');
  assert.match(css, /\.code-views__label-track\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /@container code-stage \(max-width: 600px\)[\s\S]*?\.code-views__label-track\s*\{[^}]*grid-template-columns:\s*0fr/s);
  assert.match(css, /html\.mn-narrow \.code-views__btn:not\(\.code-views__btn--files\)[\s\S]*?grid-template-columns:\s*0fr/s);
});

test('Settings rows stack based on their content pane width', () => {
  const pageCss = read('src/styles/settings-page.css');
  const controlsCss = read('src/styles/settings-controls.css');
  assert.match(pageCss, /\.settings-content\s*\{[^}]*container-name:\s*settings-content/s);
  assert.match(controlsCss, /@container settings-content \(max-width: 760px\)[\s\S]*?flex-direction:\s*column/s);
});

test('released Brain panels do not skip from the page h1 to subsection h3/h4 headings', () => {
  const html = read('index.html');
  for (const title of ['Pages', 'Structure', 'Workflow', 'Tips', 'Call graph', 'Explain', 'Auto-learning cadence', 'Semantic embeddings', 'Code index', 'Danger zone']) {
    assert.match(html, new RegExp(`<h2[^>]*>${title}</h2>`), `${title} should be a level-two subsection`);
  }
  for (const title of ['Skill proposals', 'File patterns', 'Token budgets', 'Composer &amp; reindex', 'Advanced', 'Wiki', 'Ingest sources']) {
    assert.match(html, new RegExp(`<h3[^>]*>${title}</h3>`), `${title} should be nested one level below its group`);
  }

  const code = read('src/ui/brain/code-section.ts');
  const empty = read('src/ui/brain/empty-state.ts');
  assert.match(code, /const title = document\.createElement\('h2'\)/);
  assert.match(code, /const heading = document\.createElement\('h3'\)/);
  assert.match(empty, /const title = document\.createElement\('h2'\)/);
});
