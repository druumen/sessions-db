/**
 * Pure identity reconciliation for sessions-db.
 *
 * Maps a SessionStart hook signal set
 * (claude_session_id, transcript metadata, git context, fingerprints, cwd) to
 * a `stable_id` using a 3-priority lookup chain. No IO, no time, no
 * randomness beyond the optional `mintStableId` callback (which the caller
 * must supply — typically `generateSessionId` from `uuid.mjs`).
 *
 * Strategy (try in order, first match wins):
 *
 *   1. claude_session_id_index  (confidence='exact')
 *      Scan `projection.sessions[*].claude_session_ids[]` for an exact match.
 *      Empty arrays are skipped so non-session_seen-created skeleton records
 *      cannot false-match (regression guard from P2 storage round-1 review).
 *
 *   2. transcript_lineage      (confidence='high')
 *      If `transcriptMeta.firstParentUuid` matches some
 *      session.transcript_files[*].lastUuid, this csid is a resume / fork of
 *      that session. Structurally derived ID — high confidence, no
 *      corroborator needed.
 *
 *   3. fingerprint_corroborator (confidence='low')
 *      A fingerprint (first_human_prompt_v1 OR lineage_prefix_v1) match
 *      ALONE is too weak. We classify corroborators into two strengths:
 *
 *        STRONG (location-anchored — uniquely identify a workspace slot):
 *          - same_cwd
 *          - same_worktree_realpath
 *
 *        WEAK (signal-anchored — frequently shared by unrelated sessions):
 *          - same_branch_at_start  (e.g. dozens of sessions on `main`)
 *          - within_time_window    (e.g. dozens of sessions inside any 72h)
 *
 *      Acceptance requires BOTH:
 *        (a) at least 1 STRONG corroborator, AND
 *        (b) total (strong + weak) >= `minCorroborators` (default 2)
 *
 *      This blocks the false-merge "same branch + same window alone is enough"
 *      pattern that codex round-1 review flagged: two unrelated sessions on
 *      `main` within 72h would have weak=2, but strong=0 — must be rejected.
 *
 *      Ambiguity rule: if MULTIPLE candidates are above the threshold, we
 *      cannot pick one safely. We MINT a fresh stable_id and surface ALL
 *      above-threshold candidates as parent_candidates so a human / future
 *      manual_link can disambiguate. (Old behavior silently picked the first
 *      projection-iteration entry — ordering bug.)
 *
 *      Fingerprint matches without enough corroborators are surfaced as
 *      `parentCandidates[]` (hub-spoke derivation hints — the caller decides
 *      whether to promote them later).
 *
 *      To bound payload size (events.jsonl uses MAX_EVENT_BYTES=4096 cap),
 *      `parentCandidates[]` is hard-capped at MAX_PARENT_CANDIDATES (default
 *      16). Sort key: (strong corroborator count desc, recency desc). When
 *      truncated, `parentCandidatesOmittedCount` carries the omitted count
 *      so callers can surface "+ N more" in CLI / audit.
 *
 * If all three miss, the caller mints a fresh stable_id via `mintStableId()`
 * and we return `source: 'minted'`, `confidence: 'minted'`.
 *
 * Priority is strict — P1 hit short-circuits and never queries P2/P3, etc.
 *
 * @typedef {{
 *   stable_id: string,
 *   claude_session_ids: string[],
 *   transcript_files: Array<{ path?: string, last_uuid?: string|null }>,
 *   fingerprints: { first_human_prompt_v1: string|null, lineage_prefix_v1: string|null },
 *   cwd?: string|null,
 *   worktree_realpath?: string|null,
 *   branch_at_start?: string|null,
 *   last_progress_at?: string|null,
 * }} ProjectionSession
 *
 * @typedef {{
 *   _meta: object,
 *   sessions: Record<string, ProjectionSession>,
 * }} Projection
 *
 * @typedef {{
 *   firstUuid?: string|null,
 *   lastUuid?: string|null,
 *   firstParentUuid?: string|null,
 * }} TranscriptMetaInput
 *
 * @typedef {{
 *   worktreeRealpath?: string|null,
 *   worktreePath?: string|null,
 *   branch?: string|null,
 * }} GitContextInput
 *
 * @typedef {{ first_human_prompt_v1?: string|null, lineage_prefix_v1?: string|null }} FingerprintInput
 *
 * @typedef {{
 *   stableId: string,
 *   source: 'claude_session_id_index' | 'transcript_lineage' | 'fingerprint_corroborator' | 'minted',
 *   confidence: 'exact' | 'high' | 'low' | 'minted',
 *   matched: object,
 *   parentCandidates: Array<{ stable_id: string, source: string, confidence: string, reason: object }>,
 *   parentCandidatesOmittedCount?: number,
 * }} IdentityResult
 */

