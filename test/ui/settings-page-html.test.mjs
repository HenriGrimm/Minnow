import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/** Nav section ids must match panels in index.html (settings-page-types SETTINGS_SECTIONS). */
const SETTINGS_SECTION_IDS = [
  'general',
  'notifications',
  'appearance',
  'audio',
  'about',
  'apps',
  'providers',
  'usage',
  'model-routing',
  'sampler',
  'thinking',
  'agent-center',
  'injection',
  'rules',
  'agent-packs',
  'autopilot',
  'watchdog',
  'search',
  'deep-research',
  'servers',
  'tools',
  'skills',
  'skills-library',
  'browser',
  'mcp',
  'lsp',
  'editor',
  'webhooks',
  'diagnostics',
  'capability-matrix',
  'board-testing',
];

/** Sections populated by refreshSettingsSection via clearMount(). */
const DYNAMIC_SECTION_BODY_IDS = [
  'settingsGeneralBody',
  'settingsNotificationsBody',
  'settingsAppsBody',
  'settingsAudioBody',
  'settingsModelRoutingBody',
  'settingsSamplerBody',
  'settingsAgentCenterBody',
  'settingsInjectionBody',
  'settingsRulesBody',
  'settingsAgentPacksBody',
  'settingsWatchdogBody',
  'settingsSearchBody',
  'settingsDeepResearchBody',
  'settingsServersBody',
  'settingsToolsBody',
  'settingsSkillsBody',
  'settingsSkillsLibraryBody',
  'settingsBrowserBody',
  'settingsWebhooksBody',
  'settingsUsageBody',
  'settingsProvidersBody',
  'settingsEditorBody',
  'settingsDiagnosticsBody',
  'settingsCapabilityMatrixBody',
  'settingsBoardTestingBody',
];

