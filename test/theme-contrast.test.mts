/**
 * WCAG AA contrast for core --mn-* pairs (static palette table from Color Scheme Exploration).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import path from 'node:path';

const THEME_IDS = [
  'swamp-dark',
  'swamp-light',
  'desert-dark',
  'desert-light',
  'ocean-dark',
  'ocean-light',
  'coral-dark',
  'coral-light',
  'mono-dark',
  'mono-light',
  'matrix-dark',
  'matrix-light',
  'human-dark',
  'human-light',
  'mint-dark',
  'mint-light',
] as const;

const LIGHT_THEME_IDS = THEME_IDS.filter((id) => id.endsWith('-light'));

function parseHexOrRgb(color: string): [number, number, number] | null {
  const hex = color.trim();
  if (hex.startsWith('#')) {
    const h = hex.slice(1);
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h.length >= 6
          ? h.slice(0, 6)
          : null;
    if (!full) return null;
    const n = Number.parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(hex);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(fg: string, bg: string): number {
  const a = parseHexOrRgb(fg);
  const b = parseHexOrRgb(bg);
  if (!a || !b) return 0;
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function readThemeBlock(css: string, themeId: string): Record<string, string> {
  const re = new RegExp(
    `:root\\[data-theme="${themeId}"\\](?:,\\s*\\.settings-theme-preview\\[data-theme="${themeId}"\\])?\\s*\\{([\\s\\S]*?)\\n\\}`,
    'm',
  );
  const m = re.exec(css);
  assert.ok(m, `missing block for ${themeId}`);
  const vars: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const vm = /^\s*(--[\w-]+):\s*([^;]+);/.exec(line);
    if (vm) vars[vm[1]] = vm[2].trim();
  }
  return vars;
}

/** Resolve one level of var(--token) aliases to a hex/rgb literal. */
function resolveToken(vars: Record<string, string>, name: string, depth = 0): string | null {
  if (depth > 4) return null;
  const raw = vars[name];
  if (!raw) return null;
  const alias = /^var\((--[\w-]+)\)$/.exec(raw);
  if (alias) return resolveToken(vars, alias[1], depth + 1);
  if (parseHexOrRgb(raw)) return raw;
  return null;
}

