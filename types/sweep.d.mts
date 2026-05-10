/**
 * Compute desired activity_state transitions for all sessions in a projection.
 *
 * @param {object} projection
 * @param {{
 *   now?: number,
 *   idleThresholdDays?: number,
 *   archiveThresholdDays?: number,
 * }} [opts]
 * @returns {Array<{
 *   stable_id: string,
 *   from_state: string,
 *   to_state: string,
 *   effective_last_progress: string,
 *   age_days: number,
 * }>}
 */
export function computeSweepTransitions(projection: object, opts?: {
    now?: number;
    idleThresholdDays?: number;
    archiveThresholdDays?: number;
}): Array<{
    stable_id: string;
    from_state: string;
    to_state: string;
    effective_last_progress: string;
    age_days: number;
}>;
/**
 * Compute the effective "last progress" timestamp for a session — the max
 * (latest) ISO 8601 timestamp across:
 *   - session.last_progress_at
 *   - session.transcript_files[*].mtime
 *   - session.hive_watcher_last_seen   (future hive-watcher integration)
 *
 * Returns the epoch ISO string when no candidate is parseable.
 *
 * Implementation note (codex P5 round-1 fix): we MUST parse each candidate
 * to epoch ms and compare numerically, then re-emit a normalized ISO 8601
 * (Z) string. A naive lexicographic `candidates.sort().pop()` only works
 * when every candidate is uniformly Z-suffixed with identical fractional
 * precision — and that invariant is fragile in practice:
 *   - transcript_files[*].mtime is sourced from the local fs `Stats.mtime`
 *     and gets ISO-stringified at write time; on a host with non-UTC
 *     TZ env the stringifier may emit `+02:00` offsets.
 *   - hive_watcher_last_seen comes from a different writer with its own
 *     formatter (sub-millisecond precision possible).
 *   - operator-supplied --json fixtures may carry mixed precisions.
 * Lex-sorting `2026-05-09T05:00:00+02:00` against `2026-05-09T04:00:00.000Z`
 * picks the wrong winner; lex-sorting `...100Z` against `...100.500Z`
 * picks the SHORTER string as larger because `0` < `5` at position 23 once
 * the lengths diverge. Both are silent miscategorization → wrong sweep
 * verdict. Date.parse() canonicalizes everything to a single epoch axis.
 *
 * @param {object} session
 * @returns {string} ISO 8601 timestamp (always Z, normalized)
 */
export function computeEffectiveLastProgress(session: object): string;
