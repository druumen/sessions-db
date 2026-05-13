/**
 * Build a canonical event. Auto-fills `ts` (ISO ms) and `event_id`
 * (UUIDv7 with `evt_` prefix — same generator as session IDs but with a
 * different prefix so naive lookups can distinguish them).
 *
 * @param {{ op: string, stable_id: string, payload?: object,
 *   ts?: string, event_id?: string }} input
 */
export function newEvent({ op, stable_id, payload, ts, event_id }: {
    op: string;
    stable_id: string;
    payload?: object;
    ts?: string;
    event_id?: string;
}): {
    ts: string;
    event_id: string;
    op: string;
    stable_id: string;
    payload: any;
};
/**
 * Append an event to events.jsonl. **No lock** — relies on POSIX O_APPEND
 * atomicity for concurrent multi-process append safety, which is only
 * guaranteed for writes ≤ PIPE_BUF (4 KiB). We enforce that bound via
 * MAX_EVENT_BYTES and reject oversized events instead of silently risking
 * interleave.
 *
 * @param {object} event
 * @param {{ paths?: typeof PATHS, root?: string }} [opts]
 * @throws {Error} when the serialized line exceeds MAX_EVENT_BYTES — caller
 *   must reduce payload size or split into multiple smaller events.
 */
export function appendEvent(event: object, opts?: {
    paths?: typeof PATHS;
    root?: string;
}): Promise<void>;
/**
 * Read events.jsonl into structured `{ events, corruptions }` output.
 *
 * Distinguishes two corruption modes:
 *  - tail_partial: malformed line is the last non-empty line of the file —
 *    almost always a write-in-progress (writer crashed or we read mid-write).
 *    Tolerated; surfaced in `corruptions` for diagnostics but does not block
 *    rebuild.
 *  - middle_corruption: malformed line has at least one valid line after it
 *    in the file. This implies real data damage (filesystem error, partial
 *    overwrite, manual edit). Surfaced as a fatal corruption that callers
 *    (rebuildProjection) escalate to an exception.
 *
 * @param {{ paths?: typeof PATHS, root?: string }} [opts]
 * @returns {{ events: Array<object>, corruptions: Array<{
 *   lineNumber: number, kind: 'tail_partial'|'middle_corruption',
 *   tolerated: boolean, excerpt: string, error: string }> }}
 */
export function readAllEvents(opts?: {
    paths?: typeof PATHS;
    root?: string;
}): {
    events: Array<object>;
    corruptions: Array<{
        lineNumber: number;
        kind: "tail_partial" | "middle_corruption";
        tolerated: boolean;
        excerpt: string;
        error: string;
    }>;
};
/**
 * Load the projection cache from disk. On missing/corrupt file, falls back
 * to a full rebuild from events.jsonl.
 *
 * @param {{ paths?: typeof PATHS, root?: string }} [opts]
 * @returns {Promise<object>}
 */
export function loadProjection(opts?: {
    paths?: typeof PATHS;
    root?: string;
}): Promise<object>;
/**
 * Atomically write the projection cache.
 *
 * Default behavior acquires the file lock around the entire write. Callers
 * that already hold the lock (e.g. `tryUpdateProjection`'s read-modify-write
 * cycle) pass `withLock: false` to avoid double-acquire deadlock.
 *
 * Steps (with lock):
 *  1. Acquire the file lock
 *  2. Write to `<projection>.tmp.<pid>`
 *  3. fsync the tmp file
 *  4. rename tmp → real (atomic on POSIX)
 *  5. Release the lock
 *
 * On any error, attempts to clean up the tmp file before propagating.
 *
 * @param {object} projection
 * @param {{ paths?: typeof PATHS, root?: string,
 *   lockTimeoutMs?: number, lockRetryMs?: number,
 *   withLock?: boolean }} [opts]
 */
export function saveProjection(projection: object, opts?: {
    paths?: typeof PATHS;
    root?: string;
    lockTimeoutMs?: number;
    lockRetryMs?: number;
    withLock?: boolean;
}): Promise<void>;
/**
 * Full rebuild: scan events.jsonl, fold into a fresh projection, persist.
 *
 * Returns `toleratedCorruptions` so callers can surface diagnostics
 * (tail-partial lines from interrupted writes are common during heavy
 * concurrent load and worth observing). Middle-line corruption escalates
 * to a thrown error from `readAllEventsOrThrow` and never reaches here.
 *
 * @param {{ paths?: typeof PATHS, root?: string,
 *   lockTimeoutMs?: number, lockRetryMs?: number }} [opts]
 * @returns {Promise<{ sessionCount: number, eventCount: number,
 *   toleratedCorruptions: number }>}
 */
