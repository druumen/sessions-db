/**
 * Absolute path of the pending directory for a storage opts shape.
 *
 * @param {object} [opts] same shape accepted by storage.mjs
 * @returns {string}
 */
export function pendingDir(opts?: object): string;
/**
 * Absolute path of one pending record.
 *
 * @param {string} claudeSessionId
 * @param {object} [opts]
 * @returns {string|null} null when the id is not UUID-shaped
 */
export function pendingPath(claudeSessionId: string, opts?: object): string | null;
/**
 * @typedef {Object} PendingRecord
 * @property {string} claude_session_id
 * @property {string} observed_at        ISO ts of the deferred SessionStart —
 *                                       becomes the promoted record's created_at
 * @property {string|null} cwd
 * @property {string|null} branch_at_start
 * @property {string|null} head_at_start
 * @property {string|null} worktree_path_observed
 * @property {string|null} worktree_realpath
 * @property {string|null} worktree_registry_name
 * @property {string|null} git_common_dir
 * @property {string|null} source        Claude Code's SessionStart `source`
 * @property {number} schema             Pending-record schema version (1)
 */
/**
 * Write (or overwrite) a pending record. Atomic: tmp file + fsync + rename,
 * same discipline as the projection cache, so a crashed hook can never leave
 * a half-written JSON that the promoter would then fail to parse.
 *
 * Overwrite-on-repeat is intentional: SessionStart can fire more than once
 * for the same session id (we observe pairs ~30 ms apart in the wild), and
 * the latest observation is the one worth keeping.
 *
 * Never throws — returns false on any failure. A hook that cannot stage a
 * pending record must still exit 0; the only consequence is a `created_at`
 * that starts at first prompt instead of at process start.
 *
 * @param {PendingRecord} record
 * @param {object} [opts]
 * @returns {boolean} true when the file is on disk
 */
export function writePending(record: PendingRecord, opts?: object): boolean;
/**
 * Read one pending record. Returns null when absent, unparseable, or not
 * shaped like a pending record. Never throws.
 *
 * @param {string} claudeSessionId
 * @param {object} [opts]
 * @returns {PendingRecord|null}
 */
export function readPending(claudeSessionId: string, opts?: object): PendingRecord | null;
/**
 * Delete one pending record. Idempotent; never throws.
 *
 * @param {string} claudeSessionId
 * @param {object} [opts]
 * @returns {boolean} true when a file was removed
 */
export function deletePending(claudeSessionId: string, opts?: object): boolean;
/**
 * List pending records with their mtimes. Never throws; a missing directory
 * is an empty list.
 *
 * @param {object} [opts]
 * @returns {{ claude_session_id: string, path: string, mtimeMs: number }[]}
 */
export function listPending(opts?: object): {
    claude_session_id: string;
    path: string;
    mtimeMs: number;
}[];
/**
 * Record that a promoter (the `UserPromptSubmit` hook) ran against this
 * storage root.
 *
 * ## Why liveness detection exists at all
 *
 * Deferral is only safe if something will later promote what was deferred. The
 * two hooks are registered independently in `~/.claude/settings.json`, so a
 * user who upgrades the package without adding the `UserPromptSubmit` entry
 * would get a `SessionStart` that defers every new session and nothing that
 * ever promotes one — the pending records would expire and NOTHING would be
 * recorded. That failure mode is silent and strictly worse than the ghost
 * records deferral exists to prevent.
 *
 * So `SessionStart` defers only when it can see evidence that a promoter is
 * alive, and this is that evidence. Absent the marker, the hook falls back to
 * the pre-0.2.0 always-record behaviour: ghosts come back, but no session is
 * ever lost. Failing toward the old behaviour is the only acceptable direction.
 *
 * ## Why a marker file instead of reading settings.json
 *
 * Hook registration can live in `~/.claude/settings.json`, a project
 * `.claude/settings.json`, `.claude/settings.local.json`, or a managed
 * enterprise policy, and the shape has changed across Claude Code versions.
 * Parsing all of that is guesswork about someone else's config format. A
 * marker written by the promoter itself is direct evidence: the hook is not
 * merely configured, it demonstrably ran.
 *
 * Cost control: we `stat` first and only rewrite when the marker is missing or
 * older than an hour, so the steady-state cost on a per-prompt hook is one
 * stat.
 *
 * Never throws.
 *
 * @param {object} [opts]
 * @param {{ now?: number }} [markOpts]
 * @returns {boolean} true when the marker is present and current afterwards
 */
export function markPromoterAlive(opts?: object, markOpts?: {
    now?: number;
}): boolean;
/**
 * Is a promoter alive for this storage root? See `markPromoterAlive` for why
 * this gate exists and why "no" must mean "do not defer".
 *
 * Two independent ways to answer "no":
 *
 *   1. the marker is missing or older than `maxAgeMs` (30 days) — the coarse,
 *      original check;
 *   2. the marker is stale (`PROMOTER_STALE_AFTER_MS`) AND at least
 *      `PROMOTER_BACKLOG_MIN_COUNT` sessions were staged after it was last
 *      refreshed and are still sitting there unpromoted. A live promoter
 *      refreshes the marker hourly, so this combination means deferral is
 *      writing into a void.
 *
 * When (2) fires the marker is RETIRED (unlinked), not merely ignored. The
 * evidence is the pending backlog, and the backlog expires at
 * `PENDING_MAX_AGE_MS`; leaving the marker in place would make the answer
 * oscillate — distrust for a day, trust again once the evidence was GC'd,
 * losing another day of sessions before it re-accumulated. Retiring makes the
 * decision stick, and it is self-healing in the right direction: the very
 * next real prompt-hook run calls `markPromoterAlive`, recreates the marker,
 * and deferral resumes. Deleting is best-effort and never throws; if it
 * fails, the worst case is the oscillation we were avoiding, never a loss.
 *
 * @param {object} [opts]
 * @param {{ maxAgeMs?: number, now?: number, staleAfterMs?: number }} [checkOpts]
 * @returns {boolean}
 */
