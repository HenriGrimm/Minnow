import {
  cancelGeneration,
  createGeneration,
  formatGenerationErrorMessage,
  subscribeToGeneration,
  type GenerationEndEvent,
} from '../api/generations';
import { modelCache } from '../app-state';
import { splitThinkingSegments } from '../api/reasoning';
import { applyUtilityThinkingOff } from '../agents/merge-thinking-body';
import { BenchmarkStreamReasoningAccumulator } from '../benchmark/stream-text';
import { StreamingContentAccumulator } from '../api/message-content';
import { loadEditorAiCompletionConfig, type EditorAiCompletionConfig } from '../config/editor-ai-completion';
import { loadUtilityModelConfig, utilityModelOverride } from '../config/utility-model-meta';
import {
  loadGitCommitMessageConfig,
  type GitCommitMessageConfig,
} from '../config/git-commit-message-meta';
import { encodeModelSelectKey } from '../lib/model-select-key';
import { ensureChatModelLoadedForTurn } from '../api/ensure-chat-model-loaded';
import {
  LIBRARY_MODEL_NOT_LOADED_MESSAGE,
  resolveLibraryRequestBinding,
} from '../models/library-request-binding';
import { LIBRARY_MODEL_PROVIDER_ID } from '../models/model-select-library';
import { expandGitmojiShortcodes } from '../lib/gitmoji-shortcodes.mjs';
import { catalogCapabilitiesFromRow } from '../providers/model-capabilities';
import { resolveProvider } from '../providers/store';
import type { ApiMessage, ChatCompletionChunk } from '../types';
import {
  EDITOR_AI_EMPTY_COMPLETION_MESSAGE,
  EDITOR_AI_REQUEST_FAILED_MESSAGE,
  resolveEditorAiBinding,
  validateEditorAiBinding,
  type EditorAiBinding,
} from './editor-ai-binding';

const COMMIT_TYPES = 'feat|fix|docs|style|refactor|test|chore|perf|build|ci';
const COMMIT_TYPE = `(?:${COMMIT_TYPES})`;
const GITMOJI_PREFIX = '[\\p{Extended_Pictographic}\\u200d\\ufe0f\\s]*';
const CONVENTIONAL_COMMIT_LINE_RE = new RegExp(
  `^${GITMOJI_PREFIX}${COMMIT_TYPE}(?:\\([^)]+\\))?:\\s+\\S`,
  'iu',
);

/** Lines that are model reasoning / meta commentary, not commit body text. */
const REASONING_LINE_RE =
  /^\s*(?:the user |they are |the question |i can |i need |i should |i will |i(?:'m| am) going |let me |thinking(?:\s+process)?\s*:|looking at |based on |(?:okay|alright|hmm|right|so|well|first|next|now)[,.]?\s+(?:the|i|let|this|that|so|now|here)|looks good|that should|this looks|the diff |the changes |this diff |these changes |analy(?:s|z)(?:e|ing)|i(?:'ll| will) (?:use|write|draft|create|choose|pick|go with)|need to |focus on |to draft |to write )/i;

/** LM Studio / local models often emit markdown diff walkthroughs before (or instead of) a commit. */
const DIFF_ANALYSIS_LINE_RE =
  /^\s*(?:\d+\.\s+(?:\*\*)?|[-*]\s+(?:Removed|Updated|Added|Changed|Fixed|Deleted|Replaced|Modified|Introduced)\b|\*\*[^*]+:\*\*)/i;