export function rebuildProjection(opts?: {
    paths?: typeof PATHS;
    root?: string;
    lockTimeoutMs?: number;
    lockRetryMs?: number;
}): Promise<{
    sessionCount: number;
    eventCount: number;
    toleratedCorruptions: number;
}>;
/**
 * Best-effort incremental update for hook callers.
 *
 * Pattern (from Phase 1 ticket §"Hook caller pattern"):
 *   1. Build event with newEvent()
 *   2. Append it to events.jsonl FIRST via O_APPEND (race-safe SSoT)
 *   3. Acquire the projection lock and run the full read-modify-write under
 *      the lock so concurrent hooks cannot read the same baseline projection
 *      and clobber each other's derived state.
 *   4. If anything fails, return `{ ok: false, error }` — the SSoT is
 *      already consistent, so the next rebuild reconciles the projection.
 *
 * @param {object} event
 * @param {{ paths?: typeof PATHS, root?: string,
 *   lockTimeoutMs?: number, lockRetryMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export function tryUpdateProjection(event: object, opts?: {
    paths?: typeof PATHS;
    root?: string;
    lockTimeoutMs?: number;
    lockRetryMs?: number;
}): Promise<{
    ok: boolean;
    error?: string;
}>;
/**
 * Atomic transaction for `session_seen` events.
 *
 * Why a dedicated entry point instead of "lookup → mint → tryUpdateProjection"?
 *
 * The hook's old flow ran `loadProjection` outside the lock to look up an
 * existing stable_id by claude_session_id, minted a fresh one on miss, built
 * the event with that stable_id, then handed the event to
 * `tryUpdateProjection`. With two concurrent hooks for the SAME
 * claude_session_id, both would observe an empty projection during the
 * unlocked lookup, both mint different stable_ids, both append events under
 * different stable_ids, and the projection would split into two records
 * for the same logical session.
 *
 * P3 (this phase) extends the resolution from "claude_session_id only" to
 * the full 3-priority chain implemented in `identity.mjs`:
 *
 *   1. claude_session_id_index (exact)         — baseline P2 behavior
 *   2. transcript_lineage (high)               — covers fork/resume
 *   3. fingerprint_corroborator (low)          — soft cross-session match
 *
 * On any miss → mint via uuidv7. Fingerprint matches without enough
 * corroborators are surfaced as `parent_candidate_ids[]` (hub-spoke hints —
 * NOT auto-promoted to parent_session_id).
 *
 * Critical-section flow (held under projection lock end-to-end):
 *
 *   1. Acquire projection lock
 *   2. Load projection inside lock
 *   3. Run resolveIdentity() against the baseline projection (P1→P2→P3→mint)
 *   4. Call `payloadBuilder(stableId, identityResolution)` for the payload
 *   5. Auto-inject `identity_resolution` + merged `parent_candidate_ids`
 *      into the payload so the audit trail is always present
 *   6. Build canonical event via `newEvent`
 *   7. Append event to events.jsonl
 *   8. Apply event to in-memory projection
 *   9. Save projection (under same lock — pass `withLock: false`)
 *  10. Release lock
 *
 * The `payloadBuilder` callback receives both `stableId` and the full
 * `identityResolution` object; callers may inspect/override the audit
 * fields, but if they leave `payload.identity_resolution` undefined we
 * inject it ourselves. `parent_candidate_ids` is merged additively so a
 * caller-supplied list (rare; mostly the projection's own derivation) is
 * preserved.
 *
 * Privacy: pass `opts.storeFirstPrompt: false` to clear the
 * `first_prompt_preview` field on the persisted payload (whatever the
 * payloadBuilder returned is overwritten with `null`). Default `true`
 * preserves the pre-0.1.0 behavior. Sanitization, fingerprints, and
 * transcript_files meta are NOT affected — only the human-readable preview
 * is stripped, so identity reconciliation still works for opt-out users.
 *
 * @param {{
 *   claudeSessionId: string,
 *   payloadBuilder: (stableId: string, identityResolution?: object) => object,
 *   transcriptMeta?: object|null,
 *   gitContext?: object|null,
 *   cwd?: string|null,
 *   fingerprints?: { first_human_prompt_v1?: string|null, lineage_prefix_v1?: string|null }|null,
 *   now?: number,
 *   timeWindowHours?: number,
 *   minCorroborators?: number,
 *   storeFirstPrompt?: boolean,
 *   paths?: typeof PATHS,
 *   root?: string,
 *   lockTimeoutMs?: number,
 *   lockRetryMs?: number,
 * }} opts
 * @returns {Promise<{ ok: boolean, stableId?: string, eventId?: string,
 *   minted?: boolean, identityResolution?: object, error?: string }>}
 */
export function recordSessionSeen(opts: {
    claudeSessionId: string;
    payloadBuilder: (stableId: string, identityResolution?: object) => object;
    transcriptMeta?: object | null;
    gitContext?: object | null;
    cwd?: string | null;
    fingerprints?: {
        first_human_prompt_v1?: string | null;
        lineage_prefix_v1?: string | null;
    } | null;
    now?: number;
    timeWindowHours?: number;
    minCorroborators?: number;
    storeFirstPrompt?: boolean;
    paths?: typeof PATHS;
    root?: string;
    lockTimeoutMs?: number;
    lockRetryMs?: number;
}): Promise<{
    ok: boolean;
    stableId?: string;
    eventId?: string;
    minted?: boolean;
    identityResolution?: object;
    error?: string;
}>;
/**
 * Hard cap on a single event's serialized size (line bytes including the
 * trailing newline). Set to 4 KiB — the conservative POSIX `PIPE_BUF` lower
 * bound that guarantees `O_APPEND + write(2)` is atomic on regular files
 * across concurrent writers. Larger payloads risk write interleave on some
 * filesystems even with O_APPEND, so we reject them up front and force the
 * caller to chunk or trim instead of corrupting events.jsonl.
 *
 * Exported so callers (sanitize layer, transcript reader, hook composers)
 * can pre-check before constructing events.
 */
export const MAX_EVENT_BYTES: 4096;
/**
 * Default on-disk paths. Resolved against `process.cwd()` so callers that
 * run from the workspace root see the canonical layout. Tests pass an
 * `opts.paths` override to write to a tmpdir.
 */
export const PATHS: Readonly<{
    eventsJsonl: "tickets/_logs/sessions-db-events.jsonl";
    projectionJson: "tickets/_logs/sessions-db.json";
    lockFile: "tickets/_logs/sessions-db.lock";
}>;