/** Default time window (hours) for the within_time_window corroborator. */
const DEFAULT_TIME_WINDOW_HOURS = 72;
const DEFAULT_MIN_CORROBORATORS = 2;

/**
 * Hard cap on `parentCandidates[]` length. Keeps event payloads safely under
 * `storage.MAX_EVENT_BYTES` (4 KiB POSIX PIPE_BUF guarantee).
 *
 * Empirical sizing (after collectParentCandidates payload trim — see that
 * function's bytes-on-disk note): each candidate serializes to ~241 bytes
 * (stable_id ≈ 50 + reason summary ≈ 130 + JSON wrapping ≈ 60). The rest
 * of a typical session_seen payload (csid + transcript_file + fingerprints
 * + git context + identity_resolution audit) is ~500–600 bytes. Budget:
 *   4096 - 600 baseline = 3496 bytes for candidates
 *   3496 / 241 ≈ 14.5 candidates worst-case
 * We cap at 10 to retain safety margin — 10 × 241 + 600 ≈ 3010 bytes,
 * comfortably under the cap with headroom for transcript_file edge cases.
 *
 * Codex round-1 review suggested 16; we reduced to 10 after measuring real
 * payload bytes (their suggestion did not include the per-candidate sizing
 * calculation; 16 candidates would intermittently exceed MAX_EVENT_BYTES
 * and recreate the very rejection the cap exists to prevent).
 *
 * Exported so callers / tests can reason about it. Override is intentionally
 * NOT exposed via opts — keeping it a constant prevents callers from passing
 * a number large enough to re-trip the MAX_EVENT_BYTES rejection.
 */
export const MAX_PARENT_CANDIDATES = 10;

/**
 * Corroborator strength classification. Exported so storage.mjs / projection
 * layers can reason about it consistently (e.g. CLI display, audit reports).
 *
 *   STRONG: location-anchored — these uniquely identify a workspace slot.
 *           Two unrelated sessions cannot share `cwd` or `worktree_realpath`
 *           by accident.
 *   WEAK:   signal-anchored — frequently shared by unrelated sessions.
 *           Many sessions live on `main` (same_branch_at_start) and inside
 *           any 72h window (within_time_window).
 */
export const STRONG_CORROBORATORS = Object.freeze([
  'same_cwd',
  'same_worktree_realpath',
]);
export const WEAK_CORROBORATORS = Object.freeze([
  'same_branch_at_start',
  'within_time_window',
]);

/**
 * Compute strong / weak / total counts from a corroborator hit map.
 * @param {{ same_cwd: boolean, same_worktree_realpath: boolean,
 *           same_branch_at_start: boolean, within_time_window: boolean }} hits
 * @returns {{ strong: number, weak: number, total: number }}
 */
export function classifyCorroborators(hits) {
  let strong = 0;
  let weak = 0;
  for (const k of STRONG_CORROBORATORS) if (hits && hits[k] === true) strong += 1;
  for (const k of WEAK_CORROBORATORS) if (hits && hits[k] === true) weak += 1;
  return { strong, weak, total: strong + weak };
}

/**
 * Acceptance gate: meets fingerprint+corroborator threshold for accept-as-
 * identity (vs surface-as-parent_candidate).
 *
 * Requires BOTH:
 *   - strong >= 1 (at least one location-anchored signal); AND
 *   - total >= minCorroborators (default 2).
 *
 * @param {{ strong: number, weak: number, total: number }} counts
 * @param {{ minCorroborators?: number }} opts
 */
export function meetsThreshold(counts, opts = {}) {
  if (!counts || typeof counts !== 'object') return false;
  const min = typeof opts.minCorroborators === 'number'
    ? opts.minCorroborators
    : DEFAULT_MIN_CORROBORATORS;
  return counts.strong >= 1 && counts.total >= min;
}

