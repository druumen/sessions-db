/**
 * IO orchestration for sessions-db.
 *
 * Responsibilities:
 *  - Build canonical event objects (`newEvent`)
 *  - Append events to `events.jsonl` via single-syscall O_APPEND
 *    (`fs.appendFileSync` with `{ flag: 'a' }`) — race-safe across
 *    processes (POSIX guarantees `O_APPEND + write(2)` is atomic up to
 *    PIPE_BUF for regular files; we enforce a hard MAX_EVENT_BYTES guard
 *    so payloads never approach that bound)
 *  - Atomically rewrite the projection cache under a file lock
 *    (write `.tmp.<pid>` → fsync → rename → release lock)
 *  - Rebuild the projection from events.jsonl when needed (with explicit
 *    tail-partial vs middle-line corruption diagnostics)
 *  - Best-effort incremental update for hook callers (`tryUpdateProjection`)
 *    that holds the projection lock across the full load → apply → save
 *    cycle so concurrent hooks cannot clobber each other's derived state
 *
 * Zero new npm deps: `node:fs`, `node:fs/promises`, `node:path`,
 * `node:crypto` (event_id), and the in-tree `lock.mjs` + `projection.mjs`.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { acquireLock } from './lock.mjs';
import { resolveIdentity } from './identity.mjs';
import { resolveStoragePaths } from './paths.mjs';
import { applyEvent, emptyProjection, rebuildFromEvents } from './projection.mjs';
import { generateSessionId } from './uuid.mjs';

const REPO_ROOT_DEFAULT = process.cwd();

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
export const MAX_EVENT_BYTES = 4096;

/**
 * Default on-disk paths. Resolved against `process.cwd()` so callers that
 * run from the workspace root see the canonical layout. Tests pass an
 * `opts.paths` override to write to a tmpdir.
 */
export const PATHS = Object.freeze({
  eventsJsonl: 'tickets/_logs/sessions-db-events.jsonl',
  projectionJson: 'tickets/_logs/sessions-db.json',
  lockFile: 'tickets/_logs/sessions-db.lock',
});

/**
 * Build a canonical event. Auto-fills `ts` (ISO ms) and `event_id`
 * (UUIDv7 with `evt_` prefix — same generator as session IDs but with a
 * different prefix so naive lookups can distinguish them).
 *
 * @param {{ op: string, stable_id: string, payload?: object,
 *   ts?: string, event_id?: string }} input
 */
export function newEvent({ op, stable_id, payload, ts, event_id }) {
  if (typeof op !== 'string' || op.length === 0) {
    throw new TypeError('newEvent: op required');
  }
  if (typeof stable_id !== 'string' || stable_id.length === 0) {
    throw new TypeError('newEvent: stable_id required');
  }
  return {
    ts: ts ?? new Date().toISOString(),
    // generateSessionId returns `sess_<uuidv7>` — re-prefix to `evt_` so
    // event ids and stable ids are visually distinct in jsonl tails.
    event_id: event_id ?? `evt_${generateSessionId().slice('sess_'.length)}`,
    op,
    stable_id,
    payload: payload ?? {},
  };
}

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
export async function appendEvent(event, opts = {}) {
  const { eventsPath } = resolvePaths(opts);
  ensureParentDir(eventsPath);
  const line = JSON.stringify(event) + '\n';
  // Enforce PIPE_BUF safety up front — exceeding this risks O_APPEND
  // interleave with concurrent writers (which then corrupts events.jsonl
  // in ways rebuild can only flag, not recover). Surface the error so the
  // caller can chunk or trim before persistence.
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_EVENT_BYTES) {
    throw new Error(
      `appendEvent: event payload too large (${bytes} bytes, max ${MAX_EVENT_BYTES}). ` +
        `Reduce payload size (sanitize transcript previews / fingerprints) or ` +
        `split into multiple events.`,
    );
  }
  // `flag: 'a'` => O_WRONLY | O_CREAT | O_APPEND. Linux + macOS guarantee
  // single-write atomicity for writes ≤ PIPE_BUF (4 KiB); the guard above
  // ensures `line` always fits.
  appendFileSync(eventsPath, line, { flag: 'a' });
}

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
export function readAllEvents(opts = {}) {
  const { eventsPath } = resolvePaths(opts);
  if (!existsSync(eventsPath)) return { events: [], corruptions: [] };
  const raw = readFileSync(eventsPath, 'utf8');
  // Use the raw string split — we want to preserve every separator so we can
  // tell whether a malformed line is at the tail (no trailing newline / last
  // non-empty line) or buried in the middle (has a valid line after it).
  const splitLines = raw.split('\n');

  // Build a list of {index, content} for non-empty lines, preserving original
  // file line numbers (1-based) for diagnostics.
  const nonEmpty = [];
  for (let i = 0; i < splitLines.length; i++) {
    if (splitLines[i].length > 0) {
      nonEmpty.push({ lineNumber: i + 1, content: splitLines[i] });
    }
  }
  // Also note whether the file ends with a newline — affects whether the
  // last non-empty line is considered "complete" for tail-partial detection.
  const endsWithNewline = raw.length > 0 && raw.endsWith('\n');

  const events = [];
  const corruptions = [];
  for (let idx = 0; idx < nonEmpty.length; idx++) {
    const { lineNumber, content } = nonEmpty[idx];
    try {
      events.push(JSON.parse(content));
    } catch (err) {
      // Tail = the very last non-empty line AND that line is not newline-
      // terminated (i.e. the writer was interrupted mid-line). A malformed
      // line that IS newline-terminated indicates corruption rather than an
      // in-progress write.
      const isLastNonEmpty = idx === nonEmpty.length - 1;
      const isTailPartial = isLastNonEmpty && !endsWithNewline;
      corruptions.push({
        lineNumber,
        kind: isTailPartial ? 'tail_partial' : 'middle_corruption',
        tolerated: isTailPartial,
        excerpt: content.slice(0, 80),
        error: String(err),
      });
    }
  }
  return { events, corruptions };
}

