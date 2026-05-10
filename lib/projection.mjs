/**
 * Pure projection logic for sessions-db.
 *
 * Events are appended to `events.jsonl` (SSoT). The projection cache
 * (`sessions-db.json`) is a fold of all events: `events → reduce → state`.
 * This module contains zero IO — it only knows how to fold one or more
 * events into a projection object. The `storage.mjs` wrapper handles disk.
 *
 * Schema v0.2 — see Phase 1 ticket §2 "Projection schema".
 *
 * Idempotency contract:
 * - Applying the same event sequence twice yields equivalent projections
 *   (sessions are merged, not duplicated; arrays are deduped where their
 *   identity is well-defined; counters are recomputed from event count, not
 *   incremented).
 * - Reducers mutate `projection` in place and return the same reference;
 *   callers can use either the return value or the mutated input.
 */

const SCHEMA_VERSION = 2;
const FINGERPRINT_VERSIONS = ['first_human_prompt_v1', 'lineage_prefix_v1'];

/**
 * Build an empty projection skeleton. Sessions map starts empty; metadata
 * has `event_count = 0` and `last_event_id = null`.
 *
 * @returns {{ _meta: object, sessions: Record<string, object> }}
 */
export function emptyProjection() {
  return {
    _meta: {
      schema_version: SCHEMA_VERSION,
      fingerprint_versions: [...FINGERPRINT_VERSIONS],
      updated: null,
      event_count: 0,
      last_event_id: null,
    },
    sessions: {},
  };
}

/**
 * Build a default session record. Caller passes the stable_id and the
 * `created_at` timestamp (typically the first observing event's `ts`).
 *
 * @param {string} stableId
 * @param {string} ts - ISO timestamp string used for both created_at and
 *   last_progress_at.
 */
export function emptySession(stableId, ts) {
  return {
    stable_id: stableId,
    alias: null,
    claude_session_ids: [],
    transcript_files: [],
    fingerprints: {
      first_human_prompt_v1: null,
      lineage_prefix_v1: null,
    },
    parent_session_id: null,
    parent_candidate_ids: [],
    // Count of parent candidates that resolveIdentity omitted from the most
    // recent session_seen due to the MAX_PARENT_CANDIDATES cap. 0 means the
    // surfaced parent_candidate_ids are complete; >0 means CLI / audit
    // should render "+ N more" or trigger a rebuild-from-events drill-down.
    // Last-write-wins (mirrors identity_resolution semantics).
    parent_candidates_omitted_count: 0,
    // Audit trail of how the most recent session_seen resolved this stable_id
    // — overwritten on every session_seen (always reflects the latest signal
    // set). Null on first creation; populated by reduceSessionSeen when the
    // event payload carries it. See identity.mjs / recordSessionSeen.
    identity_resolution: null,
    worktree_path_observed: null,
    worktree_realpath: null,
    worktree_registry_name: null,
    git_common_dir: null,
    branch_at_start: null,
    branch_current: null,
    head_at_start: null,
    head_last_seen: null,
    tasks: [],
    projects: [],
    activity_state: 'active',
    outcome: 'open',
    closed_at: null,
    closed_reason: null,
    created_at: ts,
    last_progress_at: ts,
    first_prompt_preview: null,
  };
}

/**
 * Apply a single event to a projection (mutating). Returns the same
 * projection reference for fluent chaining.
 *
 * Unknown ops are tolerated — they update _meta but otherwise no-op so a
 * future schema bump applied against an older binary degrades cleanly. We
 * still bump `event_count` so the rebuild detector remains accurate.
 *
 * @param {object} projection
 * @param {{ ts: string, event_id: string, op: string, stable_id: string,
 *   payload?: object }} event
 * @returns {object} projection
 */