/**
 * Public entry: resolve identity from a hook signal set, OR mint a fresh one.
 *
 * @param {{
 *   projection: Projection,
 *   claudeSessionId: string,
 *   transcriptMeta?: TranscriptMetaInput | null,
 *   gitContext?: GitContextInput | null,
 *   cwd?: string | null,
 *   fingerprints?: FingerprintInput | null,
 *   now?: number,
 *   timeWindowHours?: number,
 *   minCorroborators?: number,
 *   mintStableId: () => string,
 * }} input
 * @returns {IdentityResult}
 */
export function resolveIdentity(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('resolveIdentity: input required');
  }
  const {
    projection,
    claudeSessionId,
    transcriptMeta = null,
    gitContext = null,
    cwd = null,
    fingerprints = null,
    now = Date.now(),
    timeWindowHours = DEFAULT_TIME_WINDOW_HOURS,
    minCorroborators = DEFAULT_MIN_CORROBORATORS,
    mintStableId,
  } = input;

  if (typeof mintStableId !== 'function') {
    throw new TypeError('resolveIdentity: mintStableId callback required');
  }
  if (typeof claudeSessionId !== 'string' || claudeSessionId.length === 0) {
    throw new TypeError('resolveIdentity: claudeSessionId required');
  }

  // Priority 1 — claude_session_id_index (exact).
  const p1 = findByClaudeSessionId(projection, claudeSessionId);
  if (p1 !== null) {
    return {
      stableId: p1,
      source: 'claude_session_id_index',
      confidence: 'exact',
      matched: { claude_session_id: claudeSessionId },
      // P1 hit — do NOT compute parentCandidates. The session is identified;
      // hub-spoke parent surfacing is only meaningful when we cannot resolve
      // the exact identity from a stable cross-session signal.
      parentCandidates: [],
      parentCandidatesOmittedCount: 0,
    };
  }

  // Priority 2 — transcript_lineage (high).
  const p2 = findByTranscriptLineage(projection, transcriptMeta);
  if (p2 !== null) {
    return {
      stableId: p2.stableId,
      source: 'transcript_lineage',
      confidence: 'high',
      matched: {
        first_parent_uuid: transcriptMeta?.firstParentUuid ?? null,
        matched_transcript_path: p2.matchedPath,
        matched_last_uuid: p2.matchedLastUuid,
      },
      parentCandidates: [],
      parentCandidatesOmittedCount: 0,
    };
  }

  // Priority 3 — fingerprint + corroborator (low).
  const corrCtx = {
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
    worktreeRealpath: gitContext && typeof gitContext.worktreeRealpath === 'string' && gitContext.worktreeRealpath.length > 0
      ? gitContext.worktreeRealpath
      : null,
    branch: gitContext && typeof gitContext.branch === 'string' && gitContext.branch.length > 0
      ? gitContext.branch
      : null,
    now,
    timeWindowHours,
  };
  const fpScan = scanFingerprintCandidates(projection, fingerprints, corrCtx);

  // Partition by acceptance threshold. Acceptance requires >=1 STRONG
  // corroborator AND total >= minCorroborators (see meetsThreshold).
  const above = [];
  const below = [];
  for (const c of fpScan) {
    if (meetsThreshold(c.strengthCounts, { minCorroborators })) above.push(c);
    else below.push(c);
  }

  // Exactly one above-threshold candidate → safe to accept as identity.
  // Below-threshold candidates still surface as parent_candidates (hub-spoke
  // hints; they share a fingerprint but lack enough corroborators).
  if (above.length === 1) {
    const accepted = above[0];
    const { list, omitted } = capParentCandidates(
      // Other above-threshold (none in this branch) + all below-threshold.
      below.filter((c) => c.stableId !== accepted.stableId),
    );
    return {
      stableId: accepted.stableId,
      source: 'fingerprint_corroborator',
      confidence: 'low',
      matched: {
        fingerprints_matched: accepted.fingerprintsMatched,
        corroborators: accepted.corroborators,
        corroborator_count: accepted.corroboratorCount,
        strong_corroborator_count: accepted.strengthCounts.strong,
      },
      parentCandidates: list,
      parentCandidatesOmittedCount: omitted,
    };
  }

  // Two cases reach here:
  //   1. above.length === 0 → no acceptable match → mint
  //   2. above.length >= 2  → AMBIGUOUS → mint + surface ALL as candidates
  //      (refuse to silently pick first projection-iteration entry)
  const minted = mintStableId();
  const matched = above.length >= 2
    ? { ambiguous: true, ambiguous_count: above.length }
    : {};
  // Order: above-threshold candidates first (stronger evidence), then below.
  // capParentCandidates sorts internally by (strong desc, recency desc), but
  // we surface above before below so the strongest evidence is never trimmed.
  const { list, omitted } = capParentCandidates([...above, ...below]);
  return {
    stableId: minted,
    source: 'minted',
    confidence: 'minted',
    matched,
    parentCandidates: list,
    parentCandidatesOmittedCount: omitted,
  };
}

