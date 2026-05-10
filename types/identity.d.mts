/**
 * Compute strong / weak / total counts from a corroborator hit map.
 * @param {{ same_cwd: boolean, same_worktree_realpath: boolean,
 *           same_branch_at_start: boolean, within_time_window: boolean }} hits
 * @returns {{ strong: number, weak: number, total: number }}
 */
export function classifyCorroborators(hits: {
    same_cwd: boolean;
    same_worktree_realpath: boolean;
    same_branch_at_start: boolean;
    within_time_window: boolean;
}): {
    strong: number;
    weak: number;
    total: number;
};
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
export function meetsThreshold(counts: {
    strong: number;
    weak: number;
    total: number;
}, opts?: {
    minCorroborators?: number;
}): boolean;
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
export function resolveIdentity(input: {
    projection: Projection;
    claudeSessionId: string;
    transcriptMeta?: TranscriptMetaInput | null;
    gitContext?: GitContextInput | null;
    cwd?: string | null;
    fingerprints?: FingerprintInput | null;
    now?: number;
    timeWindowHours?: number;
    minCorroborators?: number;
    mintStableId: () => string;
}): IdentityResult;
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
export function findByClaudeSessionId(projection: any, csid: any): string;
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
export function findByTranscriptLineage(projection: any, transcriptMeta: any): {
    stableId: string;
    matchedPath: any;
    matchedLastUuid: any;
};
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
export function scanFingerprintCandidates(projection: Projection, fingerprints: FingerprintInput | null, corrCtx: {
    cwd: string | null;
    worktreeRealpath: string | null;
    branch: string | null;
    now: number;
    timeWindowHours: number;
}): Array<{
    stableId: string;
    fingerprintsMatched: string[];
    corroborators: {
        same_cwd: boolean;
        same_worktree_realpath: boolean;
        same_branch_at_start: boolean;
        within_time_window: boolean;
    };
    corroboratorCount: number;
    strengthCounts: {
        strong: number;
        weak: number;
        total: number;
    };
    sessionLastProgressAt: string | null;
}>;
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
export function collectParentCandidates(rows: ReturnType<typeof scanFingerprintCandidates>): Array<{
    stable_id: string;
    source: "fingerprint";
    confidence: "low";
    reason: {
        fingerprints_matched: string[];
        corroborator_count: number;
        strong_corroborator_count: number;
        weak_corroborator_count: number;
    };
}>;
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
export function capParentCandidates(rows: ReturnType<typeof scanFingerprintCandidates>, opts?: {
    cap?: number;
}): {
    list: ReturnType<typeof collectParentCandidates>;
    omitted: number;
};
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
export const MAX_PARENT_CANDIDATES: 10;
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
export const STRONG_CORROBORATORS: readonly string[];
export const WEAK_CORROBORATORS: readonly string[];
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
 */
export type ProjectionSession = {
    stable_id: string;
    claude_session_ids: string[];
    transcript_files: Array<{
        path?: string;
        last_uuid?: string | null;
    }>;
    fingerprints: {
        first_human_prompt_v1: string | null;
        lineage_prefix_v1: string | null;
    };
    cwd?: string | null;
    worktree_realpath?: string | null;
    branch_at_start?: string | null;
    last_progress_at?: string | null;
};
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
 */
export type Projection = {
    _meta: object;
    sessions: Record<string, ProjectionSession>;
};
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
 */
export type TranscriptMetaInput = {
    firstUuid?: string | null;
    lastUuid?: string | null;
    firstParentUuid?: string | null;
};
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
 */
export type GitContextInput = {
    worktreeRealpath?: string | null;
    worktreePath?: string | null;
    branch?: string | null;
};
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
 */
export type FingerprintInput = {
    first_human_prompt_v1?: string | null;
    lineage_prefix_v1?: string | null;
};
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
 */
export type IdentityResult = {
    stableId: string;
    source: "claude_session_id_index" | "transcript_lineage" | "fingerprint_corroborator" | "minted";
    confidence: "exact" | "high" | "low" | "minted";
    matched: object;
    parentCandidates: Array<{
        stable_id: string;
        source: string;
        confidence: string;
        reason: object;
    }>;
    parentCandidatesOmittedCount?: number;
};
