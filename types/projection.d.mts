/**
 * Build an empty projection skeleton. Sessions map starts empty; metadata
 * has `event_count = 0` and `last_event_id = null`.
 *
 * @returns {{ _meta: object, sessions: Record<string, object> }}
 */
export function emptyProjection(): {
    _meta: object;
    sessions: Record<string, object>;
};
/**
 * Build a default session record. Caller passes the stable_id and the
 * `created_at` timestamp (typically the first observing event's `ts`).
 *
 * @param {string} stableId
 * @param {string} ts - ISO timestamp string used for both created_at and
 *   last_progress_at.
 */
export function emptySession(stableId: string, ts: string): {
    stable_id: string;
    alias: any;
    claude_session_ids: any[];
    transcript_files: any[];
    fingerprints: {
        first_human_prompt_v1: any;
        lineage_prefix_v1: any;
    };
    parent_session_id: any;
    parent_candidate_ids: any[];
    parent_candidates_omitted_count: number;
    identity_resolution: any;
    worktree_path_observed: any;
    worktree_realpath: any;
    worktree_registry_name: any;
    git_common_dir: any;
    branch_at_start: any;
    branch_current: any;
    head_at_start: any;
    head_last_seen: any;
    tasks: any[];
    projects: any[];
    activity_state: string;
    outcome: string;
    closed_at: any;
    closed_reason: any;
    created_at: string;
    last_progress_at: string;
    first_prompt_preview: any;
};
/**
 * Apply a single event to a projection (mutating). Returns the same
 * projection reference for fluent chaining.
 *
 * Unknown ops are tolerated — they update _meta but otherwise no-op so a
 * future schema bump applied against an older binary degrades cleanly. We
 * still bump `event_count` so the rebuild detector remains accurate.
 *
 * @param {object} projection
 * @param {{ ts: string, event_id: string, op: string, stable_id: string,
 *   payload?: object }} event
 * @returns {object} projection
 */
export function applyEvent(projection: object, event: {
    ts: string;
    event_id: string;
    op: string;
    stable_id: string;
    payload?: object;
}): object;
/**
 * Fold an event array into a fresh projection. Used both for full rebuilds
 * (storage.rebuildProjection) and for unit tests.
 *
 * @param {Array<object>} events
 */
export function rebuildFromEvents(events: Array<object>): {
    _meta: object;
    sessions: Record<string, object>;
};