/**
 * Load the projection cache from disk. On missing/corrupt file, falls back
 * to a full rebuild from events.jsonl.
 *
 * @param {{ paths?: typeof PATHS, root?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function loadProjection(opts = {}) {
  const { projectionPath } = resolvePaths(opts);
  if (!existsSync(projectionPath)) {
    return rebuildProjectionInMemory(opts);
  }
  let raw;
  try {
    raw = readFileSync(projectionPath, 'utf8');
  } catch {
    return rebuildProjectionInMemory(opts);
  }
  try {
    const parsed = JSON.parse(raw);
    // Sanity check: must be an object with a `sessions` map and `_meta`.
    // Anything else => fall back to rebuild.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.sessions ||
      typeof parsed.sessions !== 'object' ||
      !parsed._meta ||
      typeof parsed._meta !== 'object'
    ) {
      return rebuildProjectionInMemory(opts);
    }
    return parsed;
  } catch {
    // JSON.parse failed => corrupted projection.
    return rebuildProjectionInMemory(opts);
  }
}

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
export async function saveProjection(projection, opts = {}) {
  const { projectionPath, lockPath } = resolvePaths(opts);
  ensureParentDir(projectionPath);
  ensureParentDir(lockPath);

  const withLock = opts.withLock !== false;
  const lock = withLock
    ? await acquireLock(lockPath, {
        timeoutMs: opts.lockTimeoutMs,
        retryMs: opts.lockRetryMs,
      })
    : null;

  try {
    saveProjectionUnlocked(projection, projectionPath);
  } finally {
    if (lock) lock.release();
  }
}

/**
 * Internal: write projection to disk without lock acquisition. Caller is
 * responsible for serializing concurrent writes (held lock or single-writer
 * invariant). Used by both the public locked `saveProjection` and the
 * `tryUpdateProjection` read-modify-write under-lock fast path.
 */
