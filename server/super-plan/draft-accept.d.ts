/** The tier that decided a draft accept verdict. */
export type DraftAcceptTier = 1 | 2;

/** Outcome of the two-tier draft accept gate. */
export interface DraftAcceptResult {
  /** True when the draft may advance. */
  accepted: boolean;
  /** The last tier evaluated: 1 for a prose draft, 2 for an executable one. */
  tier: DraftAcceptTier;
  /** sha256 of the draft content, or null when the file was never written. */
  sha256: string | null;
  /** Human-readable reasons the draft was rejected; empty on accept. */
  errors: string[];
  /** The seed fed back to the next draft attempt; null on accept. */
  retrySeed: string | null;
}

/** Headings a draft must carry before Tier 1 can pass. */
export const REQUIRED_DRAFT_HEADINGS: readonly string[];

/** Content hash of a draft artifact. */
export function draftContentSha256(markdown: string): string;

/** Is this path an executable orchestrate plan (Tier 2 applies)? */
export function isExecutableDraftPlan(planPath: unknown): boolean;

/** Evaluate the two-tier draft accept gate. */
export function evaluateDraftAccept(input?: {
  markdown?: string | null;
  planPath?: string | null;
  priorAcceptedSha256?: string | null;
}): DraftAcceptResult;
