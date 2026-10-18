import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { DEFAULT_EDITOR_AI_COMPLETION } from '../../src/config/editor-ai-completion.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import {
  buildGitCommitMessagePrompt,
  extractCommitMessageFromChain,
  filterCommitMessagePatch,
  looksLikeDiffAnalysisText,
  normalizeCommitMessageOutput,
  resolveCommitMessageDisplayText,
  resolveGitCommitMessageBinding,
  sanitizeCommitMessage,
  stripReasoningFraming,
  stripThinkingFromCommitOutput,
  truncateStagedPatch,
} from '../../src/ui/git-commit-message-client.ts';

// ── truncateStagedPatch ──────────────────────────────────────────────────────

describe('truncateStagedPatch', () => {
  test('returns patch unchanged when under limit', () => {
    const patch = 'diff --git a/foo.ts b/foo.ts\n+hello';
    assert.equal(truncateStagedPatch(patch, 100), patch);
  });

  test('returns empty patch unchanged', () => {
    assert.equal(truncateStagedPatch(''), '');
  });

  test('appends truncation marker when over limit', () => {
    const patch = 'x'.repeat(120);
    const out = truncateStagedPatch(patch, 50);
    assert.ok(out.startsWith('x'.repeat(50)));
    assert.match(out, /diff truncated/);
  });
});

// ── filterCommitMessagePatch ─────────────────────────────────────────────────

describe('filterCommitMessagePatch', () => {
  test('collapses oversized per-file hunks', () => {
    const hunk = `diff --git a/src/big.ts b/src/big.ts\n${'+line\n'.repeat(900)}`;
    const out = filterCommitMessagePatch(hunk);
    assert.match(out, /file diff truncated/);
  });

  test('summarizes lock files instead of full diff', () => {
    const patch = 'diff --git a/package-lock.json b/package-lock.json\n+  "version": "2.0.0"';
    const out = filterCommitMessagePatch(patch);
    assert.match(out, /lock\/generated file/);
    assert.doesNotMatch(out, /"version": "2.0.0"/);
  });

  test('returns empty string for empty patch', () => {
    assert.equal(filterCommitMessagePatch(''), '');
  });
});

// ── buildGitCommitMessagePrompt ──────────────────────────────────────────────

