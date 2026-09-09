export const WEB_TEXT_MAX_BYTES: number;
export const WEB_TEXT_DEFAULT_MAX_BYTES: number;
export const WEB_RAG_EXCERPT_LIMIT: number;
export const DEFAULT_FETCH_USER_AGENT: string;
export const MEMORY_EXCERPT_MAX_CHARS: number;
export function validateHttpUrl(
  urlString: string,
): { ok: true; url: URL } | { ok: false; error: string };
export function stripHtmlToPlainText(html: string): string;
export function dropNoiseSubtrees(html: string): string;
export function selectMainRegion(html: string): string;
export function truncateUtf8(text: string, maxBytes: number): string;
export function rankSentencesByQuery(text: string, query: string, limit: number): string[];
export function rankParagraphsByQuery(text: string, query: string, limit: number): string[];
export function rankWebContentByQuery(text: string, query: string, limit?: number): string[];
export function selectQueryRelevantExcerpt(body: string, query?: string, maxLen?: number): string;
export function formatFetchNetworkError(
  url: string,
  err: unknown,
  options?: Record<string, unknown>,
): string;
export function fetchUrlText(
  urlString: string,
  options?: Record<string, unknown>,
): Promise<string>;