describe('theme-contrast', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/styles/tokens.css'), 'utf8');

  for (const themeId of THEME_IDS) {
    test(`${themeId}: fg on bg and fg on surface-1 meet WCAG AA`, () => {
      const vars = readThemeBlock(css, themeId);
      const fg = vars['--mn-fg'];
      const bg = vars['--mn-bg'];
      const surface1 = vars['--mn-surface-1'];
      assert.ok(fg && bg && surface1, `missing core tokens for ${themeId}`);
      assert.ok(contrastRatio(fg, bg) >= 4.5, `fg on bg contrast too low for ${themeId}`);
      assert.ok(contrastRatio(fg, surface1) >= 4.5, `fg on surface-1 contrast too low for ${themeId}`);
    });

    test(`${themeId}: muted text and accent ink meet WCAG AA on surfaces`, () => {
      const vars = readThemeBlock(css, themeId);
      const bg = vars['--mn-bg'];
      const surface1 = vars['--mn-surface-1'];
      const fgMuted = resolveToken(vars, '--mn-fg-muted');
      const accentInk = resolveToken(vars, '--mn-accent-ink');
      const accent = resolveToken(vars, '--mn-accent');
      const surfaceElevated = resolveToken(vars, '--mn-surface-elevated');
      assert.ok(bg && surface1, `missing surfaces for ${themeId}`);
      if (fgMuted) {
        assert.ok(
          contrastRatio(fgMuted, bg) >= 4.5,
          `fg-muted on bg ${contrastRatio(fgMuted, bg).toFixed(2)} < 4.5 for ${themeId}`,
        );
      }
      if (accentInk) {
        assert.ok(
          contrastRatio(accentInk, surface1) >= 4.5,
          `accent-ink on surface-1 ${contrastRatio(accentInk, surface1).toFixed(2)} < 4.5 for ${themeId}`,
        );
      }
      if (accent && surfaceElevated) {
        assert.ok(
          contrastRatio(accent, surfaceElevated) >= 4.5,
          `accent on surface-elevated ${contrastRatio(accent, surfaceElevated).toFixed(2)} < 4.5 for ${themeId}`,
        );
      }
    });
  }

  test('human-dark subtle text remains readable on the app background', () => {
    const vars = readThemeBlock(css, 'human-dark');
    const fg = resolveToken(vars, '--mn-fg-subtle');
    const bg = vars['--mn-bg'];
    assert.ok(fg && bg, 'human-dark subtle foreground and background tokens exist');
    assert.ok(
      contrastRatio(fg, bg) >= 4.5,
      `--mn-fg-subtle on --mn-bg ${contrastRatio(fg, bg).toFixed(2)} < 4.5 for human-dark`,
    );
  });

  for (const id of LIGHT_THEME_IDS) {
    test(`${id}: syntax highlights meet WCAG AA on code surfaces`, () => {
      const vars = readThemeBlock(css, id);
      const s0 = vars['--mn-surface-0'];
      const bg = vars['--mn-bg'];
      assert.ok(s0 && bg, 'surface tokens present');

      const pairs: Array<[string, string]> = [
        ['--mn-syntax-command', s0],
        ['--mn-syntax-name', s0],
        ['--mn-syntax-inline', s0],
        ['--mn-syntax-link', bg],
        ['--cm-attr', s0],
        ['--cm-title', s0],
        ['--cm-string', s0],
        ['--mn-fg-muted', s0],
      ];

      for (const [token, surface] of pairs) {
        const fg = resolveToken(vars, token);
        assert.ok(fg, `${token} resolves to a color`);
        assert.ok(
          contrastRatio(fg!, surface) >= 4.5,
          `${token} on ${surface} ${contrastRatio(fg!, surface).toFixed(2)} < 4.5`,
        );
      }
    });
  }

  // Shared context menu and command palette (Issues app v2, Phase 0). Both
  // render over --mn-bg in every family. `--mn-fg-subtle` was the first reach
  // for their secondary text and bottoms out near 1.8:1 in the light families;
  // these pairs pin the tokens that actually clear AA.
  for (const themeId of THEME_IDS) {
    test(`${themeId}: context menu and palette text meet WCAG AA`, () => {
      const vars = readThemeBlock(css, themeId);
      const bg = vars['--mn-bg'];
      assert.ok(bg, `missing --mn-bg for ${themeId}`);

      const pairs: Array<[string, string]> = [
        // .mn-menu__item / .mn-palette__row label
        ['--mn-fg', 'menu and palette row label'],
        // .mn-menu__heading, .mn-menu__shortcut, .mn-palette__group,
        // .mn-palette__group-tag, .mn-palette__shortcut, ::placeholder
        ['--mn-fg-muted', 'menu and palette secondary text'],
        // .mn-menu__item.is-danger
        ['--mn-danger-ink', 'destructive menu row label'],
      ];

      for (const [token, role] of pairs) {
        const fg = resolveToken(vars, token);
        assert.ok(fg, `${token} resolves to a color for ${themeId}`);
        assert.ok(
          contrastRatio(fg!, bg) >= 4.5,
          `${role} (${token}) on --mn-bg ${contrastRatio(fg!, bg).toFixed(2)} < 4.5 for ${themeId}`,
        );
      }
    });
  }

  // The Boards task detail panel. It is dense and small: the gutter labels in
  // the attempt log run at 9.5px and the file paths at 12.5px, which is exactly
  // where reaching for `--mn-fg-subtle` costs the most. Every one of those roles
  // is meaningful text, so they use `--mn-fg-muted`, and the panel's own surface
  // (`--mn-surface-0` for the log, `--mn-bg` for everything else) is pinned here
  // so a later token edit cannot quietly take them back under AA.
  for (const themeId of THEME_IDS) {
    test(`${themeId}: board task detail text meets WCAG AA`, () => {
      const vars = readThemeBlock(css, themeId);
      const bg = vars['--mn-bg'];
      const surface0 = vars['--mn-surface-0'];
      assert.ok(bg, `missing --mn-bg for ${themeId}`);
      assert.ok(surface0, `missing --mn-surface-0 for ${themeId}`);

      const pairs: Array<[string, string, string]> = [
        // .ov2-detail__title, .ov2-file__name
        ['--mn-fg', bg, 'task title and changed filenames'],
        // .ov2-detail__id, .ov2-facts__*, .ov2-panel__title, .ov2-panel__note,
        // .ov2-attempt__summary, .ov2-attempt__seed, .ov2-file__dir, .ov2-spec__hint
        ['--mn-fg-muted', bg, 'panel labels, facts, summaries and paths'],
        // .ov2-log__label, .ov2-log__trail, .ov2-log__more over the log surface
        ['--mn-fg-muted', surface0, 'attempt log gutter labels and tool output'],
        // .ov2-stat--add / .ov2-stat--del in the files header and per-row
        // badges. The `-ink` pair, because the base metric colours are tuned
        // for dots and bars and fall to 2.88:1 as 11px text on light families.
        ['--mn-success-ink', bg, 'added-line counts'],
        ['--mn-danger-ink', bg, 'removed-line counts'],
      ];

      for (const [token, surface, role] of pairs) {
        const fg = resolveToken(vars, token);
        assert.ok(fg, `${token} resolves to a color for ${themeId}`);
        assert.ok(
          contrastRatio(fg!, surface) >= 4.5,
          `${role} (${token}) ${contrastRatio(fg!, surface).toFixed(2)} < 4.5 for ${themeId}`,
        );
      }
    });
  }
});
