/**
 * PTY xterm ANSI palette contrast on light themes (PowerShell/npm highlighting).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import path from 'node:path';
import { buildTerminalXtermTheme } from '../../src/ui/terminal-xterm-theme.ts';

const LIGHT_THEME_IDS = [
  'swamp-light',
  'desert-light',
  'ocean-light',
  'coral-light',
  'mono-light',
  'matrix-light',
] as const;

const DARK_THEME_IDS = [
  'swamp-dark',
  'desert-dark',
  'ocean-dark',
  'coral-dark',
  'mono-dark',
  'matrix-dark',
] as const;

const ANSI_KEYS = [
  'foreground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

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

function mockLightStyle(vars: Record<string, string>): CSSStyleDeclaration {
  return {
    colorScheme: 'light',
    getPropertyValue(name: string): string {
      return vars[name] ?? '';
    },
  } as CSSStyleDeclaration;
}

function mockDarkStyle(vars: Record<string, string>): CSSStyleDeclaration {
  return {
    colorScheme: 'dark',
    getPropertyValue(name: string): string {
      return vars[name] ?? '';
    },
  } as CSSStyleDeclaration;
}

describe('terminal xterm ANSI palette (light)', () => {
  const tokensPath = path.join(process.cwd(), 'src/styles/tokens.css');
  const tokensCss = readFileSync(tokensPath, 'utf8');

  for (const themeId of LIGHT_THEME_IDS) {
    test(`${themeId}: ANSI colors meet 4.5:1 on terminal background`, () => {
      const vars = readThemeBlock(tokensCss, themeId);
      const theme = buildTerminalXtermTheme(mockLightStyle(vars));
      const bg = theme.background!;
      const minRatio = 4.5;

      for (const key of ANSI_KEYS) {
        const fg = theme[key];
        assert.ok(fg, `${themeId} missing ${key}`);
        const ratio = contrastRatio(fg, bg);
        assert.ok(
          ratio >= minRatio,
          `${themeId} ${key} contrast ${ratio.toFixed(2)} < ${minRatio} (${fg} on ${bg})`,
        );
      }
    });
  }

  test('swamp-light maps yellow from readable gold tokens and brightBlack to fg-muted', () => {
    const vars = readThemeBlock(tokensCss, 'swamp-light');
    const theme = buildTerminalXtermTheme(mockLightStyle(vars));
    assert.equal(theme.brightBlack, vars['--mn-fg-muted']);
    assert.ok(contrastRatio(theme.yellow!, theme.background!) >= 4.5);
  });
});

describe('terminal xterm selection contrast (light)', () => {
  const tokensPath = path.join(process.cwd(), 'src/styles/tokens.css');
  const tokensCss = readFileSync(tokensPath, 'utf8');
  const minSelectionContrast = 2;

  for (const themeId of LIGHT_THEME_IDS) {
    test(`${themeId}: selection background stands out from terminal canvas`, () => {
      const vars = readThemeBlock(tokensCss, themeId);
      const theme = buildTerminalXtermTheme(mockLightStyle(vars));
      const ratio = contrastRatio(theme.selectionBackground!, theme.background!);
      assert.ok(
        ratio >= minSelectionContrast,
        `${themeId} selection contrast ${ratio.toFixed(2)} < ${minSelectionContrast}`,
      );
    });
  }

  test('swamp-light: selection text stays readable on the workbench sheet', () => {
    const vars = readThemeBlock(tokensCss, 'swamp-light');
    const theme = buildTerminalXtermTheme(mockLightStyle(vars));
    assert.equal(theme.background, vars['--mn-surface-0']);
    assert.ok(contrastRatio(theme.selectionForeground!, theme.selectionBackground!) >= 4.5);
  });
});

describe('terminal xterm selection contrast (dark)', () => {
  const tokensPath = path.join(process.cwd(), 'src/styles/tokens.css');
  const tokensCss = readFileSync(tokensPath, 'utf8');
  const minSelectionContrast = 2;

  for (const themeId of DARK_THEME_IDS) {
    test(`${themeId}: selection background stands out from terminal canvas`, () => {
      const vars = readThemeBlock(tokensCss, themeId);
      const theme = buildTerminalXtermTheme(mockDarkStyle(vars));
      const ratio = contrastRatio(theme.selectionBackground!, theme.background!);
      assert.ok(
        ratio >= minSelectionContrast,
        `${themeId} selection contrast ${ratio.toFixed(2)} < ${minSelectionContrast}`,
      );
    });
  }

  test('swamp-dark: selection text stays readable on the workbench sheet', () => {
    const vars = readThemeBlock(tokensCss, 'swamp-dark');
    const theme = buildTerminalXtermTheme(mockDarkStyle(vars));
    assert.equal(theme.background, vars['--mn-surface-0']);
    assert.ok(contrastRatio(theme.selectionForeground!, theme.selectionBackground!) >= 4.5);
  });
});