// ---------------------------------------------------------------------------
// P1: claude_session_id_index
// ---------------------------------------------------------------------------

/**
 * Scan `projection.sessions` for the first record whose `claude_session_ids[]`
 * contains `csid`. Returns the matching `stable_id` or `null`.
 *
 * Empty `claude_session_ids[]` are skipped so a skeleton record produced by
 * a non-session_seen op (e.g. `manual_link`) never false-matches a fresh
 * incoming claude_session_id.
 *
 * Exported for direct testing.
 */
export function findByClaudeSessionId(projection, csid) {
  if (!projection || !projection.sessions || typeof projection.sessions !== 'object') {
    return null;
  }
  if (typeof csid !== 'string' || csid.length === 0) return null;
  for (const [stableId, session] of Object.entries(projection.sessions)) {
    if (!session || !Array.isArray(session.claude_session_ids)) continue;
    if (session.claude_session_ids.length === 0) continue;
    if (session.claude_session_ids.includes(csid)) return stableId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// P2: transcript_lineage
// ---------------------------------------------------------------------------

/**
 * Look for a session whose `transcript_files[*].last_uuid` equals
 * `transcriptMeta.firstParentUuid`. That equality means our incoming
 * transcript starts off the tail of an existing session's transcript — i.e.
 * fork or resume.
 *
 * Returns `{ stableId, matchedPath, matchedLastUuid }` on hit, `null`
 * otherwise. `transcriptMeta == null` (or missing firstParentUuid) returns
 * `null` cleanly.
 *
 * Exported for direct testing.
 */
export function findByTranscriptLineage(projection, transcriptMeta) {
  if (!transcriptMeta || typeof transcriptMeta !== 'object') return null;
  const parent = typeof transcriptMeta.firstParentUuid === 'string'
    ? transcriptMeta.firstParentUuid
    : null;
  if (!parent || parent.length === 0) return null;
  if (!projection || !projection.sessions || typeof projection.sessions !== 'object') {
    return null;
  }
  for (const [stableId, session] of Object.entries(projection.sessions)) {
    if (!session || !Array.isArray(session.transcript_files)) continue;
    for (const tf of session.transcript_files) {
      if (!tf || typeof tf !== 'object') continue;
      // The reducer stores the field as `last_uuid` (snake_case payload).
      // Defensive read for both naming styles.
      const lastUuid = typeof tf.last_uuid === 'string' && tf.last_uuid.length > 0
        ? tf.last_uuid
        : (typeof tf.lastUuid === 'string' && tf.lastUuid.length > 0 ? tf.lastUuid : null);
      if (lastUuid && lastUuid === parent) {
        return {
          stableId,
          matchedPath: typeof tf.path === 'string' ? tf.path : null,
          matchedLastUuid: lastUuid,
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// P3: fingerprint + corroborator
// ---------------------------------------------------------------------------

/**
 * For every session whose fingerprints (any v1) match the incoming ones,
 * compute corroborator hits and return one entry per match — the caller
 * picks acceptance vs parent-candidate based on `minCorroborators`.
 *
 * Exported for direct testing.
 *
 * @param {Projection} projection
 * @param {FingerprintInput|null} fingerprints
 * @param {{
 *   cwd: string|null,
 *   worktreeRealpath: string|null,
 *   branch: string|null,
 *   now: number,
 *   timeWindowHours: number,
 * }} corrCtx
 * @returns {Array<{
 *   stableId: string,
 *   fingerprintsMatched: string[],
 *   corroborators: { same_cwd: boolean, same_worktree_realpath: boolean,
 *                    same_branch_at_start: boolean, within_time_window: boolean },
 *   corroboratorCount: number,
 *   strengthCounts: { strong: number, weak: number, total: number },
 *   sessionLastProgressAt: string|null,
 * }>}
 */
export function scanFingerprintCandidates(projection, fingerprints, corrCtx) {
  /** @type {ReturnType<typeof scanFingerprintCandidates>} */
  const out = [];
  if (!projection || !projection.sessions || typeof projection.sessions !== 'object') {
    return out;
  }
  if (!fingerprints || typeof fingerprints !== 'object') return out;

  const fpHuman = typeof fingerprints.first_human_prompt_v1 === 'string' && fingerprints.first_human_prompt_v1.length > 0
    ? fingerprints.first_human_prompt_v1
    : null;
  const fpLineage = typeof fingerprints.lineage_prefix_v1 === 'string' && fingerprints.lineage_prefix_v1.length > 0
    ? fingerprints.lineage_prefix_v1
    : null;

  if (fpHuman === null && fpLineage === null) return out;

  const windowMs = (typeof corrCtx.timeWindowHours === 'number' && corrCtx.timeWindowHours >= 0
    ? corrCtx.timeWindowHours
    : DEFAULT_TIME_WINDOW_HOURS) * 3600 * 1000;

  for (const [stableId, session] of Object.entries(projection.sessions)) {
    if (!session || !session.fingerprints || typeof session.fingerprints !== 'object') continue;

    /** @type {string[]} */
    const matched = [];
    if (
      fpHuman !== null &&
      typeof session.fingerprints.first_human_prompt_v1 === 'string' &&
      session.fingerprints.first_human_prompt_v1 === fpHuman
    ) {
      matched.push('first_human_prompt_v1');
    }
    if (
      fpLineage !== null &&
      typeof session.fingerprints.lineage_prefix_v1 === 'string' &&
      session.fingerprints.lineage_prefix_v1 === fpLineage
    ) {
      matched.push('lineage_prefix_v1');
    }
    if (matched.length === 0) continue;

    // Compute corroborators. Each corroborator reads a single comparable
    // field; missing fields on either side count as "not corroborated".
    const corroborators = {
      same_cwd: corrCtx.cwd !== null
        && typeof session.cwd === 'string'
        && session.cwd.length > 0
        && session.cwd === corrCtx.cwd,
      same_worktree_realpath: corrCtx.worktreeRealpath !== null
        && typeof session.worktree_realpath === 'string'
        && session.worktree_realpath.length > 0
        && session.worktree_realpath === corrCtx.worktreeRealpath,
      same_branch_at_start: corrCtx.branch !== null
        && typeof session.branch_at_start === 'string'
        && session.branch_at_start.length > 0
        && session.branch_at_start === corrCtx.branch,
      within_time_window: false,
    };
    if (typeof session.last_progress_at === 'string' && session.last_progress_at.length > 0) {
      const lastMs = Date.parse(session.last_progress_at);
      if (Number.isFinite(lastMs)) {
        const diffMs = corrCtx.now - lastMs;
        // Within window when delta is non-negative (last_progress not in
        // future) and <= windowMs. Negative delta (clock skew / pre-dated
        // events) is treated as outside the window — defensive.
        corroborators.within_time_window = diffMs >= 0 && diffMs <= windowMs;
      }
    }

    const corroboratorCount = Object.values(corroborators).filter(Boolean).length;
    const strengthCounts = classifyCorroborators(corroborators);
    out.push({
      stableId,
      fingerprintsMatched: matched,
      corroborators,
      corroboratorCount,
      strengthCounts,
      sessionLastProgressAt: typeof session.last_progress_at === 'string'
        ? session.last_progress_at
        : null,
    });
  }
  return out;
}

/**
 * Convert raw fingerprint scan rows into stable parent candidate records,
 * deduped by `stable_id`. The reason payload preserves which fingerprints
 * matched + count summaries (strong + weak + total) so the caller can audit
 * the surface later (e.g. CLI listing parent candidates with their evidence).
 *
 * Bytes-on-disk note: we deliberately do NOT include the per-corroborator
 * boolean map (`{same_cwd, same_worktree_realpath, ...}`) here. That map
 * costs ~120 bytes per candidate and pushes the cumulative payload past
 * MAX_EVENT_BYTES (4 KiB POSIX PIPE_BUF) once a session accumulates ~10
 * candidates. The summary counts are sufficient for "is this candidate
 * strong evidence?" decisions; the exact corroborator vector is recoverable
 * by re-scanning against the seed session when needed (CLI drill-down).
 *
 * @param {ReturnType<typeof scanFingerprintCandidates>} rows
 * @returns {Array<{
 *   stable_id: string, source: 'fingerprint', confidence: 'low',
 *   reason: { fingerprints_matched: string[],
 *             corroborator_count: number,
 *             strong_corroborator_count: number,
 *             weak_corroborator_count: number },
 * }>}
 */
export function collectParentCandidates(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  /** @type {Map<string, ReturnType<typeof collectParentCandidates>[number]>} */
  const seen = new Map();
  for (const r of rows) {
    if (!r || typeof r.stableId !== 'string') continue;
    if (seen.has(r.stableId)) continue;
    // strengthCounts may be absent if the row was hand-built (tests). Fall
    // back to recomputing from the corroborator hit map so the reason is
    // always self-describing.
    const strength = r.strengthCounts ?? classifyCorroborators(r.corroborators);
    seen.set(r.stableId, {
      stable_id: r.stableId,
      source: 'fingerprint',
      confidence: 'low',
      reason: {
        fingerprints_matched: [...r.fingerprintsMatched],
        corroborator_count: r.corroboratorCount,
        strong_corroborator_count: strength.strong,
        weak_corroborator_count: strength.weak,
      },
    });
  }
  return Array.from(seen.values());
}

/**
 * Cap fingerprint scan rows to MAX_PARENT_CANDIDATES, sorted by
 * (strong corroborator count desc, last_progress recency desc, stable_id
 * asc-tie-break). Returns the surface-able candidate list plus the count of
 * candidates omitted due to the cap so the caller can inject
 * `parent_candidates_omitted_count` into the event payload.
 *
 * The cap exists because the SSoT events.jsonl uses MAX_EVENT_BYTES=4096
 * (POSIX PIPE_BUF guarantee for atomic O_APPEND); an unbounded
 * parent_candidates list can blow that budget and force appendEvent to
 * reject the entire session_seen, losing the audit trail.
 *
 * @param {ReturnType<typeof scanFingerprintCandidates>} rows
 * @param {{ cap?: number }} [opts]
 * @returns {{ list: ReturnType<typeof collectParentCandidates>, omitted: number }}
 */
export function capParentCandidates(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { list: [], omitted: 0 };
  }
  const cap = typeof opts.cap === 'number' && opts.cap > 0
    ? opts.cap
    : MAX_PARENT_CANDIDATES;

  // Dedup BEFORE sorting + capping — the same stable_id can appear once per
  // matching fingerprint, but we only count it once toward the cap.
  /** @type {Map<string, ReturnType<typeof scanFingerprintCandidates>[number]>} */
  const dedup = new Map();
  for (const r of rows) {
    if (!r || typeof r.stableId !== 'string') continue;
    if (!dedup.has(r.stableId)) dedup.set(r.stableId, r);
  }

  // Sort by strong corroborator count desc, then by recency desc.
  // Recency is parsed lexically when both ISO strings are present; rows
  // without a parseable last_progress sort to the end.
  const sorted = Array.from(dedup.values()).sort((a, b) => {
    const aStrong = (a.strengthCounts ?? classifyCorroborators(a.corroborators)).strong;
    const bStrong = (b.strengthCounts ?? classifyCorroborators(b.corroborators)).strong;
    if (bStrong !== aStrong) return bStrong - aStrong;
    const aTs = a.sessionLastProgressAt ?? '';
    const bTs = b.sessionLastProgressAt ?? '';
    if (aTs !== bTs) return bTs.localeCompare(aTs);
    return a.stableId.localeCompare(b.stableId);
  });

  const kept = sorted.slice(0, cap);
  const omitted = Math.max(0, sorted.length - kept.length);
  return { list: collectParentCandidates(kept), omitted };
}
