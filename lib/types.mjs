/**
 * Shared `@typedef` declarations for `@druumen/sessions-db`.
 *
 * This file is the single source of truth for the public type vocabulary —
 * other `.mjs` files reference these typedefs by name in their JSDoc rather
 * than re-declaring the same shape locally. `tsc --emitDeclarationOnly`
 * lifts the typedefs from this module into `types/types.d.ts`, and the
 * curated `types/index.d.ts` re-exports the public subset.
 *
 * Conventions:
 *  - Branded scalar types (SessionStableId, ClaudeSessionId, EventId, Iso8601)
 *    are kept as plain `string` aliases so JS callers do not need cast helpers.
 *    Cockpit / TS consumers get nominal-ish naming via the alias name in
 *    function signatures (`(stableId: SessionStableId)` reads better than
 *    `(stableId: string)`); the runtime check stays a string check.
 *  - Enums (ActivityState, Outcome, IdentitySource, IdentityConfidence,
 *    EventOp) are union-of-string-literals so misspellings are caught at
 *    type-check time.
 *  - The projection schema mirrors `lib/projection.mjs` `emptySession()` 1:1.
 *    When that function gains a field, this typedef MUST be updated in the
 *    same commit.
 *
 * This module exports nothing at runtime — it is types-only. The `export {}`
 * keeps it a valid ES module so tsc/Node both treat it as a module rather
 * than a script.
 */

/**
 * @typedef {string} SessionStableId
 *   Sessions-db stable identifier — `sess_<uuidv7-with-dashes>`.
 *   See `uuid.mjs` `generateSessionId()` / `isSessionId()`.
 */

/**
 * @typedef {string} ClaudeSessionId
 *   Claude Code's per-process session UUID (canonical 8-4-4-4-12, v4).
 *   Read from the SessionStart hook payload's `session_id` field.
 */

/**
 * @typedef {string} EventId
 *   events.jsonl per-row identifier — `evt_<uuidv7-with-dashes>`.
 *   Same generator as SessionStableId, different prefix (so visual scans of
 *   the jsonl tail can tell event ids from session ids).
 */

/**
 * @typedef {string} Iso8601
 *   ISO 8601 timestamp string (UTC `Z` suffix preferred, but offset forms
 *   are accepted on input — sweep + projection consumers parse via
 *   `Date.parse` not lex compare). All sessions-db writers emit `Z`.
 */

/**
 * Activity state machine (sweep-driven).
 *
 *   active   — fresh session OR within idle threshold (default 14d)
 *   idle     — past idle threshold but within archive threshold (default 30d)
 *   archived — past archive threshold (terminal — sweep never re-promotes)
 *
 * @typedef {'active' | 'idle' | 'archived'} ActivityState
 */

/**
 * Operator-driven outcome (set by `close` op).
 *
 *   open       — default; session has not been explicitly closed
 *   done       — work completed successfully
 *   blocked    — paused on external dependency
 *   abandoned  — won't continue
 *   merged     — folded into another session (manual_link target)
 *   superseded — replaced by a newer session
 *
 * @typedef {'open' | 'done' | 'blocked' | 'abandoned' | 'merged' | 'superseded'} Outcome
 */

/**
 * Identity resolution source. Reflects which priority chain step assigned
 * the session's stable_id during the most recent `session_seen`.
 *
 *   claude_session_id_index — P1: exact csid hit in projection
 *   transcript_lineage      — P2: incoming firstParentUuid matches an existing
 *                              transcript_files[*].last_uuid (resume / fork)
 *   fingerprint_corroborator — P3: fingerprint match + sufficient corroborators
 *   minted                  — none of the above; fresh stable_id
 *
 * @typedef {'claude_session_id_index' | 'transcript_lineage' | 'fingerprint_corroborator' | 'minted'} IdentitySource
 */

/**
 * Confidence label co-emitted with `IdentitySource`.
 *
 *   exact   — P1 hit (csid is unique per session)
 *   high    — P2 hit (lineage chain is structurally derived)
 *   low     — P3 hit (fingerprint + corroborators is heuristic)
 *   minted  — no resolution path matched (fresh id)
 *
 * @typedef {'exact' | 'high' | 'low' | 'minted'} IdentityConfidence
 */

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
 *
 * @typedef {'session_seen' | 'session_link' | 'session_unlink' | 'alias_set' | 'parent_set' | 'close' | 'sweep' | 'manual_link'} EventOp
 */