export function applyEvent(projection, event) {
  if (!projection || typeof projection !== 'object' || !projection.sessions) {
    throw new TypeError('applyEvent: projection missing or malformed');
  }
  if (!event || typeof event !== 'object') {
    throw new TypeError('applyEvent: event missing');
  }
  const { op, stable_id: stableId, ts } = event;
  if (typeof stableId !== 'string' || stableId.length === 0) {
    throw new TypeError('applyEvent: event.stable_id required');
  }

  // Ensure session exists for any op except (theoretically) ops that operate
  // on global state — currently every op is session-scoped, so eager
  // creation is safe and idempotent.
  let session = projection.sessions[stableId];
  if (!session) {
    session = emptySession(stableId, ts);
    projection.sessions[stableId] = session;
  }

  switch (op) {
    case 'session_seen':
      reduceSessionSeen(session, event);
      break;
    case 'session_link':
      reduceSessionLink(session, event);
      break;
    case 'alias_set':
      reduceAliasSet(session, event);
      break;
    case 'parent_set':
      reduceParentSet(session, event);
      break;
    case 'close':
      reduceClose(session, event);
      break;
    case 'sweep':
      reduceSweep(session, event);
      break;
    case 'session_unlink':
      reduceSessionUnlink(session, event);
      break;
    case 'manual_link':
      reduceManualLink(session, event);
      break;
    default:
      // Unknown op — no-op on the session, but still account for it in
      // _meta so callers can detect drift.
      break;
  }

  // Bump last_progress_at to the most recent event's ts for ops that
  // represent real session activity. `sweep` is a maintenance/synthetic op
  // that should NOT bump last_progress_at on its own — its dedicated
  // reducer handles `effective_last_progress` if the sweep wants to push
  // the timestamp forward explicitly. We still guard against out-of-order
  // ts via lexical compare (correct for ISO 8601 strings).
  if (op !== 'sweep' && ts && (!session.last_progress_at || ts > session.last_progress_at)) {
    session.last_progress_at = ts;
  }

  // Update _meta — last_event_id wins on every event (events.jsonl ordering
  // is the canonical event order).
  projection._meta.event_count += 1;
  projection._meta.last_event_id = event.event_id ?? projection._meta.last_event_id;
  projection._meta.updated = ts ?? projection._meta.updated;

  return projection;
}

/**
 * Fold an event array into a fresh projection. Used both for full rebuilds
 * (storage.rebuildProjection) and for unit tests.
 *
 * @param {Array<object>} events
 */
export function rebuildFromEvents(events) {
  const projection = emptyProjection();
  if (!Array.isArray(events)) return projection;
  for (const event of events) {
    applyEvent(projection, event);
  }
  return projection;
}

// ---------------------------------------------------------------------------
// Per-op reducers (each isolated for testability).
// ---------------------------------------------------------------------------

