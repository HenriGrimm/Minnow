/**
 * Derive human-readable model labels from canonical LM Studio ids (top-bar picker).
 */

import { isKnownLocalProviderId, isLocalProviderBaseUrl } from '../providers/provider-host';

/** Input for one model row in the picker. */
export interface ModelLabelInput {
  id: string;
  quantization?: string;
  state?: string;
}

/** Decomposed label parts for UI and tests. */
export interface ModelLabelParts {
  /** Humanized name from id slug, e.g. "Qwen3.6 27B". */
  primary: string;
  /** Quantization from API when present, e.g. "Q4_K_M". */
  quant?: string;
  /** Normalized load state for suffixes and A4 dots. */
  loadState: 'loaded' | 'not_loaded' | 'unknown';
  /** Text inside <option> (may include quant + state). */
  optionText: string;
  /** Native tooltip: full id + metadata. */
  title: string;
}

const BRAND_PREFIXES = [
  'qwen',
  'llama',
  'mistral',
  'gemma',
  'phi',
  'deepseek',
  'codellama',
  'granite',
  'mixtral',
  'nomic',
] as const;

/** Escape text for HTML attribute and element text contexts. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip vendor/path prefix and return the slug segment used for humanize. */
export function slugFromModelId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return '';
  const slash = trimmed.lastIndexOf('/');
  if (slash >= 0) return trimmed.slice(slash + 1);
  return trimmed;
}

/** True when token is a parameter size like 27b or 8B. */
function isSizeToken(token: string): boolean {
  return /^\d+\.?\d*b$/i.test(token);
}

/** Format size token with uppercase B. */
function formatSizeToken(token: string): string {
  const match = /^(\d+\.?\d*)(b)$/i.exec(token);
  if (!match) return token;
  return `${match[1]}B`;
}

/** Capitalize known model family prefix on a lowercase slug token. */
function applyBrandToken(token: string): string {
  const lower = token.toLowerCase();
  for (const prefix of BRAND_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return prefix.charAt(0).toUpperCase() + prefix.slice(1) + token.slice(prefix.length);
    }
  }
  return token;
}

/** Title-case the first character of a lowercase token. */
function titleCaseToken(token: string): string {
  if (!token) return token;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/** Turn slug into display primary (no quant/state). */
export function humanizeModelSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed) return '';

  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i.exec(trimmed);
  if (claude) {
    const family = titleCaseToken(claude[1]);
    return `Claude ${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  }

  const tokens = trimmed.split(/[-_]+/).filter(Boolean);
  if (!tokens.length) return '';

  const parts = tokens.map((token, index) => {
    if (isSizeToken(token)) return formatSizeToken(token);
    if (/^\d+\.\d+$/.test(token)) return token;

    if (/^[A-Z]{2,}$/.test(token)) return token;
    if (/^[A-Z][A-Za-z0-9]*$/.test(token)) return token;

    const brand = applyBrandToken(token);
    if (brand !== token) return brand;

    if (index === 0) return titleCaseToken(token);
    return token.toLowerCase();
  });

  const joined = parts.join(' ').trim();
  if (joined) return joined;

  return titleCaseToken(trimmed.replace(/[-_]+/g, ' '));
}

/** Map API state string to normalized loadState. */
function normalizeLoadState(state?: string): ModelLabelParts['loadState'] {
  const s = state?.trim().toLowerCase();
  if (s === 'loaded') return 'loaded';
  if (s === 'not loaded' || s === 'not_loaded' || s === 'unloaded') return 'not_loaded';
  return 'unknown';
}

/** Full label pipeline for one model row. */
export function formatModelLabel(input: ModelLabelInput): ModelLabelParts {
  const id = input.id ?? '';
  const slug = slugFromModelId(id);
  let primary = humanizeModelSlug(slug);
  if (!primary.trim()) primary = id.trim() || id;

  const quant = input.quantization?.trim() || undefined;
  const loadState = normalizeLoadState(input.state);

  let optionText = primary;
  if (quant) optionText += ` · ${quant}`;

  let title = id;
  if (quant) title += ` · ${quant}`;
  if (loadState === 'loaded') title += ' — loaded';
  else if (loadState === 'not_loaded') title += ' — not loaded';

  return { primary, quant, loadState, optionText, title };
}

/** Build one escaped <option> element for the model select. */
export function buildModelOptionHtml(m: ModelLabelInput): string {
  const { optionText, title } = formatModelLabel(m);
  const escapedId = escapeHtml(m.id);
  const escapedTitle = escapeHtml(title);
  const escapedText = escapeHtml(optionText);
  return `<option value="${escapedId}" title="${escapedTitle}">${escapedText}</option>`;
}

/** Parameters for a top-bar option (multi-provider): composite value + provider label suffix. */
export interface TopBarModelOptionInput {
  /** Encoded value for <option value> (e.g. providerId + SEP + modelId). */
  value: string;
  model: ModelLabelInput;
  /** Shown after an em dash in option text and appended to the native title. */
  providerLabel: string;
  /** Stored on the element for diagnostics and DOM-based reads. */
  providerId: string;
  /** Whether this provider exposes LM Studio-style load/unload (for button state without extra fetches). */
  supportsModelLoadUnload: boolean;
  /** Provider upstream base URL — used for local/cloud picker filtering. */
  providerBaseUrl?: string;
}

/**
 * Build one escaped <option> for the main model picker: human-readable label,
 * composite value, data-provider-id, and title including provider name.
 */
export function buildTopBarModelOptionHtml(input: TopBarModelOptionInput): string {
  const { optionText, title } = formatModelLabel(input.model);
  const pl = input.providerLabel.trim() || input.providerId;
  const displayText = pl ? `${optionText} — ${pl}` : optionText;
  const fullTitle = pl ? `${title} · ${pl}` : title;
  const escapedValue = escapeHtml(input.value);
  const escapedTitle = escapeHtml(fullTitle);
  const escapedText = escapeHtml(displayText);
  const escapedPid = escapeHtml(input.providerId);
  const loadAttr = input.supportsModelLoadUnload ? ' data-supports-load-unload="1"' : '';
  const isLocal =
    isKnownLocalProviderId(input.providerId) ||
    (input.providerBaseUrl ? isLocalProviderBaseUrl(input.providerBaseUrl) : false);
  const hostAttr = ` data-provider-host="${isLocal ? 'local' : 'cloud'}"`;
  return `<option value="${escapedValue}" title="${escapedTitle}" data-provider-id="${escapedPid}"${hostAttr}${loadAttr}>${escapedText}</option>`;
}