function saveProjectionUnlocked(projection, projectionPath) {
  const tmpPath = `${projectionPath}.tmp.${process.pid}`;
  try {
    // Bump _meta.updated to now so consumers can detect freshness without
    // touching event_count (which represents derived input volume).
    if (projection && projection._meta) {
      projection._meta.updated = new Date().toISOString();
    }
    const body = JSON.stringify(projection, null, 2);

    // Write + fsync via fd to guarantee data hits disk before rename.
    const fd = openSync(tmpPath, 'w');
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(tmpPath, projectionPath);
  } catch (err) {
    // Clean up partial tmp file so subsequent runs do not see stale debris.
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup — original error is more important.
    }
    throw err;
  }
}

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
export async function rebuildProjection(opts = {}) {
  const { projection, toleratedCorruptions } = rebuildProjectionInMemoryDetailed(opts);
  await saveProjection(projection, opts);
  return {
    sessionCount: Object.keys(projection.sessions).length,
    eventCount: projection._meta.event_count,
    toleratedCorruptions,
  };
}

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
export async function tryUpdateProjection(event, opts = {}) {
  // (1) Append to SSoT first. O_APPEND is race-safe so multiple concurrent
  // hooks all land their events without coordination. If the SSoT append
  // fails (oversized payload, disk full), we never proceed to projection —
  // there's no derived state to update.
  try {
    await appendEvent(event, opts);
  } catch (err) {
    return { ok: false, error: `append: ${err && err.message ? err.message : String(err)}` };
  }

  // (2) Acquire the projection lock for the full read-modify-write cycle.
  // The lock MUST span loadProjection → applyEvent → saveProjection,
  // otherwise two concurrent hooks both load N, each applies their own
  // event, and the loser's apply is overwritten on save (lost-update bug).
  // The events.jsonl SSoT still has both events — next rebuild fixes the
  // projection — but live readers see a stale state in the meantime.
  const { lockPath } = resolvePaths(opts);
  ensureParentDir(lockPath);
  let lock;
  try {
    lock = await acquireLock(lockPath, {
      timeoutMs: opts.lockTimeoutMs,
      retryMs: opts.lockRetryMs,
    });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }

  try {
    const projection = await loadProjection(opts);
    applyEvent(projection, event);
    // Skip the lock in saveProjection — we already hold it. Reacquiring
    // would be a guaranteed deadlock (the lock is exclusive create-or-fail).
    await saveProjection(projection, { ...opts, withLock: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    lock.release();
  }
}

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
 *   paths?: typeof PATHS,
 *   root?: string,
 *   lockTimeoutMs?: number,
 *   lockRetryMs?: number,
 * }} opts
 * @returns {Promise<{ ok: boolean, stableId?: string, eventId?: string,
 *   minted?: boolean, identityResolution?: object, error?: string }>}
 */