/**
 * One transcript file (`~/.claude/projects/<workspace-hash>/<uuid>.jsonl`)
 * as captured in a session's `transcript_files[]`.
 *
 * `first_uuid` and `last_uuid` are the lineage anchors used by the P2
 * `transcript_lineage` resolution; `status` reflects the parser outcome
 * (`'ok' | 'corrupted' | 'too_large'`, see `lib/transcript.mjs`).
 *
 * @typedef {Object} TranscriptFile
 * @property {string} path                    Absolute path on disk
 * @property {(string|null)} first_uuid       First record uuid (lineage start)
 * @property {(string|null)} last_uuid        Last record uuid (lineage tail)
 * @property {number} size                    File size in bytes
 * @property {Iso8601} mtime                  fs mtime (ISO string)
 * @property {('ok' | 'corrupted' | 'too_large')} status
 *           Parser outcome — `corrupted` => unrecoverable, `too_large` =>
 *           skipped (`> maxSizeMb`)
 */

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
 *
 * @typedef {Object} IdentityResolution
 * @property {IdentitySource} source
 * @property {IdentityConfidence} confidence
 * @property {Record<string, unknown>} matched
 */

/**
 * Hub-spoke parent hint surfaced when fingerprint evidence exists but does
 * not meet the corroborator threshold (or when multiple candidates tie).
 *
 * The `reason.confidence` carried inside the candidate object is a
 * categorical label (currently always `'low'` from `collectParentCandidates`).
 * The numeric `confidence` field at the top of the typedef is reserved for
 * future scoring (0..1) — current writers leave it as a category-derived
 * string in tests, so we type it loosely.
 *
 * @typedef {Object} ParentCandidate
 * @property {SessionStableId} candidate
 *           Stable id of the candidate parent session
 * @property {(number|string)} confidence
 *           0..1 numeric score OR category label (`'low'`); current writers
 *           emit the categorical form
 * @property {Object} reason
 * @property {string[]} reason.fingerprints_matched
 *           Fingerprint version names that matched (e.g.
 *           `['first_human_prompt_v1']`)
 * @property {number} reason.corroborator_count
 *           Total corroborators (strong + weak)
 * @property {number} reason.strong_corroborator_count
 *           Location-anchored corroborators (cwd / worktree_realpath)
 * @property {number} reason.weak_corroborator_count
 *           Signal-anchored corroborators (branch / time-window)
 */

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
 *
 * @typedef {Object} KnownSession
 * @property {SessionStableId} stable_id
 * @property {(string|null)} alias
 * @property {ClaudeSessionId[]} claude_session_ids
 * @property {TranscriptFile[]} transcript_files
 * @property {Object} fingerprints
 * @property {(string|null)} fingerprints.first_human_prompt_v1
 * @property {(string|null)} fingerprints.lineage_prefix_v1
 * @property {(SessionStableId|null)} parent_session_id
 * @property {ParentCandidate[]} parent_candidate_ids
 * @property {number} parent_candidates_omitted_count
 *           Number of parent candidates dropped by the
 *           `MAX_PARENT_CANDIDATES` cap on the most recent session_seen
 * @property {(IdentityResolution|null)} identity_resolution
 * @property {(string|null)} worktree_path_observed
 * @property {(string|null)} worktree_realpath
 * @property {(string|null)} worktree_registry_name
 * @property {(string|null)} git_common_dir
 * @property {(string|null)} branch_at_start
 * @property {(string|null)} branch_current
 * @property {(string|null)} head_at_start
 * @property {(string|null)} head_last_seen
 * @property {string[]} tasks
 * @property {string[]} projects
 * @property {ActivityState} activity_state
 * @property {Outcome} outcome
 * @property {(Iso8601|null)} closed_at
 * @property {(string|null)} closed_reason
 * @property {Iso8601} created_at
 * @property {Iso8601} last_progress_at
 * @property {(string|null)} first_prompt_preview
 */

/**
 * Cache file `_meta` block.
 *
 * @typedef {Object} ProjectionMeta
 * @property {2} schema_version
 *           Pinned to `2` — bump when reducer semantics change
 * @property {string[]} fingerprint_versions
 *           Names of the fingerprint algorithms the writer emits
 *           (e.g. `['first_human_prompt_v1', 'lineage_prefix_v1']`)
 * @property {(Iso8601|null)} updated
 *           Last write timestamp (saveProjection bumps to now)
 * @property {number} event_count
 *           Total events folded into this projection
 * @property {(EventId|null)} last_event_id
 */

/**
 * On-disk projection cache shape (`tickets/_logs/sessions-db.json`).
 * Result of folding `events.jsonl` from the empty projection.
 *
 * @typedef {Object} Projection
 * @property {ProjectionMeta} _meta
 * @property {Record<SessionStableId, KnownSession>} sessions
 */

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
 *
 * @typedef {Object} SessionEvent
 * @property {Iso8601} ts
 * @property {EventId} event_id
 * @property {EventOp} op
 * @property {SessionStableId} stable_id
 * @property {Record<string, unknown>} payload
 */

export {};
