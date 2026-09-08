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
    ai_title: any;
    names: any[];
    display_name: any;
    display_name_channel: any;
    source: string;
    claude_session_ids: any[];
    codex_session_ids: any[];
    pr_links: any[];
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
 * future schema bump applied against an older binary degrades cleanly. They
 * still count toward `event_count`: an op this build cannot interpret is
 * still a line in the log, and a counter that skipped it would report drift
 * on a projection that is perfectly up to date.
 *
 * `event_count` counts DISTINCT events. Re-folding the event already recorded
 * in `_meta.last_event_id` does not move it — see the idempotency contract in
 * the module header for why that case is the normal path rather than a corner.
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
/**
 * Recompute `display_name` / `display_name_channel`, and materialize `names[]`
 * on records that predate it.
 *
 * The shim matters for the same reason the `ai_title` one above does: a
 * projection loaded from disk was written by whatever version wrote it last,
 * and consumers should be able to read `session.names` without an `in` check
 * on every access.
 */
export function refreshDerivedNames(session: any): void;
/**
 * Fold a log-derived `names[]` block into a cached session record, **one
 * channel at a time**, and re-derive everything that hangs off the result.
 *
 * Used by the cache repair in `storage.backfillNamesModel`, which needs the
 * log's answer for the counters it recomputes without throwing away what only
 * the cache still knows.
 *
 * ## Why the merge is per channel and not per session
 *
 * The log is the source of truth for names, but "the log has nothing to say
 * about this session" and "the log has nothing to say about this channel" are
 * different statements, and a session-level replace conflates them. Once a log
 * has been rotated or truncated — which is a supported thing to do to it — a
 * session can appear in the remaining log through ONE channel while the cache
 * still holds three others. Replacing the whole block then deletes the two the
 * log no longer mentions, silently, and no later event restores them.
 *
 * Per channel there is nothing left to assume: a channel the log speaks for
 * takes the log's entry, a channel it does not is kept exactly as it was. The
 * residual is a counter, not a name — if the rotation cut away part of a
 * channel's history, that channel's `set_count` reflects what the log still
 * holds. That is the same answer `rebuild` gives and the same answer the log
 * being SSoT implies; it cannot lose a name.
 *
 * ## Why the legacy mirrors are rewritten here
 *
 * `session.alias` / `session.ai_title` are derived views of two channels. If
 * the merge moves those channels and the mirrors are left where they were, the
 * record disagrees with itself: `display_name` follows `names[]` while
 * `search`'s `alias` label and `prune`'s "was this ever named" check read the
 * mirror. One session, two answers, depending on which consumer asked. A
 * channel the merged block has no entry for leaves its mirror alone — that is
 * the pre-0.3.0 record shape, and the read path already falls back to it.
 *
 * The per-session channel cap is deliberately NOT enforced on the union. Both
 * inputs were produced under it, so the result is bounded by twice the cap —
 * still bounded, which is all the cap exists to guarantee — and the only way
 * to honour it exactly here would be to drop entries, i.e. to reintroduce the
 * defect this function exists to remove.
 *
 * @param {object} session cached record, mutated in place
 * @param {Array<object>|undefined} fromLog the same session's `names[]` as
 *   folded from events.jsonl
 * @returns {object} the same session reference
 */
export function mergeNamesFromLog(session: object, fromLog: Array<object> | undefined): object;
