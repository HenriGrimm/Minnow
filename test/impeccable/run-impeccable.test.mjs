/**
 * run_impeccable harness vs CLI routing, detect defaults, and result formatting.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { listAcceptedRunImpeccableCommands } from '../../server/impeccable/command-routing.js';
import {
  DETECT_FINDINGS_EXIT_CODE,
  formatFindingsCountPrefix,
  formatImpeccableCliResult,
  formatImpeccableTimeoutMessage,
  hasHttpUrlTarget,
  resolveBundledImpeccableCliPath,
  resolveDetectTargets,
  splitTargetArgs,
  toolRunImpeccable,
} from '../../server/impeccable/run-impeccable.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SKILL_DIR = path.join(PROJECT_ROOT, 'src', 'skills', 'impeccable');

async function makeTempWorkspace() {
  return mkdtemp(path.join(os.tmpdir(), 'minnow-impeccable-'));
}

describe('toolRunImpeccable', () => {
  it('resolveBundledImpeccableCliPath uses appRoot node_modules', () => {
    const cliPath = resolveBundledImpeccableCliPath(PROJECT_ROOT);
    assert.match(cliPath, /node_modules[\\/]impeccable[\\/]cli[\\/]bin[\\/]cli\.js$/);
    assert.ok(fs.existsSync(cliPath), 'bundled impeccable CLI should exist in dev install');
  });

  it('accepts only detect and live for spawnable commands', () => {
    assert.deepEqual(listAcceptedRunImpeccableCommands(), ['detect', 'live']);
  });

  it('returns harness guidance for teach (init alias) without spawning CLI', async () => {
    const out = await toolRunImpeccable(
      { command: 'teach' },
      PROJECT_ROOT,
      PROJECT_ROOT,
      SKILL_DIR,
    );
    const text = String(out.result ?? '');
    assert.match(text, /harness command/i);
    assert.match(text, /reference\/init\.md/);
    assert.match(text, /# Init Flow|Init Flow|init/i);
    assert.doesNotMatch(text, /failed to spawn npx impeccable/i);
  });

  it('returns shape reference body when shape is passed mistakenly', async () => {
    const out = await toolRunImpeccable(
      { command: 'shape', target: 'landing page' },
      PROJECT_ROOT,
      PROJECT_ROOT,
      SKILL_DIR,
    );
    const text = String(out.result ?? '');
    assert.match(text, /harness command/i);
    assert.match(text, /reference\/shape\.md/);
    assert.match(text, /Discovery Interview|design brief/i);
  });

  it('returns harness guidance for audit', async () => {
    const out = await toolRunImpeccable(
      { command: 'audit' },
      PROJECT_ROOT,
      PROJECT_ROOT,
      SKILL_DIR,
    );
    assert.match(String(out.result ?? ''), /harness command/i);
  });

  it('accepts detect and does not return harness-only guidance', async () => {
    const out = await toolRunImpeccable(
      { command: 'detect', target: 'index.html' },
      PROJECT_ROOT,
      PROJECT_ROOT,
      SKILL_DIR,
    );
    const text = String(out.result ?? '');
    assert.doesNotMatch(text, /is a harness command/i);
  });

  it('detect without target on a tiny tree finishes quickly and does not hang on stdin', async () => {
    const tinyRoot = await makeTempWorkspace();
    try {
      await writeFile(
        path.join(tinyRoot, 'index.html'),
        '<!doctype html><html><body><h1>Hi</h1></body></html>',
        'utf8',
      );
      const start = Date.now();
      const out = await toolRunImpeccable({ command: 'detect' }, PROJECT_ROOT, tinyRoot, SKILL_DIR);
      const elapsed = Date.now() - start;
      const text = String(out.result ?? '');
      assert.ok(elapsed < 5000, `detect without target took ${elapsed}ms (expected <5000ms)`);
      assert.doesNotMatch(text, /timed out/i);
      assert.doesNotMatch(text, /is a harness command/i);
    } finally {
      await rm(tinyRoot, { recursive: true, force: true });
    }
  });

  it('omitted detect target scans UI roots and ignores a sibling server tree', async () => {
    const root = await makeTempWorkspace();
    try {
      await mkdir(path.join(root, 'src', 'ui'), { recursive: true });
      await mkdir(path.join(root, 'src', 'styles'), { recursive: true });
      await mkdir(path.join(root, 'server'), { recursive: true });
      await writeFile(path.join(root, 'index.html'), '<!doctype html><html><body></body></html>', 'utf8');
      await writeFile(path.join(root, 'src', 'ui', 'app.ts'), 'export {}\n', 'utf8');
      await writeFile(path.join(root, 'src', 'styles', 'app.css'), 'body { color: black; }\n', 'utf8');
      await writeFile(
        path.join(root, 'server', 'decoy.ts'),
        'const x = "Inter"; export {}\n'.repeat(200),
        'utf8',
      );
      const start = Date.now();
      const out = await toolRunImpeccable({ command: 'detect' }, PROJECT_ROOT, root, SKILL_DIR);
      const elapsed = Date.now() - start;
      const text = String(out.result ?? '');
      assert.ok(elapsed < 5000, `UI-root detect took ${elapsed}ms (expected <5000ms)`);
      assert.doesNotMatch(text, /timed out/i);
      assert.doesNotMatch(text, /decoy\.ts/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects http(s) detect targets without spawning', async () => {
    const start = Date.now();
    const out = await toolRunImpeccable(
      { command: 'detect', target: 'https://example.com' },
      PROJECT_ROOT,
      PROJECT_ROOT,
      SKILL_DIR,
    );
    const elapsed = Date.now() - start;
    const text = String(out.result ?? '');
    assert.ok(elapsed < 2000, `URL reject took ${elapsed}ms`);
    assert.match(text, /does not support URL targets/i);
    assert.doesNotMatch(text, /timed out/i);
  });
});

describe('resolveDetectTargets', () => {
  it('splits an explicit whitespace target list', () => {
    assert.deepEqual(splitTargetArgs('src/ index.html'), ['src/', 'index.html']);
    assert.deepEqual(hasHttpUrlTarget(['https://example.com']), true);
    assert.deepEqual(hasHttpUrlTarget(['src/ui']), false);
  });

  it('prefers UI roots over a sibling server tree (never silent .)', async () => {
    const root = await makeTempWorkspace();
    try {
      await mkdir(path.join(root, 'src', 'ui'), { recursive: true });
      await mkdir(path.join(root, 'src', 'styles'), { recursive: true });
      await mkdir(path.join(root, 'server'), { recursive: true });
      await writeFile(path.join(root, 'index.html'), '<!doctype html><html></html>', 'utf8');
      await writeFile(path.join(root, 'src', 'ui', 'app.ts'), 'export {}\n', 'utf8');
      await writeFile(path.join(root, 'src', 'styles', 'app.css'), 'body{}\n', 'utf8');
      await writeFile(path.join(root, 'server', 'huge.ts'), 'export {}\n', 'utf8');

      const targets = resolveDetectTargets(root, '');
      assert.deepEqual(targets, ['src/ui', 'src/styles', 'index.html']);
      assert.ok(!targets.includes('.'));
      assert.ok(!targets.includes('server'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to source dirs when UI roots are missing', async () => {
    const root = await makeTempWorkspace();
    try {
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src', 'main.ts'), 'export {}\n', 'utf8');
      assert.deepEqual(resolveDetectTargets(root, ''), ['src']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to index.html then .', async () => {
    const htmlRoot = await makeTempWorkspace();
    const emptyRoot = await makeTempWorkspace();
    try {
      await writeFile(
        path.join(htmlRoot, 'index.html'),
        '<!doctype html><html></html>',
        'utf8',
      );
      assert.deepEqual(resolveDetectTargets(htmlRoot, ''), ['index.html']);
      assert.deepEqual(resolveDetectTargets(emptyRoot, ''), ['.']);
      assert.deepEqual(resolveDetectTargets(htmlRoot, '.'), ['.']);
    } finally {
      await rm(htmlRoot, { recursive: true, force: true });
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('formatImpeccableCliResult', () => {
  it('does not treat detect exit 2 as a spawn error', () => {
    const findings = JSON.stringify([
      { file: 'index.html', antipattern: 'ai-color-palette', snippet: 'violet' },
    ]);
    const text = formatImpeccableCliResult({
      code: DETECT_FINDINGS_EXIT_CODE,
      commandLabel: 'detect',
      stdout: findings,
      stderr: '',
      projectRoot: '/tmp/app',
      spawnLabel: 'impeccable cli',
      targets: ['index.html'],
    });
    assert.doesNotMatch(text, /exited 2/);
    assert.match(text, /^1 anti-pattern found\./);
    assert.match(text, /ai-color-palette/);
  });

  it('treats string exit code 2 as findings, not Error', () => {
    const text = formatImpeccableCliResult({
      code: '2',
      commandLabel: 'detect',
      stdout: '[]',
      stderr: '',
      projectRoot: '/tmp/app',
      spawnLabel: 'impeccable cli',
    });
    assert.doesNotMatch(text, /^Error:/);
    assert.doesNotMatch(text, /exited 2/);
  });

  it('still reports other non-zero exits as errors', () => {
    const text = formatImpeccableCliResult({
      code: 1,
      commandLabel: 'detect',
      stdout: '',
      stderr: 'boom',
      projectRoot: '/tmp/app',
      spawnLabel: 'impeccable cli',
    });
    assert.match(text, /Error: impeccable detect exited 1/);
    assert.match(text, /boom/);
  });

  it('timeout message names targets and suggests a narrower scan', () => {
    const text = formatImpeccableTimeoutMessage({
      commandLabel: 'detect',
      spawnLabel: 'impeccable cli',
      projectRoot: '/tmp/app',
      targets: ['src/ui', 'index.html'],
      timeoutMs: 60_000,
    });
    assert.match(text, /timed out after 60s/);
    assert.match(text, /targets: src\/ui, index\.html/);
    assert.match(text, /narrower target/);
  });

  it('formatFindingsCountPrefix reads a JSON array', () => {
    assert.equal(formatFindingsCountPrefix('[]'), '0 anti-patterns found.\n');
    assert.equal(formatFindingsCountPrefix('not json'), '');
  });
});

describe('detect findings exit (live CLI)', () => {
  it('returns findings without Error exited 2', async () => {
    const root = await makeTempWorkspace();
    try {
      // Purple/violet accents are a known detector hit (ai-color-palette).
      await writeFile(
        path.join(root, 'index.html'),
        '<!doctype html><html><head><style>h1{color:#7c3aed}</style></head><body><h1>Hi</h1></body></html>',
        'utf8',
      );
      const out = await toolRunImpeccable(
        { command: 'detect', target: 'index.html' },
        PROJECT_ROOT,
        root,
        SKILL_DIR,
      );
      const text = String(out.result ?? '');
      assert.doesNotMatch(text, /exited 2/i);
      assert.doesNotMatch(text, /timed out/i);
      assert.doesNotMatch(text, /is a harness command/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