describe('settings page HTML', () => {
  for (const id of SETTINGS_SECTION_IDS) {
    test(`settingsSection-${id} exists in index.html`, () => {
      assert.match(html, new RegExp(`id="settingsSection-${id}"`));
    });
  }

  for (const id of DYNAMIC_SECTION_BODY_IDS) {
    test(`${id} mount exists in index.html`, () => {
      assert.match(html, new RegExp(`id="${id}"`));
    });
  }

  test('providers section mount exists in index.html', () => {
    assert.match(html, /id="settingsProvidersBody"/);
    assert.match(html, /id="settingsSection-providers"/);
  });

  test('MCP section uses body mount (add-server form rendered in JS)', () => {
    assert.match(html, /id="settingsMcpBody"/);
    assert.doesNotMatch(html, /id="settingsMcpAddForm"/);
  });

  test('memory UI moved to Brain app (not in settings)', () => {
    assert.doesNotMatch(html, /id="settingsSection-memory"/);
    assert.doesNotMatch(html, /id="settingsMemoryList"/);
    assert.match(html, /id="brainSection-memories"/);
    assert.match(html, /id="brainMemoryList"/);
    assert.match(html, /data-brain-nav="memories"/);
  });

  test('prompt token estimate elements exist in index.html', () => {
    assert.match(html, /id="settingsPromptTokenEstimate"/);
    assert.match(html, /id="settingsPromptTokenBreakdown"/);
    assert.match(html, /class="settings-prompt-estimate"/);
  });

  test('settings global search finder exists in header slot', () => {
    assert.match(html, /id="settingsSearchFinderSlot"/);
    assert.match(html, /id="settingsSearchFinder"/);
    assert.match(html, /id="settingsSearchInput"/);
    assert.match(html, /id="settingsSearchResults"/);
    assert.match(html, /class="settings-page-header"/);
    assert.match(html, /id="btnSettingsPageBack"/);
    assert.match(html, /id="settingsPromptTokenEstimate"/);
  });

  test('settings unified sidebar nav exists', () => {
    assert.match(html, /class="settings-nav"/);
    assert.match(html, /data-settings-nav-area="general"/);
    assert.match(html, /data-settings-nav-hub="web-research"/);
    assert.match(html, /data-settings-category="models"/);
    assert.match(html, /data-settings-category="agents"/);
    assert.doesNotMatch(html, /data-category="knowledge"/);
    assert.doesNotMatch(html, /class="settings-category-subnav"/);
  });

  test('SETTINGS_SECTION_IDS matches canonical section count', () => {
    assert.equal(SETTINGS_SECTION_IDS.length, 31);
  });

  test('agents center mount exists in index.html', () => {
    assert.match(html, /id="settingsAgentCenterBody"/);
    assert.match(html, /data-settings-nav-area="agent-center"/);
  });

  test('injection settings section exists under Agents', () => {
    assert.match(html, /id="settingsSection-injection"/);
    assert.match(html, /id="settingsInjectionBody"/);
    assert.match(html, /data-settings-nav-area="injection"/);
    assert.doesNotMatch(html, /id="brainFeatureMemoryInjection"/);
    assert.doesNotMatch(html, /id="brainFeatureCodeMapInjectionDefault"/);
  });

  test('user rules section matches other general-style settings mounts', () => {
    const rulesBlock = html.slice(
      html.indexOf('id="settingsSection-rules"'),
      html.indexOf('id="settingsSection-agent-packs"'),
    );
    assert.match(rulesBlock, /id="settingsRulesBody"/);
    assert.doesNotMatch(rulesBlock, /class="settings-lead"/);
    assert.doesNotMatch(rulesBlock, /id="settingsRulesEnabled"/);
  });

  test('notifications settings section exists in index.html', () => {
    assert.match(html, /id="settingsSection-notifications"/);
    assert.match(html, /id="settingsNotificationsBody"/);
    assert.match(html, /data-settings-nav-area="notifications"/);
    assert.match(html, /data-area="notifications"/);
  });

  test('audio settings section exists in index.html', () => {
    assert.match(html, /id="settingsSection-audio"/);
    assert.match(html, /id="settingsAudioBody"/);
    assert.match(html, /data-area="audio"/);
  });

  test('health and diagnostics section exists under advanced in index.html', () => {
    assert.match(html, /id="settingsSection-diagnostics"/);
    assert.match(html, /id="settingsDiagnosticsBody"/);
    assert.match(html, /data-area="diagnostics"/);
    assert.match(html, /data-settings-nav-area="diagnostics"/);
    assert.match(html, /Health &amp; diagnostics/);
  });

  test('capability matrix section exists under advanced in index.html', () => {
    assert.match(html, /id="settingsSection-capability-matrix"/);
    assert.match(html, /id="settingsCapabilityMatrixBody"/);
    assert.match(html, /data-area="capability-matrix"/);
    assert.match(html, /data-settings-nav-area="capability-matrix"/);
    assert.match(html, /Capability matrix/);
  });

  test('board testing section exists under advanced in index.html', () => {
    assert.match(html, /id="settingsSection-board-testing"/);
    assert.match(html, /id="settingsBoardTestingBody"/);
    assert.match(html, /data-area="board-testing"/);
    assert.match(html, /data-settings-nav-area="board-testing"/);
    assert.match(html, /Board testing/);
  });

  test('diagnostics section matches other general-style settings mounts', () => {
    const diagnosticsBlock = html.slice(
      html.indexOf('id="settingsSection-diagnostics"'),
    );
    assert.match(diagnosticsBlock, /id="settingsDiagnosticsBody"/);
    assert.doesNotMatch(diagnosticsBlock, /class="settings-lead"/);
  });

  test('board testing section matches other general-style settings mounts', () => {
    const boardTestingBlock = html.slice(
      html.indexOf('id="settingsSection-board-testing"'),
    );
    assert.match(boardTestingBlock, /id="settingsBoardTestingBody"/);
    assert.doesNotMatch(boardTestingBlock, /class="settings-lead"/);
  });

  test('orchestration and evals settings pages are removed', () => {
    assert.doesNotMatch(html, /id="settingsSection-features"/);
    assert.doesNotMatch(html, /id="settingsSection-evals"/);
    assert.doesNotMatch(html, /data-settings-nav-area="features"/);
    assert.doesNotMatch(html, /data-settings-nav-area="evals"/);
    assert.doesNotMatch(html, /id="settingsSupervisorBody"/);
    assert.doesNotMatch(html, /id="settingsEvalsBody"/);
  });

  test('about section matches other general settings mounts', () => {
    const aboutBlock = html.slice(
      html.indexOf('id="settingsSection-about"'),
      html.indexOf('id="settingsSection-apps"'),
    );
    assert.match(aboutBlock, /id="settingsAboutBody"/);
    assert.doesNotMatch(aboutBlock, /class="settings-lead"/);
  });

  test('apps section is a top-level settings category mount', () => {
    assert.match(html, /data-settings-nav-group="apps"/);
    assert.match(html, /id="settingsSection-apps"/);
    assert.match(html, /id="settingsAppsBody"/);
    assert.match(html, /data-category="apps"/);
  });

  test('voice section uses settings layout in models app', () => {
    assert.match(html, /id="settingsSection-voice"/);
    assert.match(html, /data-area="voice"/);
    assert.match(html, /id="modelsSection-voice"/);
    assert.match(html, /id="modelsVoiceBody"/);
    assert.match(html, /class="settings-section-body"/);
    assert.doesNotMatch(html, /Voice model settings moved to/);
  });

  test('composer tools button and popover exist in index.html', () => {
    assert.match(html, /id="btnComposerTools"/);
    assert.match(html, /id="composerToolsPopover"/);
    assert.match(html, /id="composerToolsList"/);
    assert.match(html, /id="composerToolsServerBanner"/);
    assert.match(html, /id="composerToolsStatus"/);
    assert.match(html, /id="composerToolsWebSearchProvider"/);
    assert.match(html, /id="composerToolsWebSearchProvider"[^>]*>[\s\S]*value="searxng"/);
    assert.match(html, /id="composerToolsCacheEnabled"/);
    assert.match(html, /id="composerToolsOpenSettings"/);
    assert.match(html, /class="tools-list tools-list--composer"/);
    assert.match(html, /composer-tools-popover__settings-link/);
  });

  test('integrations category uses ten hub containers', () => {
    assert.match(html, /id="settingsHub-web-research"/);
    assert.match(html, /id="settingsHub-deep-research"/);
    assert.match(html, /id="settingsHub-servers"/);
    assert.match(html, /id="settingsHub-tools"/);
    assert.match(html, /id="settingsHub-skills"/);
    assert.match(html, /id="settingsHub-browser"/);
    assert.match(html, /id="settingsHub-mcp"/);
    assert.match(html, /id="settingsHub-lsp"/);
    assert.match(html, /id="settingsHub-editor"/);
    assert.match(html, /id="settingsHub-external"/);
    assert.match(html, /data-hub-jump="web-research"/);
    assert.match(html, /data-hub-jump="deep-research"/);
    assert.match(html, /data-hub-jump="servers"/);
    assert.match(html, /data-hub-jump="tools"/);
    assert.match(html, /data-hub-jump="skills"/);
    assert.match(html, /data-hub-jump="browser"/);
    assert.match(html, /data-hub-jump="mcp"/);
    assert.match(html, /data-hub-jump="lsp"/);
    assert.match(html, /data-hub-jump="editor"/);
    assert.match(html, /settings-hub is-active[^"]*" id="settingsHub-web-research"/);
    assert.match(html, /class="settings-hub__lead"/);
    assert.doesNotMatch(html, /settings-hub__title/);
    assert.doesNotMatch(html, /data-area-jump="mcp"/);
    assert.match(html, /data-settings-nav-hub="mcp"/);
    assert.match(html, /data-settings-nav-hub="lsp"/);
    assert.match(html, /data-settings-nav-hub="editor"/);
    assert.match(html, /data-settings-nav-hub="servers"/);
    assert.match(html, /data-settings-nav-hub="deep-research"/);
    assert.match(html, /id="settingsMcpBody"/);
    assert.match(html, /id="settingsLspBody"/);
    assert.match(html, /id="settingsEditorBody"/);
  });

  test('general section suppresses duplicate section title', () => {
    assert.match(
      html,
      /id="settingsSection-general"[^>]*settings-area--title-suppressed/,
    );
  });

  test('settings nav markup avoids aria-current=false', () => {
    const settingsBlock = html.slice(
      html.indexOf('id="settingsView"'),
      html.indexOf('id="welcomeView"'),
    );
    assert.doesNotMatch(settingsBlock, /aria-current="false"/);
  });

  test('prompt token estimate has accessible label', () => {
    assert.match(html, /id="settingsPromptTokenEstimate"[^>]*aria-label="Approximate prompt config token estimate"/);
  });
});
