/**
 * Shared data shapes for sessions, LM Studio API payloads, and UI metrics.
 * Mirrors structures in `documentation/archive/_extracted-app.js` (historical) / legacy `index.html`.
 */
/** Persisted session blob schema version (`minnow-sessions-v1` key; version inside JSON). */
export const SESSION_SCHEMA_VERSION = 6;
/**
 * Per-issue cap on {@link IssueActivityEntry} retained in state.json.
 *
 * Phase 0 decision: activity stays in the single debounced state.json rather
 * than moving to an append-only side file. Nothing writes activity yet, and a
 * second file with its own write path is the shape that broke MIN-354 v1.
 * The cap keeps the blob bounded; revisit in Phase 4 when agents start writing.
 */
export const ISSUE_ACTIVITY_CAP = 50;
/**
 * Value always written to `version` on disk.
 *
 * Frozen at the highest revision every already-shipped reader can parse. Those
 * readers reset to an empty state on an unrecognized `version` — so writing a 3
 * there would erase every issue for anyone who rolls a release back. The real
 * revision travels in {@link IssuesState.schemaRevision}, which old readers
 * ignore. They lose fields they never modelled; they do not lose issues.
 */
export const ISSUES_COMPAT_VERSION = 2;
/** Current schema revision for ~/.minnow/issues/state.json. */
export const ISSUES_SCHEMA_VERSION = 3;
/** Effective schema revision of a stored blob (`schemaRevision`, else `version`). */
export function issuesSchemaRevisionOf(raw) {
    const explicit = raw.schemaRevision;
    if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 1) {
        return Math.floor(explicit);
    }
    const legacy = raw.version;
    if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 1) {
        return Math.floor(legacy);
    }
    return ISSUES_SCHEMA_VERSION;
}
//# sourceMappingURL=types.js.map