function reduceSessionSeen(session, event) {
  const p = event.payload ?? {};

  // claude_session_ids — append (dedup); represents fork/resume of the same
  // logical session.
  if (typeof p.claude_session_id === 'string' && p.claude_session_id.length > 0) {
    if (!session.claude_session_ids.includes(p.claude_session_id)) {
      session.claude_session_ids.push(p.claude_session_id);
    }
  }

  // transcript_files — dedup by `path`. We replace the existing entry with
  // the newest data so latest_uuid / size / mtime / status reflect current
  // truth.
  if (p.transcript_file && typeof p.transcript_file === 'object') {
    const tf = p.transcript_file;
    const idx = session.transcript_files.findIndex((t) => t && t.path === tf.path);
    if (idx === -1) {
      session.transcript_files.push({ ...tf });
    } else {
      session.transcript_files[idx] = { ...session.transcript_files[idx], ...tf };
    }
  }

  // Fingerprints — only set when missing (first observation wins for v1
  // algorithm; future versions can layer a different field).
  if (p.fingerprints && typeof p.fingerprints === 'object') {
    if (
      session.fingerprints.first_human_prompt_v1 == null &&
      typeof p.fingerprints.first_human_prompt_v1 === 'string'
    ) {
      session.fingerprints.first_human_prompt_v1 = p.fingerprints.first_human_prompt_v1;
    }
    if (
      session.fingerprints.lineage_prefix_v1 == null &&
      typeof p.fingerprints.lineage_prefix_v1 === 'string'
    ) {
      session.fingerprints.lineage_prefix_v1 = p.fingerprints.lineage_prefix_v1;
    }
  }

  // Worktree / git context — last-write-wins for these recency-sensitive
  // fields. `head_last_seen` and `branch_current` should reflect the most
  // recent observation.
  setIfPresent(session, p, 'worktree_path_observed');
  setIfPresent(session, p, 'worktree_realpath');
  setIfPresent(session, p, 'worktree_registry_name');
  setIfPresent(session, p, 'git_common_dir');
  setIfPresent(session, p, 'branch_current');
  setIfPresent(session, p, 'head_last_seen');

  // First-write-wins fields (initial observation captures these and we
  // refuse to overwrite to preserve history).
  setIfMissing(session, p, 'branch_at_start');
  setIfMissing(session, p, 'head_at_start');
  setIfMissing(session, p, 'first_prompt_preview');
  if (typeof p.cwd === 'string' && session.cwd == null) {
    session.cwd = p.cwd;
  }

  // identity_resolution — last-write-wins. Every session_seen carries the
  // resolution outcome (P1/P2/P3/minted) that produced the stable_id this
  // event landed on. Storing the LATEST is informative: a session that
  // started life as 'minted' and then gets corroborated by subsequent
  // signals (resume / fork) shows the most recent resolution path.
  if (p.identity_resolution && typeof p.identity_resolution === 'object') {
    session.identity_resolution = p.identity_resolution;
  }

  // parent_candidates_omitted_count — last-write-wins. Backward compat:
  // missing field is treated as "no change to existing value" so old events
  // (pre-cap) replayed on a fresh projection leave the default 0 alone, and
  // new events on top of old projections (legacy session may not have the
  // field) get it created via the emptySession default. Numeric only;
  // anything else is ignored (defensive).
  if (typeof p.parent_candidates_omitted_count === 'number'
      && p.parent_candidates_omitted_count >= 0
      && Number.isFinite(p.parent_candidates_omitted_count)) {
    session.parent_candidates_omitted_count = p.parent_candidates_omitted_count;
  }
  // Defensive shim for projections persisted before the field existed: if a
  // session record loaded from disk lacks the field, materialize it as 0 so
  // downstream consumers can read it without optional-chaining everywhere.
  if (typeof session.parent_candidates_omitted_count !== 'number') {
    session.parent_candidates_omitted_count = 0;
  }

  // parent_candidate_ids — append + dedup by stable_id. Each session_seen
  // may surface fingerprint matches that didn't reach the corroborator
  // threshold (hub-spoke hints, NOT auto-promotion to parent_session_id).
  // We accumulate them across observations because cross-session evidence
  // is additive: a candidate observed once is still a candidate even if
  // later observations don't repeat it.
  if (Array.isArray(p.parent_candidate_ids)) {
    for (const candidate of p.parent_candidate_ids) {
      if (!candidate || typeof candidate !== 'object') continue;
      // session_seen-derived candidates use `stable_id` (canonical). Manual
      // links use `parent_id`. Accept either to keep the reducer
      // forward-compatible across both surfaces.
      const candidateId =
        typeof candidate.stable_id === 'string' && candidate.stable_id.length > 0
          ? candidate.stable_id
          : typeof candidate.parent_id === 'string' && candidate.parent_id.length > 0
            ? candidate.parent_id
            : typeof candidate.id === 'string' && candidate.id.length > 0
              ? candidate.id
              : null;
      if (candidateId === null) continue;
      const dup = session.parent_candidate_ids.find((c) => {
        const existingId =
          typeof c.stable_id === 'string'
            ? c.stable_id
            : typeof c.parent_id === 'string'
              ? c.parent_id
              : typeof c.id === 'string'
                ? c.id
                : null;
        return existingId !== null && existingId === candidateId;
      });
      if (!dup) session.parent_candidate_ids.push({ ...candidate });
    }
  }
}

function reduceSessionLink(session, event) {
  const p = event.payload ?? {};

  // P5 migration guard (codex P5 round-1 fix): P4-era `link --remove` wrote
  // `session_link` events with `payload.remove: true`, but the P4 reducer
  // never honored the flag — those events would still ADD the named tasks
  // / projects rather than remove them. Operators noticed and re-issued
  // their intent via other means; the bad events sit in events.jsonl as
  // dead markers.
  //
  // P5 ships `session_unlink` as the canonical remove op. To prevent any
  // rebuild-from-events run from silently re-adding tasks / projects the
  // operator had already abandoned, we explicitly skip the entire add path
  // when we see the legacy `payload.remove === true` marker. Operators who
  // want to remove the link must re-issue `link --remove --task X` under
  // P5, which now writes `session_unlink` (see cli/link.mjs).
  //
  // We deliberately do NOT dispatch into `reduceSessionUnlink` here — those
  // P4 markers carry add-shaped semantics ("we wanted to remove these
  // listed tasks") in a context where the actual session.tasks state may
  // already have been modified by subsequent legitimate events. Treating
  // them as no-ops is the safest projection-stable choice; treating them
  // as unlinks would risk double-removing items the operator legitimately
  // re-added later.
  if (p.remove === true) return;

  if (Array.isArray(p.tasks)) {
    for (const t of p.tasks) {
      if (typeof t === 'string' && t.length > 0 && !session.tasks.includes(t)) {
        session.tasks.push(t);
      }
    }
  }
  if (Array.isArray(p.projects)) {
    for (const proj of p.projects) {
      if (typeof proj === 'string' && proj.length > 0 && !session.projects.includes(proj)) {
        session.projects.push(proj);
      }
    }
  }
}

