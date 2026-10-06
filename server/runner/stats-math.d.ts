import type { FinalizedResponseMeta, Stats, Usage } from '../../src/types.js';
/** Sub-agent row shape for aggregation (usage/stats only). */
export interface SubAgentStatsSlice {
    usage?: Usage;
    stats?: Stats;
}
/**
 * Roll up usage across tool-loop rounds in one user turn.
 * Each API call reports the full prompt size (not a delta), so only the latest
 * prompt is kept; completion tokens are summed across rounds.
 */
export declare function aggregateTurnUsageSegments(segments: Usage[]): Usage;
/** Sum numeric usage fields across segments (missing treated as zero). */
export declare function sumUsageSegments(segments: Usage[]): Usage;
type StatsUsagePair = {
    stats: Stats;
    usage: Usage;
};
/** Average timing stats; TPS is total measured output divided by total measured time. */
export declare function averageStatsSegments(pairs: StatsUsagePair[]): Stats;
/** Roll up stats + usage across tool-loop rounds in one user turn. */
export declare function aggregateTurnMetaSegments(segments: StatsUsagePair[]): {
    stats: Stats;
    usage: Usage;
};
/** Merge parent completion meta with sub-agent usage/stats slices. */
export declare function aggregateOrchestrateTurnMeta(parent: FinalizedResponseMeta, subRuns: SubAgentStatsSlice[]): FinalizedResponseMeta;
export {};