export function isPromoterAlive(opts?: object, checkOpts?: {
    maxAgeMs?: number;
    now?: number;
    staleAfterMs?: number;
}): boolean;
/**
 * Garbage-collect pending records older than `maxAgeMs`.
 *
 * Called opportunistically from the SessionStart hook (the same event that
 * creates pending files), so the area is self-limiting without a cron: every
 * new session pays one bounded readdir and reclaims whatever expired. There
 * is deliberately no lock — deleting a file that another process is
 * simultaneously promoting is harmless, because promotion reads the record
 * into memory first and treats a missing file as "nothing staged".
 *
 * @param {object} [opts]
 * @param {{ maxAgeMs?: number, now?: number }} [sweepOpts]
 * @returns {{ removed: number, kept: number }}
 */
export function sweepPending(opts?: object, sweepOpts?: {
    maxAgeMs?: number;
    now?: number;
}): {
    removed: number;
    kept: number;
};
/** Directory name for the staging area, relative to the storage root. */
export const PENDING_DIRNAME: "sessions-db-pending";
/**
 * Default max age for a pending record before GC reclaims it (24 h).
 *
 * Rationale: a pending file is only useful until its session's first prompt.
 * A session that has been open for a day without a single prompt is a
 * warm-pool process or an abandoned window — promoting it later would date
 * the record to a `created_at` a day in the past, which is worse than simply
 * recording it at first-prompt time. 24 h is deliberately generous: the cost
 * of keeping a stale 200-byte file is nil, the cost of dropping a real
 * session's start time is a wrong `created_at`.
 *
 * The "which is worse than simply recording it at first-prompt time" clause is
 * load-bearing and rests entirely on the prompt hook recording a session it
 * cannot find (step (9a) there). Without that, GC here does not cost a start
 * time — it costs the whole session, and "left the tab open on Friday, typed
 * on Monday" is enough to trigger it.
 */
export const PENDING_MAX_AGE_MS: number;
/**
 * Filename of the promoter liveness marker inside the pending directory.
 * Leading dot so `listPending`'s UUID filter skips it for free.
 */
export const PROMOTER_MARKER: ".promoter";
/**
 * How long a promoter marker stays trusted (30 days).
 *
 * Long on purpose. The marker answers "is the UserPromptSubmit hook wired up
 * on this machine?", which is a property of the user's configuration, not of
 * recent activity. Someone who does not open this workspace for three weeks
 * must not have deferral silently switch off underneath them.
 */
export const PROMOTER_MAX_AGE_MS: number;
/**
 * Secondary liveness signal — thresholds.
 *
 * The 30-day marker window above is right for its stated question ("is the
 * hook configured?") but it opens a 30-day blind spot for the failure it
 * exists to catch: a user who removes the `UserPromptSubmit` registration
 * while staying on 0.2.0 keeps a marker that is still "fresh" by that
 * standard, so SessionStart keeps deferring and NOTHING promotes — sessions
 * are staged, expire at `PENDING_MAX_AGE_MS`, and are lost. Silently. For a
 * month. That is precisely the failure the marker was introduced to prevent.
 *
 * So the marker is cross-examined once it goes stale: a promoter that is
 * running refreshes it at least hourly (see `PROMOTER_REFRESH_MS`), therefore
 * a marker untouched for `PROMOTER_STALE_AFTER_MS` while sessions kept being
 * staged behind it is evidence of a backlog nobody is draining.
 *
 * Thresholds are deliberately loose, because a false positive costs ghost
 * records (the pre-0.2.0 behaviour) and a false negative costs sessions.
 * Ghost stagings alone do NOT trip it — an idle machine's warm-pool spawns
 * are staged and never promoted in normal operation too, so the discriminator
 * is that they piled up AFTER the marker went quiet.
 */
export const PROMOTER_STALE_AFTER_MS: number;
/** Staged records newer than the marker needed before we stop trusting it. */
export const PROMOTER_BACKLOG_MIN_COUNT: 3;
/** ...and each must be at least this old — a fresh one may promote any second. */
export const PROMOTER_BACKLOG_MIN_AGE_MS: number;
export type PendingRecord = {
    claude_session_id: string;
    /**
     * ISO ts of the deferred SessionStart —
     * becomes the promoted record's created_at
     */
    observed_at: string;
    cwd: string | null;
    branch_at_start: string | null;
    head_at_start: string | null;
    worktree_path_observed: string | null;
    worktree_realpath: string | null;
    worktree_registry_name: string | null;
    git_common_dir: string | null;
    /**
     * Claude Code's SessionStart `source`
     */
    source: string | null;
    /**
     * Pending-record schema version (1)
     */
    schema: number;
};
