/**
 * Minnow Models app registration and markup contract.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { APPS, getAppById, isAppId } from '../../src/os/app-registry.ts';
import { resolveLegacyHash, parseOsHash } from '../../src/os/router.ts';
import {
  DEFAULT_MODELS_SECTION,
  MODELS_SECTIONS,
  WORKBENCH_SECTIONS,
} from '../../src/ui/models-section-ids.ts';

describe('models app registry', () => {
  test('models is a registered launcher app', () => {
    assert.ok(APPS.some((app) => app.id === 'models'));
    const models = getAppById('models');
    assert.ok(models);
    assert.match(models.tag, /download/i);
    assert.equal(models.icon, 'chip');
  });

  test('isAppId accepts models', () => {
    assert.equal(isAppId('models'), true);
  });
});

describe('models router', () => {
  test('legacy #/settings/providers redirects to models providers', () => {
    const legacy = resolveLegacyHash('#/settings/providers');
    assert.equal(legacy.hash, '#/app/models/providers');
    assert.equal(legacy.modelsSection, 'providers');
  });

  test('legacy #/settings/model-routing redirects to models routing', () => {
    const legacy = resolveLegacyHash('#/settings/model-routing');
    assert.equal(legacy.hash, '#/app/models/routing');
    assert.equal(legacy.modelsSection, 'routing');
  });

  test('legacy #/settings/voice redirects to models voice', () => {
    const legacy = resolveLegacyHash('#/settings/voice');
    assert.equal(legacy.hash, '#/app/models/voice');
    assert.equal(legacy.modelsSection, 'voice');
  });

  test('parseOsHash resolves models voice deep link', () => {
    const route = parseOsHash('#/app/models/voice');
    assert.equal(route.view, 'app');
    assert.equal(route.appId, 'models');
    assert.equal(route.modelsSection, 'voice');
  });

  test('bare #/models lands on the local library, not the catalog', () => {
    assert.equal(resolveLegacyHash('#/models').modelsSection, DEFAULT_MODELS_SECTION);
    assert.equal(parseOsHash('#/app/models').modelsSection, DEFAULT_MODELS_SECTION);
  });

  test('local server is a routable section', () => {
    const route = parseOsHash('#/app/models/server');
    assert.equal(route.appId, 'models');
    assert.equal(route.modelsSection, 'server');
  });
});

describe('models sections', () => {
  test('workbench sections are a subset of all sections', () => {
    for (const id of WORKBENCH_SECTIONS) {
      assert.ok(MODELS_SECTIONS.includes(id), `${id} must be a known section`);
    }
  });

  test('inference settings sections survive the redesign', () => {
    for (const id of ['providers', 'clis', 'routing', 'sampler', 'thinking', 'voice', 'usage'] as const) {
      assert.ok(MODELS_SECTIONS.includes(id), `${id} must stay reachable`);
    }
  });
});

describe('models markup contract', () => {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

  test('index.html defines modelsView shell', () => {
    assert.match(html, /id="modelsView"/);
    assert.match(html, /id="modelsSection-recommend"/);
    assert.match(html, /id="modelsRecommendBody"/);
    assert.match(html, /data-models-nav="providers"/);
    assert.match(html, /id="modelsSection-settings"/);
    assert.match(html, /data-models-nav="settings"/);
    assert.match(html, /data-models-nav="voice"/);
    assert.match(html, /id="modelsSection-voice"/);
    assert.match(html, /id="modelsVoiceBody"/);
  });

  test('index.html defines the workbench surfaces', () => {
    assert.match(html, /id="modelsSection-installed"/);
    assert.match(html, /id="modelsInstalledBody"/);
    assert.match(html, /id="modelsSection-server"/);
    assert.match(html, /id="modelsServerBody"/);
    assert.match(html, /data-models-nav="installed"/);
    assert.match(html, /data-models-nav="server"/);
  });

  test('index.html defines the inspector column and its toggle', () => {
    assert.match(html, /id="modelsInspector"/);
    assert.match(html, /id="btnModelsInspector"/);
    assert.match(html, /aria-controls="modelsInspector"/);
    assert.match(html, /id="modelsHeaderStatus"/);
  });

  test('every section id has a panel and a nav button', () => {
    for (const id of MODELS_SECTIONS) {
      assert.match(html, new RegExp(`id="modelsSection-${id}"`), `panel for ${id}`);
      assert.match(html, new RegExp(`data-models-nav="${id}"`), `nav button for ${id}`);
    }
  });

  test('Minnow OS shell sizes models-page to the app layer, not 100vh', () => {
    const shellCss = fs.readFileSync(
      new URL('../../src/styles/minnowos-shell.css', import.meta.url),
      'utf8',
    );
    assert.match(
      shellCss,
      /#osAppsLayer \.models-page\.is-open[\s\S]*height:\s*100%/,
      'models inspector footer must not be clipped by overflow:hidden on the OS app layer',
    );
  });
});

describe('models layout contract', () => {
  test('models-page fills OS stage height (not viewport 100vh)', () => {
    const css = fs.readFileSync(new URL('../../src/styles/models-page.css', import.meta.url), 'utf8');
    // First height in .models-page must be the stage fill, not 100vh (MIN-606).
    const pageBlock = css.match(/\.models-page\s*\{[\s\S]*?\n\}/);
    assert.ok(pageBlock, 'expected .models-page rule');
    assert.match(pageBlock[0], /height:\s*100%/);
    assert.doesNotMatch(pageBlock[0], /height:\s*100vh/);
    assert.match(css, /html:not\(\.minnow-os-enabled\)\s*\.models-page\.is-open/);
    const shell = fs.readFileSync(new URL('../../src/styles/minnowos-shell.css', import.meta.url), 'utf8');
    assert.match(shell, /#osAppsLayer\s*\.models-page\.is-open/);
  });

  test('runtime log pane shrinks and scrolls inside the body', () => {
    const css = fs.readFileSync(new URL('../../src/styles/models-page.css', import.meta.url), 'utf8');
    const logsBlock = css.match(/\.models-logs\s*\{[\s\S]*?\n\}/);
    assert.ok(logsBlock, 'expected .models-logs rule');
    assert.match(logsBlock[0], /min-height:\s*0/);
    assert.match(logsBlock[0], /overflow:\s*hidden/);
    const bodyBlock = css.match(/\.models-logs__body\s*\{[\s\S]*?\n\}/);
    assert.ok(bodyBlock, 'expected .models-logs__body rule');
    assert.match(bodyBlock[0], /overflow:\s*auto/);
    assert.match(bodyBlock[0], /min-height:\s*0/);
  });
});
