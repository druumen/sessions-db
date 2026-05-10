/**
 * Pure sweep logic for sessions-db (Phase 5).
 *
 * `computeSweepTransitions` takes a projection snapshot + thresholds and
 * returns the list of activity_state transitions the caller should write as
 * `sweep` events. Pure: no IO, fully deterministic given (projection, now,
 * idleThresholdDays, archiveThresholdDays). The caller (CLI sweep handler)
 * is responsible for writing one event per transition through the normal
 * `tryUpdateProjection` path so events.jsonl + projection cache stay in
 * lockstep.
 *
 * State machine (terminal: archived):
 *
 *   active   ──ageDays >= idleThreshold──▶ idle
 *   active   ──ageDays >= archiveThreshold──▶ archived
 *   idle     ──ageDays >= archiveThreshold──▶ archived
 *   archived (terminal — never re-promoted by sweep)
 *
 * Idempotency:
 *   - Sweep does not generate a transition when the computed target equals
 *     the session's current activity_state. So invoking sweep twice on the
 *     same projection (with the same `now`) yields zero transitions on the
 *     second run.
 *   - `archived` is terminal — sweep never touches it. Operators rehydrate
 *     archived sessions explicitly (out of P5 scope).
 *
 * Effective last-progress = max ISO timestamp of:
 *   - session.last_progress_at
 *   - session.transcript_files[*].mtime
 *   - session.hive_watcher_last_seen   (placeholder for future integration —
 *     hive-watcher will surface filesystem activity timestamps independent of
 *     hook-derived events; reading the field today is a no-op when absent)
 *
 * Why max instead of just last_progress_at? `last_progress_at` is bumped by
 * hook-derived events (session_seen, alias_set, link, ...). A session whose
 * transcript is being actively appended (long /loop run, codex-rescue) but
 * which hasn't fired a hook in the sweep window would otherwise be flagged
 * idle. Transcript mtimes from session_seen payloads + the future hive-
 * watcher signal cover that gap.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_THRESHOLD_DAYS = 14;
const DEFAULT_ARCHIVE_THRESHOLD_DAYS = 30;

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
export function computeSweepTransitions(projection, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const idleThreshold = pickThreshold(
    opts.idleThresholdDays,
    projection && projection._meta && projection._meta.idle_threshold_days,
    DEFAULT_IDLE_THRESHOLD_DAYS,
  );
  const archiveThreshold = pickThreshold(
    opts.archiveThresholdDays,
    projection && projection._meta && projection._meta.archive_threshold_days,
    DEFAULT_ARCHIVE_THRESHOLD_DAYS,
  );

  const sessions = projection && projection.sessions ? projection.sessions : {};
  const transitions = [];

  for (const [stableId, session] of Object.entries(sessions)) {
    if (!session || typeof session !== 'object') continue;

    // Terminal — sweep never re-promotes archived sessions. Operator must
    // rehydrate explicitly (out of P5 scope).
    if (session.activity_state === 'archived') continue;

    const hasSignal = hasAnyParseableTimestamp(session);
    if (!hasSignal) {
      // Defensive: a session with no parseable timestamp at all means we
      // genuinely cannot decide its age. Skip rather than treat it as
      // infinitely old (which would archive every freshly-minted session
      // that happened to be persisted before its first ts wrote).
      continue;
    }
    const effective = computeEffectiveLastProgress(session);
    const effectiveMs = Date.parse(effective);
    if (!Number.isFinite(effectiveMs)) continue;
    const ageMs = now - effectiveMs;
    const ageDays = Math.floor(ageMs / MS_PER_DAY);

    let target;
    if (ageDays >= archiveThreshold) target = 'archived';
    else if (ageDays >= idleThreshold) target = 'idle';
    else target = 'active';

    if (target === session.activity_state) continue;

    transitions.push({
      stable_id: stableId,
      from_state: session.activity_state,
      to_state: target,
      effective_last_progress: effective,
      age_days: ageDays,
    });
  }

  return transitions;
}

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
export function computeEffectiveLastProgress(session) {
  if (!session || typeof session !== 'object') {
    return new Date(0).toISOString();
  }
  let maxEpoch = -Infinity;
  const considerCandidate = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0) return;
    const epoch = Date.parse(raw);
    if (!Number.isFinite(epoch)) return;
    if (epoch > maxEpoch) maxEpoch = epoch;
  };
  considerCandidate(session.last_progress_at);
  if (Array.isArray(session.transcript_files)) {
    for (const tf of session.transcript_files) {
      if (tf && typeof tf === 'object') considerCandidate(tf.mtime);
    }
  }
  considerCandidate(session.hive_watcher_last_seen);
  if (maxEpoch === -Infinity) {
    return new Date(0).toISOString();
  }
  return new Date(maxEpoch).toISOString();
}

/**
 * Did the session record carry at least one parseable timestamp from any of
 * the recognized signal sources? Sweep relies on this to distinguish "we
 * really know nothing about this session's recency" (skip — defensive) from
 * "the session is genuinely stale" (transition).
 *
 * Mirrors the candidate set in `computeEffectiveLastProgress` but returns a
 * boolean rather than a timestamp.
 */
function hasAnyParseableTimestamp(session) {
  if (typeof session.last_progress_at === 'string'
      && Number.isFinite(Date.parse(session.last_progress_at))) {
    return true;
  }
  if (Array.isArray(session.transcript_files)) {
    for (const tf of session.transcript_files) {
      if (tf && typeof tf.mtime === 'string'
          && Number.isFinite(Date.parse(tf.mtime))) {
        return true;
      }
    }
  }
  if (typeof session.hive_watcher_last_seen === 'string'
      && Number.isFinite(Date.parse(session.hive_watcher_last_seen))) {
    return true;
  }
  return false;
}

function pickThreshold(optsValue, metaValue, fallback) {
  if (typeof optsValue === 'number' && Number.isFinite(optsValue) && optsValue > 0) {
    return optsValue;
  }
  if (typeof metaValue === 'number' && Number.isFinite(metaValue) && metaValue > 0) {
    return metaValue;
  }
  return fallback;
}
