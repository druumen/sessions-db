/**
 * Sessions-db stable identifier — `sess_<uuidv7-with-dashes>`.
 * See `uuid.mjs` `generateSessionId()` / `isSessionId()`.
 */
export type SessionStableId = string;
/**
 * Claude Code's per-process session UUID (canonical 8-4-4-4-12, v4).
 * Read from the SessionStart hook payload's `session_id` field.
 */
export type ClaudeSessionId = string;
/**
 * events.jsonl per-row identifier — `evt_<uuidv7-with-dashes>`.
 * Same generator as SessionStableId, different prefix (so visual scans of
 * the jsonl tail can tell event ids from session ids).
 */
export type EventId = string;
/**
 * ISO 8601 timestamp string (UTC `Z` suffix preferred, but offset forms
 * are accepted on input — sweep + projection consumers parse via
 * `Date.parse` not lex compare). All sessions-db writers emit `Z`.
 */
export type Iso8601 = string;
/**
 * Activity state machine (sweep-driven).
 *
 *   active   — fresh session OR within idle threshold (default 14d)
 *   idle     — past idle threshold but within archive threshold (default 30d)
 *   archived — past archive threshold (terminal — sweep never re-promotes)
 */
export type ActivityState = "active" | "idle" | "archived";
/**
 * Operator-driven outcome (set by `close` op).
 *
 *   open       — default; session has not been explicitly closed
 *   done       — work completed successfully
 *   blocked    — paused on external dependency
 *   abandoned  — won't continue
 *   merged     — folded into another session (manual_link target)
 *   superseded — replaced by a newer session
 */
export type Outcome = "open" | "done" | "blocked" | "abandoned" | "merged" | "superseded";
/**
 * Identity resolution source. Reflects which priority chain step assigned
 * the session's stable_id during the most recent `session_seen`.
 *
 *   claude_session_id_index — P1: exact csid hit in projection
 *   transcript_lineage      — P2: incoming firstParentUuid matches an existing
 *                              transcript_files[*].last_uuid (resume / fork)
 *   fingerprint_corroborator — P3: fingerprint match + sufficient corroborators
 *   minted                  — none of the above; fresh stable_id
 */
export type IdentitySource = "claude_session_id_index" | "transcript_lineage" | "fingerprint_corroborator" | "minted";
/**
 * Confidence label co-emitted with `IdentitySource`.
 *
 *   exact   — P1 hit (csid is unique per session)
 *   high    — P2 hit (lineage chain is structurally derived)
 *   low     — P3 hit (fingerprint + corroborators is heuristic)
 *   minted  — no resolution path matched (fresh id)
 */
export type IdentityConfidence = "exact" | "high" | "low" | "minted";
/**
 * events.jsonl op label. Each op has its own reducer in
 * `lib/projection.mjs` (`reduceSessionSeen`, `reduceSessionLink`, …).
 *
 *   session_seen   — primary observation (created + every SessionStart)
 *   session_link   — additive: attach tasks/projects to a session
 *   session_unlink — set-based filter: detach tasks/projects (P5)
 *   alias_set      — set or clear human-readable alias
 *   parent_set     — set or clear parent_session_id
 *   close          — set outcome + closed_at + closed_reason
 *   sweep          — synthetic: activity_state transition (active → idle / archived)
 *   manual_link    — operator-supplied parent_candidate_ids merge
 */
export type EventOp = "session_seen" | "session_link" | "session_unlink" | "alias_set" | "parent_set" | "close" | "sweep" | "manual_link";
/**
 * One transcript file (`~/.claude/projects/<workspace-hash>/<uuid>.jsonl`)
 * as captured in a session's `transcript_files[]`.
 *
 * `first_uuid` and `last_uuid` are the lineage anchors used by the P2
 * `transcript_lineage` resolution; `status` reflects the parser outcome
 * (`'ok' | 'corrupted' | 'too_large'`, see `lib/transcript.mjs`).
 */
export type TranscriptFile = {
    /**
     * Absolute path on disk
     */
    path: string;
    /**
     * First record uuid (lineage start)
     */
    first_uuid: (string | null);
    /**
     * Last record uuid (lineage tail)
     */
    last_uuid: (string | null);
    /**
     * File size in bytes
     */
    size: number;
    /**
     * fs mtime (ISO string)
     */
    mtime: Iso8601;
    /**
     *           Parser outcome — `corrupted` => unrecoverable, `too_large` =>
     *           skipped (`> maxSizeMb`)
     */
    status: ("ok" | "corrupted" | "too_large");
};
/**
 * Audit trail attached to each `session_seen` event payload (and mirrored
 * to `KnownSession.identity_resolution` — last-write-wins).
 *
 * `matched` is op-specific and kept loose (`Record<string, unknown>`)
 * because each `IdentitySource` populates a different shape:
 *   - claude_session_id_index → `{ claude_session_id }`
 *   - transcript_lineage      → `{ first_parent_uuid, matched_transcript_path, matched_last_uuid }`
 *   - fingerprint_corroborator → `{ fingerprints_matched, corroborators, corroborator_count, strong_corroborator_count }`
 *   - minted                  → `{}` or `{ ambiguous: true, ambiguous_count }`
 */