function reduceAliasSet(session, event) {
  const p = event.payload ?? {};
  // Allow explicit clear via null. Anything else must be a non-empty string;
  // missing payload.alias is a no-op (defensive).
  if (p.alias === null) {
    session.alias = null;
  } else if (typeof p.alias === 'string' && p.alias.length > 0) {
    session.alias = p.alias;
  }
}

function reduceParentSet(session, event) {
  const p = event.payload ?? {};
  if (p.parent_session_id === null) {
    session.parent_session_id = null;
  } else if (
    typeof p.parent_session_id === 'string' &&
    p.parent_session_id.length > 0
  ) {
    session.parent_session_id = p.parent_session_id;
  }
}

function reduceClose(session, event) {
  const p = event.payload ?? {};
  if (typeof p.outcome === 'string' && p.outcome.length > 0) {
    session.outcome = p.outcome;
  }
  // closed_at always set to event ts (the moment of closure).
  session.closed_at = event.ts ?? session.closed_at;
  if (typeof p.closed_reason === 'string') {
    session.closed_reason = p.closed_reason;
  } else if (p.closed_reason === null) {
    session.closed_reason = null;
  }
}

function reduceSweep(session, event) {
  const p = event.payload ?? {};
  if (typeof p.activity_state === 'string' && p.activity_state.length > 0) {
    session.activity_state = p.activity_state;
  }
  if (typeof p.effective_last_progress === 'string') {
    // Sweep-supplied effective time can be later than last_progress_at when
    // it represents an externally-measured idle decision. We do not lower
    // last_progress_at via sweep — that field is event-driven only.
    if (
      !session.last_progress_at ||
      p.effective_last_progress > session.last_progress_at
    ) {
      session.last_progress_at = p.effective_last_progress;
    }
  }
}

/**
 * P5: `session_unlink` reducer — set-based filter on tasks / projects.
 *
 * Counterpart to `reduceSessionLink` (additive). Operator (or future cleanup
 * hook) writes a session_unlink event with the same payload shape as
 * session_link; the reducer removes the named ids from the session arrays.
 *
 * Idempotent: removing an id that is not present is a no-op. The Set is
 * built per-payload so duplicates within payload.tasks collapse for free.
 *
 * Why set-based instead of mutate-each? Operator may pass `--task X --task X`
 * by accident; converting to a Set first keeps the filter O(n+m) and removes
 * surprise behavior where the second X is silently ignored vs. counted.
 */
function reduceSessionUnlink(session, event) {
  const p = event.payload ?? {};
  if (Array.isArray(p.tasks) && p.tasks.length > 0) {
    const removeSet = new Set(
      p.tasks.filter((t) => typeof t === 'string' && t.length > 0),
    );
    if (removeSet.size > 0 && Array.isArray(session.tasks)) {
      session.tasks = session.tasks.filter((t) => !removeSet.has(t));
    }
  }
  if (Array.isArray(p.projects) && p.projects.length > 0) {
    const removeSet = new Set(
      p.projects.filter((proj) => typeof proj === 'string' && proj.length > 0),
    );
    if (removeSet.size > 0 && Array.isArray(session.projects)) {
      session.projects = session.projects.filter((proj) => !removeSet.has(proj));
    }
  }
}

function reduceManualLink(session, event) {
  const p = event.payload ?? {};
  if (Array.isArray(p.parent_candidate_ids)) {
    for (const candidate of p.parent_candidate_ids) {
      if (!candidate || typeof candidate !== 'object') continue;
      // Dedup by candidate id — `parent_id` is the canonical key in v0.2
      // schema; fall back to JSON shape match for raw strings.
      const candidateId =
        typeof candidate.parent_id === 'string'
          ? candidate.parent_id
          : typeof candidate.id === 'string'
            ? candidate.id
            : null;
      const dup = session.parent_candidate_ids.find((c) => {
        const existingId =
          typeof c.parent_id === 'string'
            ? c.parent_id
            : typeof c.id === 'string'
              ? c.id
              : null;
        return existingId !== null && candidateId !== null && existingId === candidateId;
      });
      if (!dup) {
        session.parent_candidate_ids.push({ ...candidate });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setIfPresent(target, source, key) {
  const v = source[key];
  if (v !== undefined && v !== null) {
    target[key] = v;
  }
}

function setIfMissing(target, source, key) {
  const v = source[key];
  if ((target[key] == null) && v !== undefined && v !== null) {
    target[key] = v;
  }
}
