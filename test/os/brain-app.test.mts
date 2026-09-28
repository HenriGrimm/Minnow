/**
 * Minnow Brain app registration and markup contract.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { APPS, getAppById, isAppId } from '../../src/os/app-registry.ts';
import { resolveLegacyHash, parseOsHash } from '../../src/os/router.ts';
import { isWindowMountedApp } from '../../src/os/window-mounted-apps.ts';

describe('brain app registry', () => {
  test('brain is a registered launcher app', () => {
    assert.ok(APPS.some((app) => app.id === 'brain'));
    const brain = getAppById('brain');
    assert.ok(brain);
    assert.match(brain.tag, /wiki/i);
    assert.equal(brain.icon, 'brain');
  });

  test('isAppId accepts brain', () => {
    assert.equal(isAppId('brain'), true);
  });

  test('brain is not window-mounted in workspace-first shell', () => {
    assert.equal(isWindowMountedApp('brain'), false);
  });
});

describe('brain router', () => {
  test('legacy #/brain/edit redirects to app route', () => {
    const legacy = resolveLegacyHash('#/brain/edit');
    assert.equal(legacy.hash, '#/app/brain/edit');
    assert.equal(legacy.brainSection, 'edit');
  });

  test('legacy #/settings/memory redirects to Brain memories', () => {
    const legacy = resolveLegacyHash('#/settings/memory');
    assert.equal(legacy.hash, '#/app/brain/memories');
    assert.equal(legacy.brainSection, 'memories');
  });

  test('parseOsHash resolves brain graph deep link (legacy wiki alias)', () => {
    const route = parseOsHash('#/app/brain/wiki');
    assert.equal(route.view, 'app');
    assert.equal(route.appId, 'brain');
    assert.equal(route.brainSection, 'wiki');
  });

  test('parseOsHash resolves brain graph home', () => {
    const route = parseOsHash('#/app/brain/graph');
    assert.equal(route.appId, 'brain');
    assert.equal(route.brainSection, 'graph');
  });

  test('parseOsHash resolves brain code deep link', () => {
    const route = parseOsHash('#/app/brain/code');
    assert.equal(route.appId, 'brain');
    assert.equal(route.brainSection, 'code');
  });
});

describe('brain markup contract', () => {
  test('global.css hides brain until lazy page CSS loads', () => {
    const css = fs.readFileSync(new URL('../../src/styles/global.css', import.meta.url), 'utf8');
    assert.match(css, /\.brain-page\s*\{\s*display:\s*none/);
    assert.doesNotMatch(css, /\.brain-page\.is-open\s*\{[^}]*display:\s*flex/);
  });

  test('brain-page fills OS stage height (not viewport 100vh)', () => {
    const css = fs.readFileSync(new URL('../../src/styles/brain-page.css', import.meta.url), 'utf8');
    assert.match(css, /\.brain-page\s*\{[\s\S]*?height:\s*100%/);
    assert.match(css, /html:not\(\.minnow-os-enabled\)\s*\.brain-page\.is-open/);
    const shell = fs.readFileSync(new URL('../../src/styles/minnowos-shell.css', import.meta.url), 'utf8');
    assert.match(shell, /#osAppsLayer\s*\.brain-page\.is-open/);
  });

  test('index.html defines brainView shell', () => {
    const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    assert.match(html, /id="brainView"/);
    assert.match(html, /id="brainSection-graph"/);
    assert.match(html, /id="brainGraphCanvas"/);
    assert.match(html, /id="brainInspector"/);
    assert.match(html, /id="brainInspectorResize"/);
    assert.match(html, /id="brainGraphSidebarResize"/);
    assert.match(html, /data-brain-nav="graph"/);
    assert.match(html, /data-brain-nav="proposals"/);
    assert.match(html, /id="brainProposalsList"/);
    assert.match(html, /id="brainSection-settings"/);
    assert.match(html, /id="brainSection-memories"/);
    assert.match(html, /data-brain-nav="memories"/);
    assert.match(html, /id="brainMemoryEnabled"/);
    assert.match(html, /id="brainEmbeddingsDownload"/);
    assert.match(html, /id="brainSynthesisEnabled"/);
    assert.match(html, /data-brain-nav="code"/);
    assert.match(html, /id="brainSection-code"/);
    assert.match(html, /id="brainCodeReindex"/);
    assert.match(html, /id="brainCodeSettingsSave"/);
    assert.match(html, /id="brainGraphOrphanToggle"/);
    assert.match(html, /id="brainEditWorkspace"/);
    assert.match(html, /id="brainLintRun"/);
    assert.match(html, /brain-section--code/);
    assert.match(html, /brain-section--schema/);
  });
});
