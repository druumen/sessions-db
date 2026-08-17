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
 * Is a transcript scan trustworthy enough to authorise a delete?
 *
 * ## Why this gate exists
 *
 * Criterion (4) — "no transcript on disk" — is the ONLY criterion that
 * distinguishes a real session nobody ever resumed from a ghost: a record
 * written by 0.1.7's SessionStart has no preview, no fingerprint and no
 * ai_title either, exactly like a warm-pool spawn. So the disk scan is not a
 * heuristic here, it is the evidence. When the scan returns nothing, criterion
 * (4) is satisfied by EVERY record, and prune degenerates into "delete every
 * session that was never resumed".
 *
 * `indexTranscriptCsids()` cannot fail loudly — it returns a well-formed empty
 * result on any error, by design, because its other callers want tolerance.
 * Measured against a copy of the reference database (628 records) with three
 * different transcript roots:
 *
 *   real root (35 dirs / 308 files) ...... 151 candidates
 *   an existing but EMPTY directory ...... 192 candidates  (errors: [])
 *   a non-existent directory ............. 192 candidates  (errors: [ENOENT])
 *
 * The extra 41 in both broken cases all carried a real human question. The
 * triggers are mundane: `sudo sessions-db prune --yes` (HOME becomes
 * /var/root), a launchd/cron job with a minimal environment, a container, a
 * typo in `DRUUMEN_CLAUDE_PROJECTS_ROOT`, or macOS TCC denying access to
 * `~/.claude` for one run.
 *
 * The targeted fallback in `hasTranscriptOnDisk` does NOT cover this: it
 * derives its path from the same root, so it fails identically.
 *
 * The module already applies the right principle one criterion earlier —
 * an unparseable `created_at` spares the record, because "cannot verify" must
 * never resolve to "delete". This is that same rule applied to the disk scan,
 * which is where it actually mattered.
 *
 * @param {{ errors?: string[], fileCount?: number, dirCount?: number,
 *   root?: string }} scan result of `indexTranscriptCsids()`
 * @returns {{ trusted: boolean, reasons: string[] }} machine-readable reasons:
 *   `scan_errors` (the scan reported at least one unreadable path) and
 *   `empty_scan` (zero transcripts found anywhere).
 */
export function assessScanTrust(scan: {
    errors?: string[];
    fileCount?: number;
    dirCount?: number;
    root?: string;
}): {
    trusted: boolean;
    reasons: string[];
};
/**
 * Second, targeted disk check for one record.
 *
 * `indexTranscriptCsids()` swallows per-directory read errors, so a
 * permission blip could shrink the index and make a live session look
 * transcript-less. For every csid we ALSO compute the canonical path from the
 * record's own cwd and stat it directly. A hit from either path spares the
 * record.
 *
 * ⚠ Scope: this only covers ONE unreadable workspace directory. It reads the
 * SAME projects root as the index, so it is worthless when the root itself is
 * wrong, empty or unreadable — that class is handled by `assessScanTrust`,
 * which refuses the delete outright rather than trying to compensate.
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
 * Scan trust: a real run REFUSES when the transcript scan is not trustworthy
 * (see `assessScanTrust`) unless the caller passes `acceptUntrustedScan`. A
 * dry run still runs — reporting is not destructive — but carries
 * `disk_scan.trusted: false` so the caller can say so loudly.
 *
 * @param {{
 *   dryRun?: boolean,
 *   olderThanMs?: number,
 *   now?: number,
 *   reason?: string,
 *   acceptUntrustedScan?: boolean,
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
    acceptUntrustedScan?: boolean;
    rootPath?: string;
    root?: string;
    paths?: object;
    lockTimeoutMs?: number;
    lockRetryMs?: number;
}): Promise<object>;
/** Default age floor: never prune a record younger than this. */
export const DEFAULT_OLDER_THAN_MS: number;