export async function recordSessionSeen(opts) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: 'recordSessionSeen: opts required' };
  }
  const { claudeSessionId, payloadBuilder } = opts;
  if (typeof claudeSessionId !== 'string' || claudeSessionId.length === 0) {
    return { ok: false, error: 'recordSessionSeen: claudeSessionId required' };
  }
  if (typeof payloadBuilder !== 'function') {
    return { ok: false, error: 'recordSessionSeen: payloadBuilder required' };
  }

  const { lockPath } = resolvePaths(opts);
  ensureParentDir(lockPath);

  let lock;
  try {
    lock = await acquireLock(lockPath, {
      timeoutMs: opts.lockTimeoutMs,
      retryMs: opts.lockRetryMs,
    });
  } catch (err) {
    return { ok: false, error: `lock: ${err && err.message ? err.message : String(err)}` };
  }

  try {
    // (1) Load projection INSIDE the lock so the resolution observes the
    // same baseline we're about to mutate.
    const projection = await loadProjection(opts);

    // (2) Run the 3-priority identity chain. resolveIdentity is pure — all
    // IO already happened (load) and the result is fully determined by the
    // projection snapshot + input signals.
    const identityResolution = resolveIdentity({
      projection,
      claudeSessionId,
      transcriptMeta: opts.transcriptMeta ?? null,
      gitContext: opts.gitContext ?? null,
      cwd: opts.cwd ?? null,
      fingerprints: opts.fingerprints ?? null,
      now: opts.now,
      timeWindowHours: opts.timeWindowHours,
      minCorroborators: opts.minCorroborators,
      mintStableId: generateSessionId,
    });
    const stableId = identityResolution.stableId;
    const minted = identityResolution.source === 'minted';

    // (3) Build payload via caller-supplied closure. The closure receives
    // both the stable_id AND the resolution result so callers may include
    // identity-derived fields (e.g. surface a human-readable description of
    // why this session was matched) without recomputing.
    let payload;
    try {
      payload = payloadBuilder(stableId, identityResolution);
    } catch (err) {
      return {
        ok: false,
        error: `payloadBuilder: ${err && err.message ? err.message : String(err)}`,
      };
    }
    if (!payload || typeof payload !== 'object') {
      payload = {};
    }
    // Guarantee claude_session_id is present in the payload — the projection
    // reducer keys off it for the `claude_session_ids[]` dedup.
    if (typeof payload.claude_session_id !== 'string' ||
        payload.claude_session_id.length === 0) {
      payload = { ...payload, claude_session_id: claudeSessionId };
    }

    // (4) Inject audit trail. The contract: every session_seen event MUST
    // carry the resolution so any future rebuild can show how the stable_id
    // was derived. If the caller already set it, we honor that. Otherwise
    // we inject the canonical shape.
    if (payload.identity_resolution === undefined) {
      payload.identity_resolution = {
        source: identityResolution.source,
        confidence: identityResolution.confidence,
        matched: identityResolution.matched,
      };
    }

    // (5) Merge parent candidates additively. resolveIdentity surfaces them
    // as `{ stable_id, source, confidence, reason }` records; the reducer
    // dedups by stable_id when applying. Already capped at
    // identity.MAX_PARENT_CANDIDATES so the merged payload stays under
    // MAX_EVENT_BYTES even when many fingerprint candidates exist.
    if (Array.isArray(identityResolution.parentCandidates) &&
        identityResolution.parentCandidates.length > 0) {
      const existing = Array.isArray(payload.parent_candidate_ids)
        ? payload.parent_candidate_ids
        : [];
      payload.parent_candidate_ids = [
        ...existing,
        ...identityResolution.parentCandidates,
      ];
    }

    // (5b) Surface omitted-count when the cap fired. Stored alongside the
    // candidates so CLI / audit can render "+ N more". A value of 0 (or
    // missing) means the surface is complete. Reducer treats missing as 0
    // for backward compat with pre-cap events.
    if (typeof identityResolution.parentCandidatesOmittedCount === 'number'
        && identityResolution.parentCandidatesOmittedCount > 0
        && payload.parent_candidates_omitted_count === undefined) {
      payload.parent_candidates_omitted_count =
        identityResolution.parentCandidatesOmittedCount;
    }

    // (6) Build the canonical event.
    const event = newEvent({
      op: 'session_seen',
      stable_id: stableId,
      payload,
    });

    // (7) Append to SSoT first (events.jsonl). Even if the projection write
    // later fails, the event is durable and a future rebuild reconstructs
    // the projection state.
    try {
      await appendEvent(event, opts);
    } catch (err) {
      return {
        ok: false,
        error: `append: ${err && err.message ? err.message : String(err)}`,
      };
    }

    // (8) Apply to projection in memory + persist (skip lock — already held).
    try {
      applyEvent(projection, event);
      await saveProjection(projection, { ...opts, withLock: false });
    } catch (err) {
      return {
        ok: false,
        error: `projection: ${err && err.message ? err.message : String(err)}`,
      };
    }

    return {
      ok: true,
      stableId,
      eventId: event.event_id,
      minted,
      identityResolution,
    };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk file triple for the current operation.
 *
 * Three input shapes are supported (priority order, first hit wins) so all
 * three storage-call patterns from Days 1-3 keep working unmodified:
 *
 *   1. `opts.paths` — fully-formed override (legacy form used by storage
 *      tests). Each field may be absolute (tests pin a tmpdir explicitly) or
 *      relative; relative paths anchor on `opts.root` (or cwd).
 *
 *   2. `opts.rootPath` — Day 4 single-arg form. Delegates to
 *      `resolveStoragePaths` so the canonical filenames + ascend chain apply
 *      uniformly. Library consumers (cockpit, init wizard) pass this.
 *
 *   3. `opts.root` — operations.mjs / wrapper form. Treated as a root
 *      override that combines with the canonical PATHS layout (relative
 *      segments) so existing operations callsites keep their behavior.
 *
 *   4. (default) — no override → `resolveStoragePaths()` with no args runs
 *      the full env > existing-storage > default chain anchored on cwd.
 *
 * Why preserve the legacy `opts.paths` shape verbatim instead of routing
 * everything through `resolveStoragePaths`? Existing storage unit tests
 * pass `paths.eventsJsonl = join(tmpdir, 'events.jsonl')` (NOT
 * `sessions-db-events.jsonl`) — switching the resolver would force every
 * test to know the canonical filename. The legacy shape stays a 1-line
 * passthrough so 350+ existing tests keep working.
 *
 * @param {{ paths?: { eventsJsonl: string, projectionJson: string, lockFile: string },
 *           rootPath?: string, root?: string, cwd?: string }} opts
 * @returns {{ eventsPath: string, projectionPath: string, lockPath: string }}
 */
function resolvePaths(opts) {
  // Shape 1: explicit `opts.paths` override (legacy storage-test form).
  // Anchor relative entries on `opts.root` (or cwd) just like Day 1.
  if (opts && opts.paths) {
    const root = opts.root ?? REPO_ROOT_DEFAULT;
    const abs = (p) => (isAbsolute(p) ? p : resolve(root, p));
    return {
      eventsPath: abs(opts.paths.eventsJsonl),
      projectionPath: abs(opts.paths.projectionJson),
      lockPath: abs(opts.paths.lockFile),
    };
  }
  // Shape 2: explicit `opts.rootPath` — Day 4 form, delegates entirely.
  if (opts && typeof opts.rootPath === 'string' && opts.rootPath.length > 0) {
    const r = resolveStoragePaths({ rootPath: opts.rootPath });
    return { eventsPath: r.eventsJsonl, projectionPath: r.projectionJson, lockPath: r.lockFile };
  }
  // Shape 3: legacy `opts.root` (operations / CLI --root / rebuild-test form).
  // PRESERVES the pre-Day-4 layout exactly: PATHS (which embeds the
  // `tickets/_logs/` prefix) is anchored at `opts.root`. We do NOT delegate
  // to the ascend chain here — many existing tests plant ONLY events.jsonl
  // (no projection file) at `<root>/tickets/_logs/` and call with `--root
  // <root>`; ascend's existence check would miss and fall through to
  // `<root>/.dru-code/`, breaking the test contract. The Day 4 ascend is
  // intended for callers that never supply a root, not for callers that
  // already pinned one.
  if (opts && typeof opts.root === 'string' && opts.root.length > 0) {
    const root = opts.root;
    const abs = (p) => (isAbsolute(p) ? p : resolve(root, p));
    return {
      eventsPath: abs(PATHS.eventsJsonl),
      projectionPath: abs(PATHS.projectionJson),
      lockPath: abs(PATHS.lockFile),
    };
  }
  // Shape 4: full default chain (env → ascend → cwd/.dru-code).
  const r = resolveStoragePaths({ cwd: opts && opts.cwd });
  return { eventsPath: r.eventsJsonl, projectionPath: r.projectionJson, lockPath: r.lockFile };
}

function ensureParentDir(filePath) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
}