export type IdentityResolution = {
    source: IdentitySource;
    confidence: IdentityConfidence;
    matched: Record<string, unknown>;
};
/**
 * Hub-spoke parent hint surfaced when fingerprint evidence exists but does
 * not meet the corroborator threshold (or when multiple candidates tie).
 *
 * The `reason.confidence` carried inside the candidate object is a
 * categorical label (currently always `'low'` from `collectParentCandidates`).
 * The numeric `confidence` field at the top of the typedef is reserved for
 * future scoring (0..1) — current writers leave it as a category-derived
 * string in tests, so we type it loosely.
 */
export type ParentCandidate = {
    /**
     *           Stable id of the candidate parent session
     */
    candidate: SessionStableId;
    /**
     *           0..1 numeric score OR category label (`'low'`); current writers
     *           emit the categorical form
     */
    confidence: (number | string);
    reason: {
        fingerprints_matched: string[];
        corroborator_count: number;
        strong_corroborator_count: number;
        weak_corroborator_count: number;
    };
};
/**
 * Per-session record in `Projection.sessions[stable_id]`.
 *
 * Every field is populated lazily by the per-op reducers in
 * `lib/projection.mjs`. Rules of thumb:
 *  - `claude_session_ids[]` and `transcript_files[]` are append+dedup
 *    (later observations augment, never overwrite, the lineage history).
 *  - `worktree_*`, `branch_current`, `head_last_seen`, `identity_resolution`,
 *    `parent_candidates_omitted_count` are last-write-wins (recency
 *    matters more than first observation).
 *  - `branch_at_start`, `head_at_start`, `first_prompt_preview` are
 *    first-write-wins (initial observation captures these and we refuse
 *    to overwrite to preserve history).
 *  - `tasks[]` and `projects[]` are set-mutated by `session_link` (add) /
 *    `session_unlink` (remove).
 *  - `activity_state` is sweep-driven; `outcome` / `closed_at` /
 *    `closed_reason` are operator-driven via `close`.
 */
export type KnownSession = {
    stable_id: SessionStableId;
    alias: (string | null);
    claude_session_ids: ClaudeSessionId[];
    transcript_files: TranscriptFile[];
    fingerprints: {
        first_human_prompt_v1: (string | null);
        lineage_prefix_v1: (string | null);
    };
    parent_session_id: (SessionStableId | null);
    parent_candidate_ids: ParentCandidate[];
    /**
     *           Number of parent candidates dropped by the
     *           `MAX_PARENT_CANDIDATES` cap on the most recent session_seen
     */
    parent_candidates_omitted_count: number;
    identity_resolution: (IdentityResolution | null);
    worktree_path_observed: (string | null);
    worktree_realpath: (string | null);
    worktree_registry_name: (string | null);
    git_common_dir: (string | null);
    branch_at_start: (string | null);
    branch_current: (string | null);
    head_at_start: (string | null);
    head_last_seen: (string | null);
    tasks: string[];
    projects: string[];
    activity_state: ActivityState;
    outcome: Outcome;
    closed_at: (Iso8601 | null);
    closed_reason: (string | null);
    created_at: Iso8601;
    last_progress_at: Iso8601;
    first_prompt_preview: (string | null);
};
/**
 * Cache file `_meta` block.
 */
export type ProjectionMeta = {
    /**
     *           Pinned to `2` — bump when reducer semantics change
     */
    schema_version: 2;
    /**
     *           Names of the fingerprint algorithms the writer emits
     *           (e.g. `['first_human_prompt_v1', 'lineage_prefix_v1']`)
     */
    fingerprint_versions: string[];
    /**
     *           Last write timestamp (saveProjection bumps to now)
     */
    updated: (Iso8601 | null);
    /**
     *           Total events folded into this projection
     */
    event_count: number;
    last_event_id: (EventId | null);
};
/**
 * On-disk projection cache shape (`tickets/_logs/sessions-db.json`).
 * Result of folding `events.jsonl` from the empty projection.
 */
export type Projection = {
    _meta: ProjectionMeta;
    sessions: Record<SessionStableId, KnownSession>;
};
/**
 * One row in `events.jsonl` (the SSoT). `payload` is op-specific — each
 * op's reducer reads only the fields it understands; unknown fields are
 * preserved by the storage layer but ignored by the reducer.
 *
 * Tightening `payload` to a per-op union of payload shapes is intentionally
 * deferred — current writers (CLI + hook) treat payloads as
 * `Record<string, unknown>` and rely on runtime defensive reads. A future
 * type-tightening pass can add `SessionSeenPayload`, `SessionLinkPayload`,
 * etc. without breaking consumers.
 */
export type SessionEvent = {
    ts: Iso8601;
    event_id: EventId;
    op: EventOp;
    stable_id: SessionStableId;
    payload: Record<string, unknown>;
};
