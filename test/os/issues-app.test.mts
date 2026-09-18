/**
 * Minnow Issues app registration, routing, and shell markup contract.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { APPS, getAppById, isAppId } from '../../src/os/app-registry.ts';
import { hashForRoute, parseOsHash, resolveLegacyHash } from '../../src/os/router.ts';

describe('issues app registry', () => {
  test('issues is a registered launcher app', () => {
    assert.ok(APPS.some((app) => app.id === 'issues'));
    const issues = getAppById('issues');
    assert.ok(issues);
    assert.match(issues.tag, /triage|track|capture/i);
  });

  test('isAppId accepts issues', () => {
    assert.equal(isAppId('issues'), true);
  });
});

describe('issues router', () => {
  test('legacy #/bugs redirects to #/app/issues', () => {
    const legacy = resolveLegacyHash('#/bugs');
    assert.equal(legacy.hash, '#/app/issues');
  });

  test('parseOsHash resolves issues app route', () => {
    const route = parseOsHash('#/app/issues');
    assert.equal(route.view, 'app');
    assert.equal(route.appId, 'issues');
  });

  test('parseOsHash captures issueId deep link', () => {
    const route = parseOsHash('#/app/issues/ISS-7');
    assert.equal(route.view, 'app');
    assert.equal(route.appId, 'issues');
    assert.equal(route.issueId, 'ISS-7');
  });

  test('parseOsHash resolves the projects screen without treating it as an issue id', () => {
    const route = parseOsHash('#/app/issues/projects');
    assert.equal(route.view, 'app');
    assert.equal(route.appId, 'issues');
    assert.equal(route.issuesSection, 'projects');
    assert.equal(route.issueId, undefined);
    assert.equal(hashForRoute(route), '#/app/issues/projects');
  });

  test('hashForRoute round-trips issue deep links', () => {
    const route = parseOsHash('#/app/issues/ISS-42');
    assert.equal(hashForRoute(route), '#/app/issues/ISS-42');
  });
});

describe('issues markup contract', () => {
  test('index.html defines a thin issuesView mount', () => {
    const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    assert.match(html, /id="issuesView"/);
    assert.doesNotMatch(html, /id="issuesPanelMount"/);
    assert.doesNotMatch(html, /id="issuesQuickCapture"/);
  });
});

describe('issues list CSS contract', () => {
  test('width rules use a named container query, not viewport media', () => {
    const css = fs.readFileSync(new URL('../../src/styles/issues.css', import.meta.url), 'utf8');
    assert.match(css, /container-name:\s*issues/);
    assert.match(css, /@container issues \(max-width: 900px\)/);
    assert.match(css, /--issues-peek-cols: minmax\(0, 1fr\) minmax\(380px, var\(--issues-peek-w\)\)/);
    assert.match(css, /\.issues-list-head[\s\S]*color: var\(--mn-fg-muted\)/);
    assert.doesNotMatch(css, /@media \(max-width: 900px\)/);
    assert.doesNotMatch(css, /@media \(max-width: 640px\)/);
    assert.doesNotMatch(css, /^\s*max-width:\s*65ch/m);
    assert.match(css, /\.issues-empty--triage/);
  });

  test('list columns put labels after title and status before created', () => {
    const css = fs.readFileSync(new URL('../../src/styles/issues.css', import.meta.url), 'utf8');
    const chrome = fs.readFileSync(new URL('../../src/ui/issues-chrome.ts', import.meta.url), 'utf8');
    const page = fs.readFileSync(new URL('../../src/ui/issues-page.ts', import.meta.url), 'utf8');
    assert.match(chrome, /id: 'btnIssuesSyncAll'/);
    assert.match(chrome, /id: 'btnIssuesScreenProjects'/);
    assert.match(page, /btnIssuesSyncAll/);
    assert.match(css, /--issues-row-h:\s*36px/);
    assert.match(css, /id priority type title labels/);
    assert.match(css, /minmax\(0, 1fr\).*max-content.*minmax\(5rem, max-content\)/);
    assert.match(css, /Compact identity: id, priority, title, status/);
    assert.match(
      chrome,
      /sortHead\('title'[\s\S]*?sortHead\('labels'[\s\S]*?sortHead\('status'[\s\S]*?sortHead\('created'/,
    );
    assert.match(page, /row\.append\(\s*id,\s*priority,\s*type,\s*title,\s*labels/);
    assert.match(page, /counts,\s*status,\s*created/);
    const compact = css.split('@container issues (max-width: 900px)')[1]?.split('@container')[0] ?? '';
    assert.match(compact, /issues-list-head__type/);
    assert.doesNotMatch(compact, /issues-row__priority/);
    assert.doesNotMatch(compact, /issues-list-head__priority/);
  });
});