/**
 * Read all events, escalating any middle-line corruption to a thrown error.
 * Tail-partial corruptions are returned alongside the events as a
 * diagnostic count so callers can observe them.
 *
 * @returns {{ events: Array<object>, toleratedCorruptions: number }}
 */
function readAllEventsOrThrow(opts) {
  const { events, corruptions } = readAllEvents(opts);
  const fatal = corruptions.filter((c) => !c.tolerated);
  if (fatal.length > 0) {
    const summary = fatal
      .map((c) => `line ${c.lineNumber}: ${c.error}`)
      .slice(0, 5)
      .join('; ');
    const err = new Error(
      `events.jsonl middle-line corruption (${fatal.length} line${fatal.length === 1 ? '' : 's'}): ${summary}`,
    );
    err.corruptions = fatal;
    throw err;
  }
  return { events, toleratedCorruptions: corruptions.length };
}

/**
 * Build a fresh projection in memory (without persisting). Used as the
 * backing op for both rebuildProjection and the loadProjection fallback.
 * Does NOT surface corruption diagnostics — used only when caller doesn't
 * need them (loadProjection fallback discards info anyway).
 */
function rebuildProjectionInMemory(opts) {
  const { events } = readAllEventsOrThrow(opts);
  if (events.length === 0) return emptyProjection();
  return rebuildFromEvents(events);
}

/**
 * Same as `rebuildProjectionInMemory` but returns the tolerated corruption
 * count alongside the projection so `rebuildProjection` can include it in
 * its diagnostics output.
 */
function rebuildProjectionInMemoryDetailed(opts) {
  const { events, toleratedCorruptions } = readAllEventsOrThrow(opts);
  const projection = events.length === 0 ? emptyProjection() : rebuildFromEvents(events);
  return { projection, toleratedCorruptions };
}
