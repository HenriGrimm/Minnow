import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import materialIcons from 'material-icon-theme/dist/material-icons.json';

import {
  resolveFileIconId,
  resolveFolderIconId,
} from '../../src/ui/file-type-icon-resolve.ts';

describe('file-type-icons (Material Icon Theme)', () => {
  it('preserves every closed and expanded folder association in both themes', () => {
    const folders = new Set([
      ...Object.keys(materialIcons.folderNames),
      ...Object.keys(materialIcons.folderNamesExpanded),
      ...Object.keys(materialIcons.light.folderNames),
      ...Object.keys(materialIcons.light.folderNamesExpanded),
      '__minnow_unlisted_folder__',
    ]);
    for (const light of [false, true]) {
      for (const expanded of [false, true]) {
        const key = expanded ? 'folderNamesExpanded' : 'folderNames';
        const defaults = materialIcons[key] as Record<string, string>;
        const overrides = materialIcons.light[key] as Record<string, string>;
        for (const name of folders) {
          const lookup = (name.split(/[/\\]/).pop() ?? name).toLowerCase();
          const expected = (light && overrides[lookup]) || defaults[lookup] ||
            (expanded ? materialIcons.folderExpanded : materialIcons.folder);
          assert.equal(resolveFolderIconId(name, { light, expanded }), expected,
            `${name}, light=${light}, expanded=${expanded}`);
          assert.equal(resolveFolderIconId(`C:\\workspace\\${name.toUpperCase()}`, { light, expanded }), expected);
        }
      }
    }
  });

  it('preserves every reachable filename and extension association in both themes', () => {
    for (const light of [false, true]) {
      for (const key of ['fileNames', 'fileExtensions'] as const) {
        const defaults = materialIcons[key] as Record<string, string>;
        const overrides = materialIcons.light[key] as Record<string, string>;
        for (const name of new Set([...Object.keys(defaults), ...Object.keys(overrides)])) {
          // Lookup has always used lowercase basenames; upstream also lists path
          // and case-sensitive associations that this resolver does not use.
          if (name !== name.toLowerCase() || /[/\\]/.test(name)) continue;
          const path = key === 'fileNames' ? name : `__minnow_unlisted_file__.${name}`;
          const expected = (light && overrides[name]) || defaults[name];
          assert.equal(resolveFileIconId(path, { light }), expected,
            `${path}, light=${light}`);
          assert.equal(resolveFileIconId(`C:\\workspace\\${path.toUpperCase()}`, { light }), expected);
        }
      }
      assert.equal(resolveFileIconId('__minnow_unlisted_file__', { light }), materialIcons.file);
      assert.equal(resolveFileIconId('APKBUILD', { light }), materialIcons.file);
    }
  });

  it('resolves language and compound-extension icons like VS Code', () => {
    assert.equal(resolveFileIconId('src/app.ts', { light: false }), 'typescript');
    assert.equal(resolveFileIconId('bundle.js', { light: false }), 'javascript');
    assert.equal(resolveFileIconId('app.test.mjs', { light: false }), 'test-js');
    assert.equal(resolveFileIconId('skills-loader.test.ts', { light: false }), 'test-ts');
    assert.equal(resolveFileIconId('main.py', { light: false }), 'python');
    assert.equal(resolveFileIconId('data.json', { light: false }), 'json');
    assert.equal(resolveFileIconId('index.html', { light: false }), 'html');
    assert.equal(resolveFileIconId('DESIGN.md', { light: false }), 'markdown');
    assert.equal(resolveFileIconId('notes.txt', { light: false }), 'document');
  });

  it('resolves special filenames from the screenshot set', () => {
    assert.equal(resolveFileIconId('README.md', { light: false }), 'readme');
    assert.equal(resolveFileIconId('package.json', { light: false }), 'nodejs');
    assert.equal(resolveFileIconId('tsconfig.json', { light: false }), 'tsconfig');
    assert.equal(resolveFileIconId('vite.config.ts', { light: false }), 'vite');
    assert.equal(resolveFileIconId('.gitignore', { light: false }), 'git');
    assert.equal(resolveFileIconId('.env', { light: false }), 'tune');
    assert.equal(resolveFileIconId('LICENSE', { light: false }), 'license');
  });

  it('resolves named folders', () => {
    assert.equal(resolveFolderIconId('src', { light: false }), 'folder-src');
    assert.equal(resolveFolderIconId('node_modules', { light: false }), 'folder-node');
    assert.equal(
      resolveFolderIconId('src', { expanded: true, light: false }),
      'folder-src-open',
    );
    assert.equal(resolveFolderIconId('random-dir', { light: false }), 'folder');
  });
});