describe('buildGitCommitMessagePrompt', () => {
  test('includes changed file list, scope, and diff in user message', () => {
    const messages = buildGitCommitMessagePrompt({
      changedPaths: ['src/a.ts', 'src/b.ts'],
      patch: '+added line',
      scope: 'staged',
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    const system = String(messages[0].content);
    const user = String(messages[1].content);
    assert.match(system, /WHY the change was made/);
    assert.match(system, /gitmoji/);
    assert.match(system, /Unicode gitmoji/);
    assert.match(system, /✨ feat/);
    assert.match(user, /staged changes only/);
    assert.match(user, /src\/a\.ts/);
    assert.match(user, /src\/b\.ts/);
    assert.match(user, /\+added line/);
  });

  test('notes working-tree scope when nothing is staged', () => {
    const messages = buildGitCommitMessagePrompt({
      changedPaths: ['src/a.ts'],
      patch: '+change',
      scope: 'working-tree',
    });
    const user = String(messages[1].content);
    assert.match(user, /working tree/);
    assert.match(user, /Nothing is staged/);
  });

  test('lists excluded paths for staged-only generation', () => {
    const messages = buildGitCommitMessagePrompt({
      changedPaths: ['src/a.ts'],
      excludedPaths: ['src/b.ts'],
      patch: '+change',
      scope: 'staged',
    });
    const user = String(messages[1].content);
    assert.match(user, /Excluded from this message/);
    assert.match(user, /src\/b\.ts/);
  });

  test('omits gitmoji guidance when disabled', () => {
    const messages = buildGitCommitMessagePrompt({
      changedPaths: ['src/a.ts'],
      patch: '+change',
      scope: 'staged',
      useGitmoji: false,
    });
    const system = String(messages[0].content);
    assert.doesNotMatch(system, /gitmoji/);
    assert.doesNotMatch(system, /✨/);
  });

  test('includes breaking change guidance in system prompt', () => {
    const messages = buildGitCommitMessagePrompt({
      changedPaths: ['src/a.ts'],
      patch: '+change',
      scope: 'staged',
    });
    assert.match(String(messages[0].content), /BREAKING CHANGE/);
  });
});

// ── sanitizeCommitMessage ────────────────────────────────────────────────────

describe('sanitizeCommitMessage', () => {
  test('strips markdown fences', () => {
    assert.equal(
      sanitizeCommitMessage('```\nfeat: add widget\n```'),
      'feat: add widget',
    );
  });

  test('strips wrapping quotes and prefixes', () => {
    assert.equal(sanitizeCommitMessage('"feat: ship it"'), 'feat: ship it');
    assert.equal(sanitizeCommitMessage('Commit message: fix: bug'), 'fix: bug');
  });

  test('preserves multiline body', () => {
    const raw = 'feat: add panel\n\nExplain why this matters.';
    assert.equal(sanitizeCommitMessage(raw), raw);
  });

  test('preserves gitmoji prefix', () => {
    const raw = '✨ feat(ui): add commit generator';
    assert.equal(sanitizeCommitMessage(raw), raw);
  });

  test('expands gitmoji shortcodes into Unicode', () => {
    assert.equal(
      sanitizeCommitMessage(':sparkles: feat(skills): generate index'),
      '✨ feat(skills): generate index',
    );
  });
});

// ── stripThinkingFromCommitOutput ────────────────────────────────────────────

describe('stripThinkingFromCommitOutput', () => {
  test('returns reply after inline thinking tags', () => {
    const raw = '<thinking>analyze diff</thinking>feat: add widget';
    assert.equal(stripThinkingFromCommitOutput(raw), 'feat: add widget');
  });

  test('returns empty while thinking block is still open', () => {
    const raw = '<thinking>still analyzing the diff';
    assert.equal(stripThinkingFromCommitOutput(raw), '');
  });
});

describe('extractCommitMessageFromChain', () => {
  test('extracts the last conventional commit block from a reasoning chain', () => {
    const chain = [
      'The user wants a commit message for these git changes.',
      'I need to analyze the diff carefully.',
      'The diff shows changes to git-commit-message-client.ts.',
      "I'll use a fix type since this is a bug fix.",
      '',
      'fix(git): extract commit message from reasoning chain',
      '',
      'Strip mirrored reasoning instead of dumping the full chain.',
    ].join('\n');

    const result = extractCommitMessageFromChain(chain);
    assert.match(result, /^fix\(git\):/);
    assert.match(result, /Strip mirrored reasoning/);
  });

  test('extracts gitmoji-prefixed conventional commit', () => {
    const chain = [
      'Let me analyze the diff.',
      '',
      '✨ feat(git): improve commit message prompts',
      '',
      'Body explains why the change matters.',
    ].join('\n');

    const result = extractCommitMessageFromChain(chain);
    assert.match(result, /^✨ feat\(git\):/);
    assert.match(result, /Body explains why/);
  });

  test('expands gitmoji shortcodes on conventional subjects', () => {
    assert.equal(
      extractCommitMessageFromChain(':sparkles: feat(git): add shortcode expansion'),
      '✨ feat(git): add shortcode expansion',
    );
  });

  test('extracts plain commit text from trailing paragraph', () => {
    const chain = [
      'Let me read the diff.',
      'The changes update git panel behavior.',
      '',
      'Fix git auto commit message generation',
    ].join('\n');

    assert.equal(extractCommitMessageFromChain(chain), 'Fix git auto commit message generation');
  });

  test('returns empty for reasoning-only output', () => {
    assert.equal(
      extractCommitMessageFromChain('Let me analyze the staged diff carefully.'),
      '',
    );
  });

  test('skips heuristic fallback in strict mode', () => {
    assert.equal(
      extractCommitMessageFromChain('Fix git auto commit message generation', {
        allowHeuristicFallback: false,
      }),
      '',
    );
  });

  test('rejects markdown diff analysis without a conventional subject', () => {
    const analysis = [
      '2.  **Identify Key Changes & Intent:**',
      '   - Removed the "Not sure which to pick?" auto-detection note from the download page (UI/UX cleanup).',
      '   - Updated platform icons to official logos (Windows, macOS, Linux) for better visual fidelity.',
      '   - Removed "Continue.dev" from the comparison table on features page (likely no longer relevant).',
      '   - Removed `<base>` tag from index.html (likely fixing a',
    ].join('\n');

    assert.equal(extractCommitMessageFromChain(analysis), '');
    assert.equal(
      resolveCommitMessageDisplayText(analysis, '', { reasoningFallback: true }),
      '',
    );
    assert.equal(
      resolveCommitMessageDisplayText(analysis, '', { reasoningFallback: false }),
      '',
    );
  });

  test('extracts conventional commit after markdown diff analysis', () => {
    const mixed = [
      '2. **Identify Key Changes & Intent:**',
      '- Removed stale copy from the download page.',
      '',
      'feat(site): refresh download page icons and copy',
      '',
      'Align platform branding with current marketing assets.',
    ].join('\n');

    assert.match(extractCommitMessageFromChain(mixed), /^feat\(site\):/);
  });
});

// ── looksLikeDiffAnalysisText ────────────────────────────────────────────────

describe('looksLikeDiffAnalysisText', () => {
  test('detects numbered markdown diff walkthroughs', () => {
    const sample = '2. **Identify Key Changes & Intent:**\n- Removed stale copy.';
    assert.equal(looksLikeDiffAnalysisText(sample), true);
  });
});

// ── resolveCommitMessageDisplayText ──────────────────────────────────────────

describe('resolveCommitMessageDisplayText', () => {
  test('prefers content channel over reasoning', () => {
    assert.equal(
      resolveCommitMessageDisplayText('feat: from content', 'fix: from reasoning', {
        reasoningFallback: true,
      }),
      'feat: from content',
    );
  });

  test('does not surface mirrored reasoning chains in content', () => {
    const chain = [
      'The user wants a commit message.',
      'I need to analyze the diff.',
      '',
      'feat(git): add commit generator',
    ].join('\n');

    assert.equal(
      resolveCommitMessageDisplayText(chain, chain, { reasoningFallback: true }),
      'feat(git): add commit generator',
    );
  });

  test('does not stream partial reasoning while the chain is still growing', () => {
    const partial = 'The user wants a commit message.\nI need to analyze the diff.';
    assert.equal(
      resolveCommitMessageDisplayText(partial, partial, { reasoningFallback: false }),
      '',
    );
  });

  test('does not stream heuristic reasoning paragraphs before a conventional subject', () => {
    const partial = [
      'Need to focus on the git module changes.',
      'The diff updates commit message extraction.',
    ].join('\n');
    assert.equal(
      resolveCommitMessageDisplayText(partial, '', { reasoningFallback: false }),
      '',
    );
  });

  test('streams partial conventional commit subjects while generation is in flight', () => {
    const partial = [
      'The user wants a commit message.',
      'fix(git): extract commit message from reasoning',
    ].join('\n');
    assert.equal(
      resolveCommitMessageDisplayText(partial, '', { reasoningFallback: false }),
      'fix(git): extract commit message from reasoning',
    );
  });

  test('prefers reasoning channel over heuristic content false positives', () => {
    const content = [
      'Need to focus on the git module changes.',
      'The diff updates commit message extraction.',
    ].join('\n');
    const reasoning = [
      'Let me analyze the diff.',
      '',
      'fix(git): ignore reasoning paragraphs during streaming',
    ].join('\n');

    assert.equal(
      resolveCommitMessageDisplayText(content, reasoning, { reasoningFallback: true }),
      'fix(git): ignore reasoning paragraphs during streaming',
    );
  });

  test('falls back to reasoning channel when content is empty', () => {
    const reasoning = [
      'Analyzing patch.',
      '',
      'fix(ui): handle empty diff',
    ].join('\n');

    assert.equal(
      resolveCommitMessageDisplayText('', reasoning, { reasoningFallback: true }),
      'fix(ui): handle empty diff',
    );
  });

  test('matches clean content fast path', () => {
    assert.equal(
      resolveCommitMessageDisplayText('✨ feat: ship it', '', { reasoningFallback: true }),
      '✨ feat: ship it',
    );
  });
});

// ── normalizeCommitMessageOutput ─────────────────────────────────────────────

describe('normalizeCommitMessageOutput', () => {
  test('accepts plain commit text without conventional prefix', () => {
    assert.equal(
      normalizeCommitMessageOutput('Fix git auto commit message generation'),
      'Fix git auto commit message generation',
    );
  });
});

// ── stripReasoningFraming ────────────────────────────────────────────────────

describe('stripReasoningFraming', () => {
  test('removes trailing meta commentary', () => {
    const raw = 'feat(ui): add generator\n\nLooks good.';
    assert.equal(stripReasoningFraming(raw), 'feat(ui): add generator');
  });
});

// ── resolveGitCommitMessageBinding ───────────────────────────────────────────

describe('resolveGitCommitMessageBinding', () => {
  test('uses chat model when editor AI is disabled', async () => {
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;

    const chat = createEmptyChatObject('');
    chat.providerId = 'lm-studio-local'; chat.modelId = 'glm-5.2';
    setSessionStateForTests({ chats: [chat], activeId: chat.id });

    const sel = document.createElement('select');
    sel.id = 'modelSelect';
    const opt = document.createElement('option');
    opt.value = encodeModelSelectKey('lm-studio-local', 'glm-5.2');
    sel.appendChild(opt);
    sel.value = opt.value;
    document.body.appendChild(sel);

    const binding = await resolveGitCommitMessageBinding({
      ...DEFAULT_EDITOR_AI_COMPLETION,
      enabled: false,
      useChatModel: false,
      providerId: 'opencodego',
      modelId: 'qwen3.6-plus',
    });

    assert.equal(binding.providerId, 'lm-studio-local');
    assert.equal(binding.modelId, 'glm-5.2');
  });
});