const DIFF_ANALYSIS_TEXT_RE =
  /\bidentify key changes\b|\bkey changes\s*&\s*intent\b|\(likely\b|\(probably\b|\(possibly\b|ui\/ux cleanup\b/i;

export interface CommitMessageExtractOptions {
  /** When false, only explicit prefixes and conventional commit lines qualify. */
  allowHeuristicFallback?: boolean;
}

const MAX_PATCH_CHARS = 12_000;
const MAX_FILE_HUNK_CHARS = 4_000;

/** File patterns whose diffs are low-signal for commit message generation. */
const LOW_SIGNAL_FILE_RE =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|\.min\.(?:js|css)|dist\/|\.snap)$/i;

export type GitCommitMessageScope = 'staged' | 'working-tree';

export interface GitCommitMessagePromptInput {
  changedPaths: string[];
  patch: string;
  scope: GitCommitMessageScope;
  /** Paths changed in the repo but excluded from this commit message. */
  excludedPaths?: string[];
  useGitmoji?: boolean;
}

export interface GitCommitMessageRequest extends GitCommitMessagePromptInput {
  signal: AbortSignal;
  onPartial?: (text: string) => void;
}

export interface GitCommitMessageResult {
  text: string | null;
  error?: string;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildCommitMessageSystemPrompt(useGitmoji: boolean): string {
  const lines = [
    'You write high-quality git commit messages from git diffs.',
    'Output ONLY the commit message — no markdown fences, explanations, or prefixes like "Commit message:".',
    'Do not use chain-of-thought, reasoning commentary, or thinking/reasoning tags — go straight to the commit text.',
    'Never output numbered steps, bullet analyses, diff walkthroughs, or markdown headers — go straight to the commit text.',
    '',
    'Subject line:',
    '- Imperative mood, ≤72 characters, no trailing period',
    '- Conventional commits: type(scope): subject',
    `- Types: ${COMMIT_TYPES.replace(/\|/g, ', ')}`,
    '- Derive scope from the primary module or area changed (e.g. git, ui, api)',
    '',
    'Body (optional, after a blank line):',
    '- Explain WHY the change was made — motivation, user impact, trade-offs',
    '- Do NOT list files or repeat the diff line-by-line',
    '- If the change breaks public APIs or behavior, add a footer: BREAKING CHANGE: description',
    '',
    'Rules:',
    '- Describe ONLY the files in the stated scope — never mention unrelated paths',
    '- Never include secrets, credentials, or .env values',
    '- Match the intent of the diff, not surface-level edits',
  ];

  if (useGitmoji) {
    lines.push(
      '',
      'Prefix the subject with one Unicode gitmoji character — never colon shortcodes such as :sparkles: or :bug:.',
      '✨ feat, 🐛 fix, 📝 docs, 💄 style, ♻️ refactor, ✅ test, 🔧 chore, ⚡ perf, 👷 build, 🎨 ui',
      'Example: ✨ feat(git): add AI commit message generator',
    );
  }

  return lines.join('\n');
}

/** Cap oversized staged diffs so prompts stay within model context. */
export function truncateStagedPatch(patch: string, maxChars = MAX_PATCH_CHARS): string {
  const trimmed = patch.trimEnd();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n... (diff truncated)`;
}

/** Collapse oversized per-file hunks and skip low-signal lock/generated files. */
export function filterCommitMessagePatch(patch: string): string {
  const trimmed = patch.trim();
  if (!trimmed) return '';

  const parts = trimmed.split(/\n(?=diff --git )/);
  const kept: string[] = [];

  for (const part of parts) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    const filePath = fileMatch?.[2] ?? fileMatch?.[1] ?? '';
    if (filePath && LOW_SIGNAL_FILE_RE.test(filePath)) {
      kept.push(`diff --git a/${filePath} b/${filePath}\n[lock/generated file — omitted from diff]`);
      continue;
    }
    if (part.length > MAX_FILE_HUNK_CHARS) {
      kept.push(`${part.slice(0, MAX_FILE_HUNK_CHARS)}\n... (file diff truncated)`);
      continue;
    }
    kept.push(part);
  }

  return kept.join('\n').trim();
}

/** Build system + user messages for a staged-diff commit message request. */
export function buildGitCommitMessagePrompt(
  input: GitCommitMessagePromptInput,
): ApiMessage[] {
  const {
    changedPaths,
    patch,
    scope,
    excludedPaths = [],
    useGitmoji = true,
  } = input;

  const scopeLine =
    scope === 'staged'
      ? 'Scope: staged changes only (git index). Describe ONLY what will be committed.'
      : 'Scope: working tree (unstaged + untracked). Nothing is staged — describe these pending changes only.';

  const fileList = changedPaths.length > 0 ? changedPaths.join('\n') : '(see diff)';
  const userSections = [scopeLine, '', 'Changed files:', fileList];

  if (excludedPaths.length > 0) {
    userSections.push(
      '',
      'Excluded from this message (do not mention):',
      excludedPaths.join('\n'),
    );
  }

  const filteredPatch = filterCommitMessagePatch(patch);
  userSections.push(
    '',
    'Diff:',
    '---',
    truncateStagedPatch(filteredPatch),
    '---',
    'Write the commit message.',
  );

  return [
    { role: 'system', content: buildCommitMessageSystemPrompt(useGitmoji) },
    { role: 'user', content: userSections.join('\n') },
  ];
}

// ── Thinking ─────────────────────────────────────────────────────────────────

function looksLikeReasoningLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (DIFF_ANALYSIS_LINE_RE.test(trimmed)) return true;
  return REASONING_LINE_RE.test(trimmed);
}

/** True when text is a markdown diff analysis / thinking walkthrough, not a commit message. */
export function looksLikeDiffAnalysisText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (DIFF_ANALYSIS_TEXT_RE.test(trimmed)) return true;

  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;

  const analysisLines = lines.filter(
    (line) => DIFF_ANALYSIS_LINE_RE.test(line) || DIFF_ANALYSIS_TEXT_RE.test(line),
  ).length;
  if (analysisLines === 0) return false;
  if (lines.some((line) => CONVENTIONAL_COMMIT_LINE_RE.test(line))) return false;
  return analysisLines >= 1;
}

function hasUnclosedThinkingTag(text: string): boolean {
  if (/<think(?:ing)?(?:\s+[^>]*)?>[\s\S]*$/i.test(text) && !/<\/think(?:ing)?>/i.test(text)) {
    return true;
  }
  if (/<think>[\s\S]*$/i.test(text) && !/<\/redacted_thinking>/i.test(text)) {
    return true;
  }
  return false;
}

/** Keep Gemma response-channel prose; drop thought-channel monologue when present. */
function extractGemmaResponseChannel(text: string): string {
  const responseMatch = /<\|channel>response\s*\n?([\s\S]*?)(?:<channel\|>|$)/i.exec(text);
  if (responseMatch?.[1]?.trim()) return responseMatch[1].trim();
  return text.replace(/<\|channel>thought\s*\n?[\s\S]*?(?:<channel\|>|$)/gi, '').trim();
}

/** Drop closed inline thinking tags only — avoid chat heuristics that split reasoning chains. */
export function stripThinkingFromCommitOutput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (hasUnclosedThinkingTag(trimmed)) return '';
  const gemma = extractGemmaResponseChannel(trimmed);
  const stripped = gemma
    .replace(/<think(?:ing)?(?:\s+[^>]*)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think>[\s\S]*?<\/redacted_thinking>/gi, '')
    .trim();
  if (hasUnclosedThinkingTag(stripped)) return '';
  return stripped;
}

/** Trim leading/trailing reasoning paragraphs while keeping the commit message body. */
export function stripReasoningFraming(text: string): string {
  const lines = text.split('\n');
  let start = 0;
  while (start < lines.length) {
    const trimmed = lines[start].trim();
    if (!trimmed) {
      start += 1;
      continue;
    }
    if (looksLikeReasoningLine(trimmed)) {
      start += 1;
      continue;
    }
    break;
  }

  let end = lines.length;
  while (end > start) {
    const trimmed = lines[end - 1].trim();
    if (!trimmed) {
      end -= 1;
      continue;
    }
    if (
      looksLikeReasoningLine(trimmed) ||
      /^\s*(?:looks good|done|perfect|great)\.?\s*$/i.test(trimmed)
    ) {
      end -= 1;
      continue;
    }
    break;
  }

  return lines.slice(start, end).join('\n').trim();
}

// ── Extract ──────────────────────────────────────────────────────────────────

function looksLikeCommitMessageSegment(segment: string): boolean {
  if (looksLikeDiffAnalysisText(segment)) return false;
  const lines = segment.trim().split('\n').filter((line) => line.trim());
  if (lines.length === 0) return false;
  const firstLine = lines[0].trim();
  if (looksLikeReasoningLine(firstLine)) return false;
  if (CONVENTIONAL_COMMIT_LINE_RE.test(firstLine)) return true;
  if (/\b(?:reasoning|mirrored|dumping|analy(?:s|z)(?:e|ing)|thinking)\b/i.test(segment)) {
    return false;
  }
  if (firstLine.length <= 72 && !firstLine.endsWith('?')) {
    const words = firstLine.split(/\s+/);
    if (
      words.length >= 2 &&
      words.length <= 12 &&
      !/^(this|these|the|that|there|it|strip|need|focus|\d+\.)\s*/i.test(firstLine)
    ) {
      return true;
    }
  }
  return false;
}

/** True when buffered text is mostly model reasoning with no commit subject yet. */
function looksLikeReasoningChain(text: string): boolean {
  if (looksLikeDiffAnalysisText(text)) return true;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  if (lines.some((line) => CONVENTIONAL_COMMIT_LINE_RE.test(line))) return false;
  const reasoningLines = lines.filter((line) => looksLikeReasoningLine(line)).length;
  return reasoningLines > 0;
}

function rejectDiffAnalysis(candidate: string): string {
  return looksLikeDiffAnalysisText(candidate) ? '' : candidate;
}

function isHighConfidenceCommitMessage(text: string): boolean {
  const firstLine = expandGitmojiShortcodes(text.split('\n')[0]?.trim() ?? '');
  return CONVENTIONAL_COMMIT_LINE_RE.test(firstLine);
}

function extractExplicitCommitMessagePrefix(text: string): string {
  for (const line of text.split('\n')) {
    const match = /^(?:commit message|message):\s*(.+)$/i.exec(line.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return '';
}

function collectCommitBlockFromLine(lines: string[], subjectIdx: number): string {
  const kept: string[] = [];
  for (let i = subjectIdx; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (i > subjectIdx && looksLikeReasoningLine(trimmed)) break;
    if (i > subjectIdx && /^\s*(?:looks good|done|perfect|great)\.?\s*$/i.test(trimmed)) break;
    kept.push(lines[i]);
  }
  return kept.join('\n').trim();
}

function extractHighConfidenceCommitMessage(stripped: string): string {
  const prefixed = extractExplicitCommitMessagePrefix(stripped);
  if (prefixed) {
    const candidate = rejectDiffAnalysis(sanitizeCommitMessage(stripReasoningFraming(prefixed)));
    if (candidate) return candidate;
  }

  const lines = stripped.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || looksLikeReasoningLine(trimmed)) continue;
    if (CONVENTIONAL_COMMIT_LINE_RE.test(trimmed)) {
      return rejectDiffAnalysis(sanitizeCommitMessage(collectCommitBlockFromLine(lines, i)));
    }
  }

  return '';
}

/** Pull the commit message out of a reasoning chain. */
export function extractCommitMessageFromChain(
  raw: string,
  options?: CommitMessageExtractOptions,
): string {
  const stripped = expandGitmojiShortcodes(stripThinkingFromCommitOutput(raw));
  if (!stripped) return '';

  const highConfidence = extractHighConfidenceCommitMessage(stripped);
  if (highConfidence) return highConfidence;

  if (options?.allowHeuristicFallback === false) return '';

  const segments = splitThinkingSegments(stripped);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (!looksLikeCommitMessageSegment(segments[i])) continue;
    const candidate = rejectDiffAnalysis(sanitizeCommitMessage(stripReasoningFraming(segments[i])));
    if (candidate) return candidate;
  }

  const framed = stripReasoningFraming(stripped);
  if (framed && looksLikeCommitMessageSegment(framed)) {
    return rejectDiffAnalysis(sanitizeCommitMessage(framed));
  }

  return '';
}

/** Normalize stripped model text into a commit message. */
export function normalizeCommitMessageOutput(raw: string): string {
  return extractCommitMessageFromChain(raw);
}

/** Resolve display text from content/reasoning channels. */
export function resolveCommitMessageDisplayText(
  contentText: string,
  reasoningText: string,
  options?: { reasoningFallback?: boolean },
): string {
  const content = contentText.trim();
  const reasoning = reasoningText.trim();
  const mirrored = content.length > 0 && reasoning.length > 0 && content === reasoning;
  const allowHeuristicFallback = options?.reasoningFallback === true;
  const extractOpts: CommitMessageExtractOptions = { allowHeuristicFallback };

  const tryExtract = (text: string): string => extractCommitMessageFromChain(text, extractOpts);

  if (content.length > 0) {
    const fromContent = tryExtract(contentText);
    if (fromContent) {
      const reasoningChain = looksLikeReasoningChain(content);
      if (!reasoningChain || isHighConfidenceCommitMessage(fromContent)) {
        return fromContent;
      }
    }

    if (
      allowHeuristicFallback &&
      !mirrored &&
      !looksLikeReasoningChain(content) &&
      !looksLikeDiffAnalysisText(content) &&
      content.split('\n').length <= 4
    ) {
      const firstLine = content.split('\n')[0]?.trim() ?? '';
      if (firstLine && !looksLikeReasoningLine(firstLine)) {
        const direct = rejectDiffAnalysis(sanitizeCommitMessage(content));
        if (direct) return direct;
      }
    }
  }

  if (!allowHeuristicFallback) return '';

  if (reasoning.length > 0 && !mirrored) {
    const fromReasoning = tryExtract(reasoningText);
    if (fromReasoning) return fromReasoning;
  }

  if (content.length > 0) {
    return tryExtract(contentText);
  }

  return '';
}

/** Normalize model output into a plain commit message string. */
export function sanitizeCommitMessage(raw: string): string {
  let text = raw.trim();

  const fenceMatch = text.match(/^```(?:\w+)?\s*([\s\S]*?)```\s*$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  text = text.replace(/^(commit message|message):\s*/i, '');
  // Models often emit :sparkles:; store the glyph so history and GitHub render it.
  return expandGitmojiShortcodes(text.trim());
}

// ── Fetch ────────────────────────────────────────────────────────────────────

function ingestChunk(
  contentAcc: StreamingContentAccumulator,
  reasoningAcc: BenchmarkStreamReasoningAccumulator,
  chunk: ChatCompletionChunk,
): void {
  contentAcc.ingestChoice(chunk.choices?.[0]);
  reasoningAcc.ingestChunk(chunk);
}

function generationEndErrorMessage(event?: GenerationEndEvent): string {
  const raw = event?.errorMessage?.trim();
  if (raw) return formatGenerationErrorMessage(raw);
  return EDITOR_AI_REQUEST_FAILED_MESSAGE;
}

function createGenerationErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return formatGenerationErrorMessage(err.message);
  }
  return EDITOR_AI_REQUEST_FAILED_MESSAGE;
}

/** Git commit messages use the active chat model when editor AI is disabled or configured to follow chat; otherwise the pinned editor model. */
export async function resolveGitCommitMessageBinding(
  config: EditorAiCompletionConfig,
): Promise<EditorAiBinding> {
  if (!config.enabled || config.useChatModel) {
    return resolveEditorAiBinding({ ...config, useChatModel: true });
  }
  return resolveEditorAiBinding(config);
}

/** Stream a commit message from the active editor/chat model binding. */
export async function fetchGitCommitMessage(
  input: GitCommitMessageRequest,
): Promise<GitCommitMessageResult> {
  const [config, commitConfig, utilityConfig] = await Promise.all([
    loadEditorAiCompletionConfig(),
    loadGitCommitMessageConfig(),
    loadUtilityModelConfig(),
  ]);
  const utility = utilityModelOverride(utilityConfig);
  let binding: EditorAiBinding;
  if (utility) {
    let resolved = await resolveLibraryRequestBinding(
      utility.providerId,
      utility.modelId,
    );
    if (resolved.kind === 'needsLoad') {
      try {
        await ensureChatModelLoadedForTurn(
          LIBRARY_MODEL_PROVIDER_ID,
          resolved.libraryModelId,
          input.signal,
        );
        resolved = await resolveLibraryRequestBinding(
          LIBRARY_MODEL_PROVIDER_ID,
          resolved.libraryModelId,
        );
      } catch (err) {
        return {
          text: null,
          error: err instanceof Error ? err.message : LIBRARY_MODEL_NOT_LOADED_MESSAGE,
        };
      }
    }
    binding = resolved.kind === 'needsLoad'
      ? { ...utility, error: LIBRARY_MODEL_NOT_LOADED_MESSAGE }
      : { providerId: resolved.providerId, modelId: resolved.modelId };
  } else {
    binding = await resolveGitCommitMessageBinding(config);
  }
  const validation = validateEditorAiBinding(binding);
  if (validation.ok === false) {
    return { text: null, error: validation.message };
  }

  let provider;
  try {
    provider = await resolveProvider(binding.providerId, { strict: true });
  } catch (err) {
    return {
      text: null,
      error: err instanceof Error ? err.message : EDITOR_AI_REQUEST_FAILED_MESSAGE,
    };
  }
  const messages = buildGitCommitMessagePrompt({
    changedPaths: input.changedPaths,
    patch: input.patch,
    scope: input.scope,
    excludedPaths: input.excludedPaths,
    useGitmoji: input.useGitmoji ?? commitConfig.useGitmoji,
  });
  const body: Record<string, unknown> = {
    model: binding.modelId || undefined,
    messages,
    temperature: Math.min(config.temperature + 0.1, 0.7),
    max_tokens: Math.max(config.maxTokens, 768),
    stream: true,
  };

  const modelId = binding.modelId.trim();
  const modelRow = modelId
    ? modelCache.get(encodeModelSelectKey(provider.id, modelId))
    : undefined;
  const modelCaps =
    modelRow?.capabilities ??
    (modelRow ? catalogCapabilitiesFromRow(modelRow) : undefined);
  applyUtilityThinkingOff(body, provider, modelCaps);

  let generationId: string;
  try {
    ({ generationId } = await createGeneration(provider.id, body, {
      persist: false,
      fallbackRole: 'utility',
    }));
  } catch (err) {
    return { text: null, error: createGenerationErrorMessage(err) };
  }

  const contentAcc = new StreamingContentAccumulator();
  const reasoningAcc = new BenchmarkStreamReasoningAccumulator();

  const emit = (reasoningFallback = false): string =>
    resolveCommitMessageDisplayText(
      contentAcc.getText(),
      reasoningAcc.getText(),
      { reasoningFallback },
    );

  return new Promise<GitCommitMessageResult>((resolve) => {
    let settled = false;
    const finish = (text: string | null, error?: string): void => {
      if (settled) return;
      settled = true;
      resolve(error ? { text: null, error } : { text });
    };

    const unsubscribe = subscribeToGeneration(generationId, {
      signal: input.signal,
      onChunk: (chunk) => {
        ingestChunk(contentAcc, reasoningAcc, chunk);
        const cleaned = emit(false);
        if (cleaned) input.onPartial?.(cleaned);
      },
      onEnd: (event?: GenerationEndEvent) => {
        unsubscribe();
        if (event?.status === 'error') {
          finish(null, generationEndErrorMessage(event));
          return;
        }
        if (event?.status === 'cancelled') {
          finish(null);
          return;
        }
        const cleaned = emit(true);
        finish(
          cleaned.length > 0 ? cleaned : null,
          cleaned.length > 0 ? undefined : EDITOR_AI_EMPTY_COMPLETION_MESSAGE,
        );
      },
      onTransportError: (err) => {
        unsubscribe();
        finish(null, createGenerationErrorMessage(err));
      },
    });

    input.signal.addEventListener(
      'abort',
      () => {
        unsubscribe();
        void cancelGeneration(generationId).catch(() => {
        });
        finish(null);
      },
      { once: true },
    );
  });
}

export type { GitCommitMessageConfig };
