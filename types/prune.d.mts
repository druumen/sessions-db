/**
 * Parse a duration string like `30m` / `2h` / `7d` into milliseconds.
 *
 * A unit suffix is REQUIRED. A bare `--older-than 24` is ambiguous (24 what?
 * the default unit is hours, but the sweep command next door speaks days) and
 * this flag gates a delete, so guessing is the wrong trade — we reject and
 * say what we wanted instead.
 *
 * @param {string} text
 * @returns {number|null} milliseconds, or null when unparseable
 */
export function parseDuration(text: string): number | null;
/**
 * Second, targeted disk check for one record.
 *
 * `indexTranscriptCsids()` swallows per-directory read errors, so a
 * permission blip could shrink the index and make a live session look
 * transcript-less. This is the "双保险" second net the design calls for: for
 * every csid we ALSO compute the canonical path from the record's own cwd and
 * stat it directly. A hit from either path spares the record.
 *
 * @param {object} session
 * @param {Set<string>} diskCsids
 * @param {{ projectsRoot?: string }} [opts]
 * @returns {boolean}
 */
export function hasTranscriptOnDisk(session: object, diskCsids: Set<string>, opts?: {
    projectsRoot?: string;
}): boolean;
/**
 * Plan a prune. Pure — all disk state arrives via `diskCsids`.
 *
 * @param {object} projection
 * @param {{
 *   diskCsids?: Set<string>,
 *   olderThanMs?: number,
 *   now?: number,
 *   projectsRoot?: string,
 * }} [opts]
 * @returns {{
 *   candidates: Array<{ stable_id: string, created_at: string, age_hours: number,
 *     claude_session_ids: string[], cwd: string|null, branch_at_start: string|null }>,
 *   scanned: number,
 *   spared: Record<string, number>,
 * }}
 */
export function computePruneCandidates(projection: object, opts?: {
    diskCsids?: Set<string>;
    olderThanMs?: number;
    now?: number;
    projectsRoot?: string;
}): {
    candidates: Array<{
        stable_id: string;
        created_at: string;
        age_hours: number;
        claude_session_ids: string[];
        cwd: string | null;
        branch_at_start: string | null;
    }>;
    scanned: number;
    spared: Record<string, number>;
};
/**
 * Execute a prune (or plan one).
 *
 * Lock discipline: unlike every other write in `operations.mjs`, this does
 * NOT loop over `tryUpdateProjection`. That primitive takes and releases the
 * projection lock per event; at ~33 ms per cycle on a real database, 144
 * tombstones would hold-and-release for the better part of five seconds and
 * leave the projection observably half-pruned to any concurrent reader in
 * between. Instead we run ONE transaction — acquire, load, append+apply every
 * tombstone, save once, release — so the projection goes from "before" to
 * "after" in a single atomic rename with no intermediate state.
 *
 * The SSoT-first ordering of `tryUpdateProjection` is preserved per event:
 * each tombstone is appended to events.jsonl before it is applied in memory,
 * so a crash mid-batch leaves a durable log that the next rebuild folds into
 * exactly the same result.
 *
 * @param {{
 *   dryRun?: boolean,
 *   olderThanMs?: number,
 *   now?: number,
 *   reason?: string,
 *   rootPath?: string, root?: string, paths?: object,
 *   lockTimeoutMs?: number, lockRetryMs?: number,
 * }} [opts]
 * @returns {Promise<object>}
 */
export function runPrune(opts?: {
    dryRun?: boolean;
    olderThanMs?: number;
    now?: number;
    reason?: string;
    rootPath?: string;
    root?: string;
    paths?: object;
    lockTimeoutMs?: number;
    lockRetryMs?: number;
}): Promise<object>;
/** Default age floor: never prune a record younger than this. */
export const DEFAULT_OLDER_THAN_MS: number;
