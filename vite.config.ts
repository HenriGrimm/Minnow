import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig, normalizePath } from 'vite';

// The full highlight.js entry requires lib/ grammars. Use those same modules
// for common fences so each grammar is bundled once across both paths.
const highlightLib = normalizePath(dirname(createRequire(import.meta.url).resolve('highlight.js/lib/core')));

/**
 * Vite injects the module script before extracted CSS in `index.html`, so JS can run
 * before the stylesheet finishes loading. Hoist bundle `<link rel="stylesheet">` tags
 * ahead of the entry `<script type="module">` in `<head>` so CSS starts earlier.
 */
/** Strip .eot / .woff from Uicons @font-face — Chromium only fetches .woff2. */
function uiconsWoff2OnlyPlugin(): Plugin {
  function stripNonWoff2Src(css: string): string {
    return css
      .replace(/,url\([^)]+\)\s*format\(["']woff["']\)/g, '')
      .replace(/,url\([^)]+\)\s*format\(["']embedded-opentype["']\)/g, '');
  }

  return {
    name: 'minnow-uicons-woff2-only',
    transform(code, id) {
      if (!id.endsWith('.css')) return null;
      if (!code.includes('uicons-regular-rounded') && !code.includes('uicons-solid-rounded')) {
        return null;
      }
      const trimmed = stripNonWoff2Src(code);
      return trimmed === code ? null : { code: trimmed, map: null };
    },
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (/\.(woff|eot)(\?|$)/i.test(fileName) && /uicons/i.test(fileName)) {
          delete bundle[fileName];
        }
      }
    },
  };
}

function cssBeforeEntryScriptPlugin(): Plugin {
  return {
    name: 'minnow-css-before-entry-script',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const linkTags = html.match(/<link rel="stylesheet"[^>]*>/g);
        if (!linkTags?.length) return html;

        let out = html;
        for (const tag of linkTags) {
          out = out.replace(tag, '');
        }
        const insertion = linkTags
          .map((tag) => {
            const href = tag.match(/href="([^"]+)"/)?.[1];
            if (!href) return tag;
            const cross = tag.includes('crossorigin') ? ' crossorigin' : '';
            return `<link rel="preload" as="style" href="${href}"${cross}>\n  ${tag}`;
          })
          .join('\n  ');
        return out.replace(
          /(<script type="module"[^>]*><\/script>)/,
          `${insertion}\n  $1`,
        );
      },
    },
  };
}

/**
 * CodeMirror language-data pre-bundles into many hashed `dist-*.js` chunks under
 * `node_modules/.vite/deps`. Pre-include editor deps and crawl editor entries so
 * cold start finishes before clients request stale chunk URLs.
 */
const CODE_MIRROR_OPTIMIZE_INCLUDE = [
  '@codemirror/language-data',
  '@codemirror/language',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/lang-angular',
  '@codemirror/lang-cpp',
  '@codemirror/lang-css',
  '@codemirror/lang-go',
  '@codemirror/lang-html',
  '@codemirror/lang-java',
  '@codemirror/lang-javascript',
  '@codemirror/lang-json',
  '@codemirror/lang-less',
  '@codemirror/lang-markdown',
  '@codemirror/lang-php',
  '@codemirror/lang-python',
  '@codemirror/lang-rust',
  '@codemirror/lang-sass',
  '@codemirror/lang-sql',
  '@codemirror/lang-vue',
  '@codemirror/lang-wast',
  '@codemirror/lang-xml',
  '@codemirror/lang-yaml',
] as const;

/** Client modules that lazy-load the editor and trigger language-data discovery. */
const EDITOR_WARMUP_FILES = [
  './src/main.ts',
  './src/ui/file-viewer.ts',
  './src/ui/editor-language.ts',
] as const;

/** Rollup manual chunk groups for heavy vendor libraries. */
function manualChunkForNodeModule(id: string): string | undefined {
  // Keep Vite's dynamic-import preload helper out of vendor-* chunks. If it lands
  // inside vendor-codemirror, every `import()` in the app eagerly pulls ~1.6 MB of CM.
  if (id.includes('\0vite/preload-helper') || id.includes('vite/preload-helper')) {
    return 'vite-preload';
  }
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('@codemirror') || id.includes('/codemirror/')) {
    return 'vendor-codemirror';
  }
  if (id.includes('@xterm')) {
    return 'vendor-xterm';
  }
  if (id.includes('/recharts/') || id.includes('/d3-')) {
    return 'vendor-charts';
  }
  return undefined;
}

/** Vite build: relative asset paths for PWA / static hosting. */
export default defineConfig({
  base: './',
  envPrefix: ['VITE_', 'MINNOW_'],
  resolve: {
    alias: [{ find: /^highlight\.js\/lib\/(core|languages\/[\w-]+)$/, replacement: `${highlightLib}/$1.js` }],
  },
  plugins: [uiconsWoff2OnlyPlugin(), cssBeforeEntryScriptPlugin()],
  optimizeDeps: {
    // Finish the first dep crawl before serving requests (avoids stale dist-* chunk URLs).
    holdUntilCrawlEnd: true,
    entries: ['index.html', ...EDITOR_WARMUP_FILES.map((f) => f.slice(2))],
    include: [...CODE_MIRROR_OPTIMIZE_INCLUDE, 'highlight.js'],
  },
  server: {
    // chokidar opens one fs.watch handle per *file*, not per directory, and on Windows
    // each handle costs ~100 KB of native memory. Agent worktrees under .claude/ (4.7k
    // files) plus packaged release output pushed the dev server to ~11k watchers and
    // ~1.1 GB resident outside the V8 heap. Neither tree is a dev-server input.
    watch: {
      ignored: ['**/.claude/**', '**/release/**'],
    },
    warmup: {
      clientFiles: [...EDITOR_WARMUP_FILES],
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    modulePreload: {
      // A shared helper can reference CodeMirror. Only editor hosts preload it.
      resolveDependencies(filename, deps) {
        const isEditorHost =
          /file-viewer|editor-|lsp-editor|codemirror|git-commit/i.test(filename);
        return isEditorHost ? deps : deps.filter((dep) => !/vendor-codemirror/i.test(dep));
      },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          return manualChunkForNodeModule(id);
        },
      },
    },
  },
});
