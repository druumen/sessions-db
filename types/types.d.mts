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
 *   session_seen     — primary observation (created + every SessionStart that
 *                      is not deferred to the pending area)
 *   session_progress — per-turn heartbeat from the `UserPromptSubmit` hook:
 *                      latches `first_prompt_preview` (first-write-wins) and
 *                      advances `last_progress_at` / `branch_current` /
 *                      `head_last_seen` (last-write-wins)
 *   session_link     — additive: attach tasks/projects to a session
 *   session_unlink   — set-based filter: detach tasks/projects (P5)
 *   alias_set        — set or clear human-readable alias
 *   parent_set       — set or clear parent_session_id
 *   close            — set outcome + closed_at + closed_reason
 *   sweep            — synthetic: activity_state transition (active → idle / archived)
 *   manual_link      — operator-supplied parent_candidate_ids merge
 *   ai_title_seen    — LEGACY (pre-0.3.0) hook observation: latest
 *                      `type:"ai-title"` record harvested from the Claude Code
 *                      transcript. Superseded by `name_set` (channel
 *                      `cc_ai_title`); still reduced forever because the log is
 *                      append-only and the 406 rows already written are where
 *                      name history starts.
 *   name_set         — set or clear one naming channel. The general form behind
 *                      both legacy naming ops. Payload:
 *                      `{ channel, value, source?, observed_from?, observed_at? }`.
 *                      `channel` / `source` are OPEN strings — the reducer must
 *                      preserve ones it does not recognise (see NameChannel)
 *   session_prune    — tombstone: drop a never-used ghost record from the
 *                      projection. Append-only — the prior events stay in
 *                      events.jsonl and the reducer re-deletes on replay.
 */
export type EventOp = "session_seen" | "session_progress" | "session_link" | "session_unlink" | "alias_set" | "parent_set" | "close" | "sweep" | "manual_link" | "ai_title_seen" | "name_set" | "session_prune";
/**
 * Naming channel — WHICH surface produced a name.
 *
 * Typed as `string`, not a union, and that is the contract rather than
 * laziness: the channel set is open so that adding a namer is a non-event, and
 * the price of that is a hard rule — **a reader must preserve channels it does
 * not recognise**. Typing this as a closed union would invite exactly the
 * filtering that silently deletes a newer version's names on the next save.
 *
 * The ones this build knows about (`KNOWN_CHANNELS` in lib/names.mjs):
 *   alias            — `sessions-db alias`, operator-set, never machine-written
 *   cc_custom_title  — Claude Code UI rename, typed by a human
 *   cc_ai_title      — Claude Code's LLM-generated title (drifts with the
 *                      conversation — 51 real renames on the reference db)
 *   agent_name       — agent-team badge; recorded but NOT in the display chain
 *   first_prompt     — pseudo-channel for `first_prompt_preview`; never stored
 *                      in `names[]`, exists so the precedence engine can name
 *                      the fallback when it wins
 *
 * Bounded: 1-64 chars of `[A-Za-z0-9._-]`, starting alphanumeric.
 */
export type NameChannel = string;
/**
 * Authorship of a name value — WHO wrote it. Deliberately not a synonym for
 * `NameChannel`: `cc_ai_title` and `cc_custom_title` arrive through the same
 * harvesting hook but one was written by a model and the other typed by a
 * person, and "show me only the names a human gave this session" is a question
 * you cannot ask without this axis.
 *
 *   human   — a person typed it
 *   llm     — a model generated it
 *   harvest — collected without a distinguishable author (e.g. `agent_name`)
 *
 * Open string, same reasoning and same bounds as `NameChannel` (max 32 chars).
 */
export type NameSource = string;
/**
 * One channel's CURRENT name, as stored in `KnownSession.names[]`.
 *
 * The projection holds exactly one of these per channel — never the history.
 * History lives in `events.jsonl` and is read back by `sessions-db names <id>`,
 * which replays it. Inlining history here would make the projection grow with
 * every rename, and the projection is the file every cockpit refresh reads
 * whole.
 *
 * `value: null` means the name was deliberately CLEARED — which is not the
 * same as never named, and is why a clear appends an entry rather than
 * deleting one.
 */
export type SessionName = {
    channel: NameChannel;
    value: (string | null);
    /**
     * When the value was observed / set
     */
    set_at: (Iso8601 | null);
    source: NameSource;
    /**
     * How many name events this channel has
     * seen (O(1) stand-in for the history)
     */
    set_count: number;
    /**
     * Provenance, e.g. the transcript path
     */
    observed_from?: string;
};
/**
 * One entry in a channel's replayed history (`sessions-db names <id>`), as
 * produced by `foldNameHistory`. Carries the event that caused it so a reader
 * can go back to the log.
 */
export type NameHistoryEntry = {
    channel: NameChannel;
    value: (string | null);
    set_at: (Iso8601 | null);
    source: NameSource;
    observed_from: (string | null);
    /**
     * Which op carried it (legacy ops included)
     */
    op: EventOp;
    event_id: (EventId | null);
};
/**
 * Result of the display-name precedence chain.
 *
 * `display_name_channel` is not decoration. With `alias` outranking a Claude
 * Code rename, a user can rename a session in Claude Code and see no change —
 * the UI has to be able to answer "because an alias outranks it".
 *
 * Both fields are null when no channel in the chain has a value; inventing a
 * placeholder is a rendering decision, not a model one.
 */
export type ResolvedDisplayName = {
    display_name: (string | null);
    display_name_channel: (NameChannel | null);
};
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
 *  - `created_at` is earliest-wins: the default is the first observing
 *    event's ts, but a promotion from the pending area replays the deferred
 *    SessionStart time so the record dates from when the session actually
 *    started, not from the first prompt.
 *  - `tasks[]` and `projects[]` are set-mutated by `session_link` (add) /
 *    `session_unlink` (remove).
 *  - `activity_state` is sweep-driven; `outcome` / `closed_at` /
 *    `closed_reason` are operator-driven via `close`.
 */
export type KnownSession = {
    stable_id: SessionStableId;
    alias: (string | null);
    /**
     *           AI-generated session title harvested from the Claude Code
     *           transcript's `{"type":"ai-title", "aiTitle": ...}` records.
     *           Since 0.3.0 this and `alias` are DERIVED VIEWS of the
     *           `cc_ai_title` / `alias` entries in `names[]`, kept so existing
     *           consumers survive the schema change. Read `names[]` in new code.
     */
    ai_title: (string | null);
    /**
     * One entry per naming channel, current value only — see
     * `SessionName`.
     *
     * **Optional on purpose.** A projection cache written before 0.3.0
     * has no `names`, and loading one does not rewrite it — the field
     * appears per session, when an event next touches that session. A
     * consumer that assumes presence would be typed against a file
     * shape that really exists on disk today, so the three name fields
     * are declared optional and callers coalesce (`session.names ?? []`).
     * `nameValuesFromSession` / `currentNameValue` already fall back to
     * the legacy `alias` / `ai_title` mirrors for exactly this case.
     */
    names?: SessionName[];
    /**
     * Derived: the winner of the precedence chain
     * (alias > cc_custom_title > cc_ai_title > first_prompt).
     */
    display_name?: (string | null);
    /**
     * Derived: which channel won, i.e. WHY the display shows what it
     * shows.
     */
    display_name_channel?: (NameChannel | null);
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
