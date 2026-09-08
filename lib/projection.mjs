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
 * - **Applying the same event twice leaves the projection unchanged.** This
 *   is the one that has to hold in production: `tryUpdateProjection` appends
 *   to the log first and then folds, so a cold or corrupt cache is rebuilt
 *   from a log that already contains the event about to be applied. Sessions
 *   are merged rather than duplicated, arrays are deduped where their
 *   identity is well defined, and `names[].set_count` — the only counter in
 *   the session records — does not move when a naming re-asserts what a
 *   channel already holds (see lib/names.mjs).
 * - **`_meta` is included in that, and needed its own mechanism.**
 *   `event_count` is a second counter, and it cannot be made idempotent by
 *   comparing values the way `set_count` is: a repeat of an event that
 *   changed nothing is still one line in the log, so "did anything change?"
 *   is the wrong question for it. It deduplicates on event IDENTITY instead
 *   — a fold whose `event_id` is the one already recorded in `last_event_id`
 *   is a replay of that fold, not a new event. Without it the counter grew by
 *   one on every cold-cache write and, since its whole stated purpose is
 *   letting callers detect drift against the log, drifted itself.
 * - What that does NOT promise: that folding `L + L` equals folding `L` when
 *   `L` contains real renames. `A → B` concatenated with itself is the event
 *   sequence `A, B, A, B`, which is four namings, and no value-based reducer
 *   can tell that from a user who renamed back and forth — only event
 *   identity could, and keeping a set of applied event_ids in the projection
 *   is exactly the unbounded state the flat schema exists to avoid. Measured
 *   on the 2018-event reference log: applying every event twice changes
 *   nothing at all (0 of 632 sessions), while doubling the whole log moves
 *   `set_count` on the 51 sessions that were genuinely renamed, and on
 *   nothing else.
 * - Reducers mutate `projection` in place and return the same reference;
 *   callers can use either the return value or the mutated input.
 */

import { applyPrLinkToSession, prLinkFromEvent } from './pr-links.mjs';
import {
  DERIVED_FIELD_BY_CHANNEL,
  NAMES_MODEL_VERSION,
  applyNameToSession,
  displayNameForSession,
  findNameEntry,
  nameChangeFromEvent,
} from './names.mjs';

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
      // Which build of the name model materialised `names[]`. Separate from
      // `schema_version` on purpose: the record SHAPE is unchanged (nothing
      // gates on schema_version and the typed contract pins it at 2), but the
      // derived fields inside `names[]` are folds of the event log, so a cache
      // written before the model existed carries values the log disagrees
      // with. `loadProjection` treats a missing or older stamp as "this cache
      // predates the model" and rebuilds from the log.
      names_model_version: NAMES_MODEL_VERSION,
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
    // AI-generated session title harvested from the Claude Code transcript's
    // `{"type":"ai-title", "aiTitle": "..."}` records. Since 0.3.0 this and
    // `alias` are DERIVED VIEWS of the `cc_ai_title` / `alias` entries in
    // `names[]` below, kept so consumers written against them keep working.
    // The display order is no longer stated here — it lives in exactly one
    // place, lib/names.mjs.
    ai_title: null,
    // Name model (0.3.0). One entry per naming channel, CURRENT value only —
    // the history lives in events.jsonl and is read back by `sessions-db
    // names <id>`, which replays it. Inlining history here would make the
    // projection grow with every rename, and the projection is the file every
    // cockpit refresh reads whole. See lib/names.mjs.
    names: [],
    // Derived on every event from `names[]` + `first_prompt_preview` via the
    // single precedence chain in lib/names.mjs. `display_name_channel` is not
    // decoration: with `alias` outranking a Claude Code rename, the UI has to
    // be able to say WHY it is showing what it is showing.
    display_name: null,
    display_name_channel: null,
    // Which agent produced this session. `claude` for everything written by
    // the Claude Code hooks; `codex` for records created by
    // `sessions-db ingest-codex` from a rollout file. Records written before
    // 0.5.0 have no field at all and are shimmed to `claude` on load — they
    // could not have been anything else.
    source: 'claude',
    claude_session_ids: [],
    // Codex rollout ids. DELIBERATELY a separate axis from
    // `claude_session_ids`: that one has three-priority identity resolution,
    // transcript lineage and fingerprint corroboration hanging off it, all of
    // which mean "Claude Code session". Mixing codex ids in would make every
    // one of those silently wrong about what it is comparing.
    codex_session_ids: [],
    // MRs this session opened, from Claude Code's `pr-link` records. A list
    // because a session opens more than one; identity is (repository, number).
    // See lib/pr-links.mjs — state and title are deliberately NOT stored.
    pr_links: [],
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
 * future schema bump applied against an older binary degrades cleanly. They
 * still count toward `event_count`: an op this build cannot interpret is
 * still a line in the log, and a counter that skipped it would report drift
 * on a projection that is perfectly up to date.
 *
 * `event_count` counts DISTINCT events. Re-folding the event already recorded
 * in `_meta.last_event_id` does not move it — see the idempotency contract in
 * the module header for why that case is the normal path rather than a corner.
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
      // Two calls, deliberately not merged. The first reproduces the
      // pre-0.3.0 behaviour of the legacy top-level field EXACTLY — that is
      // what makes "an old log rebuilt by the new reducer yields the same
      // record" checkable rather than argued. The second is purely additive:
      // the same change, also recorded in the channel model. Same shape for
      // `ai_title_seen` below.
      reduceAliasSet(session, event);
      applyNameFromEvent(session, event);
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
    case 'ai_title_seen':
      reduceAiTitleSeen(session, event);
      applyNameFromEvent(session, event);
      break;
    case 'name_set':
      reduceNameSet(session, event);
      break;
    case 'pr_link_seen':
      reducePrLinkSeen(session, event);
      break;
    case 'codex_session_seen':
      reduceCodexSessionSeen(session, event);
      break;
    case 'session_progress':
      reduceSessionProgress(session, event);
      break;
    case 'session_prune':
      // Tombstone: drop the record entirely. `applyEvent` eagerly created the
      // session above (uniform for every op), so deleting here is both
      // idempotent and replay-stable — folding the same log twice lands the
      // same state. Events BEFORE the tombstone rebuilt the record; events
      // AFTER it (there should be none — prune only ever targets sessions
      // with no live claude_session_id) would legitimately resurrect it,
      // which is the correct reading of "this was garbage as of that point
      // in the log".
      //
      // ⚠ Version skew: this `delete` is the ONLY thing that keeps the eager
      // creation above from resurrecting a tombstoned record, and a reducer
      // that predates 0.2.0 does not have it. Folding a pruned log with an
      // older reducer brings every pruned record back, dated to the
      // tombstone's ts — and `rebuild` persists that. Not a no-op like other
      // unknown ops, and not guarded by `schema_version` (nothing compares
      // it). Documented under "Version skew" in the README; pinned by a test
      // that folds a pruned log through a guard-less reducer.
      delete projection.sessions[stableId];
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
  // the timestamp forward explicitly. `session_prune` is excluded because
  // the record no longer exists; touching the detached object would be dead
  // writes at best and a resurrection bug if the delete ever moves. We still
  // guard against out-of-order ts via lexical compare (correct for ISO 8601).
  if (!OBSERVATION_ONLY_OPS.has(op) && op !== 'sweep' && op !== 'session_prune' &&
      ts && (!session.last_progress_at || ts > session.last_progress_at)) {
    session.last_progress_at = ts;
  }

  // Refresh the derived name view. Done here — once, for every op — rather
  // than inside each reducer, because `display_name` depends on inputs three
  // different reducers can move (`names[]` from the name ops,
  // `first_prompt_preview` from session_seen / session_progress). Recomputing
  // centrally makes it structurally impossible for the derived value to drift
  // from the fields it is derived from. Guarded on the session still existing:
  // `session_prune` deleted it, and writing to the detached object would be a
  // resurrection bug the moment the delete moves.
  if (projection.sessions[stableId]) {
    refreshDerivedNames(projection.sessions[stableId]);
  }

  // Update _meta. `last_event_id` wins on every event (events.jsonl ordering
  // is the canonical event order) and is also what keeps the counter honest:
  // an event whose id is the one already recorded as last-folded is a REPLAY,
  // not a second event, so it must not move `event_count`.
  //
  // That case is the normal path, not a corner: `tryUpdateProjection` appends
  // to the log and then folds, so whenever the cache is cold or corrupt the
  // load rebuilds from a log that ALREADY contains the event about to be
  // applied, and the unconditional bump counted it twice. Measured before this
  // guard: a 3-event log produced `event_count: 4`, and every later cold write
  // added another permanent +1 — a drift detector that drifts.
  //
  // Not "skip the bump when the reducers changed nothing": a `name_set` that
  // re-asserts the value a channel already holds IS a real line in the log,
  // and not counting it would make the counter disagree with the log in the
  // other direction. What is being deduplicated is event IDENTITY.
  //
  // The boundary is the same one `set_count` documents above: only the TAIL is
  // compared, so an older event re-applied out of order is still counted
  // twice. Detecting that needs a set of applied event_ids in the projection,
  // which is exactly the unbounded state the flat schema exists to avoid — and
  // out-of-order re-application does not happen on any path here, while
  // "append then fold a log that already holds it" happens on every cold write.
  const eventId = typeof event.event_id === 'string' && event.event_id.length > 0
    ? event.event_id
    : null;
  // `null === null` must NOT read as "same event": events without an id are
  // indistinguishable from each other, so they are all counted.
  const isReplayOfLastFold = eventId !== null && eventId === projection._meta.last_event_id;
  if (!isReplayOfLastFold) projection._meta.event_count += 1;
  projection._meta.last_event_id = eventId ?? projection._meta.last_event_id;
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

  // created_at — EARLIEST observation wins (not first-write-wins, not
  // last-write-wins). Default `created_at` is the event ts, which is right
  // when the first event we ever see IS the session's birth. It stops being
  // right once SessionStart defers a brand-new session to the pending area
  // (see lib/pending.mjs): the promoting event fires minutes later, when the
  // user finally types, so its `ts` would date the session to the first
  // prompt instead of to the session's actual start. The promoter replays the
  // deferred observation time in `payload.created_at` and we take the earlier
  // of the two. Monotone-decreasing ⇒ order-independent and replay-stable.
  if (typeof p.created_at === 'string' && p.created_at.length > 0) {
    if (!session.created_at || p.created_at < session.created_at) {
      session.created_at = p.created_at;
    }
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
  // Same defensive shim for `ai_title` (added in 0.1.6): legacy sessions
  // loaded from a pre-0.1.6 projection cache will not have this key. Set
  // it to null so CLI / consumers can read the field unconditionally
  // without optional-chaining or `in` checks.
  if (!Object.prototype.hasOwnProperty.call(session, 'ai_title')) {
    session.ai_title = null;
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

/**
 * `ai_title_seen` reducer — last-write-wins update of `session.ai_title`.
 *
 * Hooks emit this op after tail-scanning a transcript and discovering the
 * most-recent `{"type":"ai-title",...}` record. Payload shape:
 *
 *   { ai_title: string|null,
 *     source_transcript?: string,
 *     observed_at?: Iso8601 }
 *
 * The hook is expected to suppress redundant events (only emit when the
 * value differs from the current projection) to avoid log spam, but this
 * reducer is safe under replay — applying the same payload twice yields
 * the same final state. Explicit `null` is honored as a clear (matches
 * `alias_set` semantics) so future operator tooling can remove a stale
 * ai_title without a full event-log rewrite.
 *
 * `source_transcript` / `observed_at` are kept in the event payload (audit
 * trail) but NOT mirrored onto the session record — the session-level fact
 * is just "the latest title we know about". Anyone needing provenance can
 * grep events.jsonl by stable_id.
 */
function reduceAiTitleSeen(session, event) {
  const p = event.payload ?? {};
  if (p.ai_title === null) {
    session.ai_title = null;
    return;
  }
  if (typeof p.ai_title === 'string' && p.ai_title.length > 0) {
    session.ai_title = p.ai_title;
  }
}

/**
 * `name_set` reducer — the general form every new name write uses.
 *
 * Payload shape:
 *   { channel: string,          // open string; see lib/names.mjs registry
 *     value: string|null,       // null = deliberately cleared, NOT deleted
 *     source?: string,          // human | llm | harvest (open string)
 *     observed_from?: string,   // provenance (transcript path, tool name, ...)
 *     observed_at?: Iso8601 }   // when the value was observed; defaults to ts
 *
 * Unknown channels are stored verbatim. That is the load-bearing half of the
 * decision not to enumerate channels: a reader that dropped what it did not
 * recognise would silently delete names on its next save, with no error and
 * no way to notice until somebody looked for a name that was gone.
 *
 * The two legacy top-level fields are kept in sync as derived views so every
 * existing consumer (`find`, `search`, cockpit's view-model) keeps working
 * across this change. They are mirrors of `names[]`, not a second truth.
 */
/**
 * Ops that observe something ABOUT a session rather than recording activity
 * BY it, and therefore must NOT move `last_progress_at`.
 *
 * Harvesting a name or an MR link is a read of a transcript that already
 * existed. `sessions-db harvest` folds hundreds of them at once for sessions
 * that have been dead for months; without this exemption every one of them is
 * dated to the moment of the backfill. Measured on the reference database
 * before the exemption existed: 246 of 246 backfilled records moved forward,
 * median +50.4 days, max +98.0 days — which re-sorted `search` / `find`
 * output and left 192 records in `active` that `sweep` would otherwise have
 * retired. The backfill's own dry run cannot show it, because the write is
 * exactly what dry run skips.
 *
 * Live hooks lose nothing: SessionStart's `session_seen` and every prompt's
 * `session_progress` carry the same timestamp and DO bump. `ai_title_seen` is
 * the pre-0.3.0 name of the same observation and belongs in the same class.
 *
 * Separate from the `sweep` / `session_prune` exclusions below, which are
 * there for their own reasons (documented at the call site) — merging them
 * into one list would merge three different arguments into one name.
 */
const OBSERVATION_ONLY_OPS = new Set(['name_set', 'pr_link_seen', 'ai_title_seen']);

function reduceNameSet(session, event) {
  const change = nameChangeFromEvent(event);
  if (!change) return;
  if (!applyNameToSession(session, change)) return;
  mirrorDerivedField(session, change.channel, change.value);
}

/**
 * `codex_session_seen` — a session observed in a codex rollout file.
 *
 * Separate op from `session_seen` rather than a flag on it: the two carry
 * different fields, arrive by different routes (hook vs. one-shot ingest) and
 * mean different things about identity. Sharing an op would put two sets of
 * semantics in one reducer and make every later reader ask "which kind is
 * this" at every field.
 *
 * Last-write-wins on the descriptive fields, first-write-wins on `created_at`
 * — the same rule `session_seen` uses. `last_progress_at` is NOT touched
 * here; the caller passes the rollout's own newest record timestamp as the
 * event `ts`, and the generic bump at the end of `applyEvent` uses it. That
 * is deliberate: dating a months-old codex session to the moment we indexed
 * it is exactly the defect 0.4.0 shipped and had to fix.
 */
function reduceCodexSessionSeen(session, event) {
  const p = (event && event.payload) || {};
  session.source = 'codex';
  const id = typeof p.codex_session_id === 'string' && p.codex_session_id.length > 0
    ? p.codex_session_id
    : null;
  if (id && !session.codex_session_ids.includes(id)) session.codex_session_ids.push(id);
  if (typeof p.cwd === 'string' && p.cwd.length > 0) session.cwd = p.cwd;
  if (typeof p.first_prompt_preview === 'string' && p.first_prompt_preview.length > 0 &&
      !session.first_prompt_preview) {
    session.first_prompt_preview = p.first_prompt_preview;
  }
  if (typeof p.started_at === 'string' && p.started_at.length > 0 &&
      (!session.created_at || p.started_at < session.created_at)) {
    session.created_at = p.started_at;
  }
  if (typeof p.originator === 'string') session.codex_originator = p.originator;
  if (typeof p.thread_source === 'string') session.codex_thread_source = p.thread_source;
  if (typeof p.transcript_file === 'string' && p.transcript_file.length > 0) {
    if (!Array.isArray(session.transcript_files)) session.transcript_files = [];
    if (!session.transcript_files.some((t) => t && t.path === p.transcript_file)) {
      session.transcript_files.push({
        path: p.transcript_file,
        first_seen_at: event.ts ?? null,
        last_seen_at: event.ts ?? null,
      });
    }
  }
}

/**
 * `pr_link_seen` — union-merge one MR link into the session.
 *
 * No derived/mirror field to keep in step (unlike names): nothing outside
 * `pr_links[]` describes them, which is on purpose. A record whose payload
 * carries no usable number is dropped by `prLinkFromEvent` rather than
 * stored as a hole.
 */
function reducePrLinkSeen(session, event) {
  const link = prLinkFromEvent(event);
  if (!link) return;
  applyPrLinkToSession(session, link);
}

/**
 * Additive names write for the legacy ops (`alias_set` / `ai_title_seen`).
 * Their own reducers still own the legacy top-level fields; this only records
 * the change in the channel model, which is how the 406 `ai_title_seen` rows
 * already on disk turn into name history for free.
 */
function applyNameFromEvent(session, event) {
  const change = nameChangeFromEvent(event);
  if (!change) return;
  applyNameToSession(session, change);
}

/**
 * Keep a legacy top-level field in step with its channel. Only the two
 * channels in `DERIVED_FIELD_BY_CHANNEL` have one; every other channel lives
 * in `names[]` alone.
 */
function mirrorDerivedField(session, channel, value) {
  const field = DERIVED_FIELD_BY_CHANNEL[channel];
  if (!field) return;
  session[field] = value ?? null;
}

/**
 * Recompute `display_name` / `display_name_channel`, and materialize `names[]`
 * on records that predate it.
 *
 * The shim matters for the same reason the `ai_title` one above does: a
 * projection loaded from disk was written by whatever version wrote it last,
 * and consumers should be able to read `session.names` without an `in` check
 * on every access.
 */
export function refreshDerivedNames(session) {
  if (!Array.isArray(session.names)) session.names = [];
  // Same shim reasoning as `names[]`: a projection loaded from disk was
  // written by whatever version wrote it last, and consumers should be able
  // to read `session.pr_links` without an `in` check on every access.
  if (!Array.isArray(session.pr_links)) session.pr_links = [];
  // Same shim reasoning again, for the 0.5.0 fields. A record without
  // `source` predates codex ingest and could not have been anything but a
  // Claude Code session.
  if (typeof session.source !== 'string') session.source = 'claude';
  if (!Array.isArray(session.codex_session_ids)) session.codex_session_ids = [];
  const resolved = displayNameForSession(session);
  session.display_name = resolved.display_name;
  session.display_name_channel = resolved.display_name_channel;
}

/**
 * Fold a log-derived `names[]` block into a cached session record, **one
 * channel at a time**, and re-derive everything that hangs off the result.
 *
 * Used by the cache repair in `storage.backfillNamesModel`, which needs the
 * log's answer for the counters it recomputes without throwing away what only
 * the cache still knows.
 *
 * ## Why the merge is per channel and not per session
 *
 * The log is the source of truth for names, but "the log has nothing to say
 * about this session" and "the log has nothing to say about this channel" are
 * different statements, and a session-level replace conflates them. Once a log
 * has been rotated or truncated — which is a supported thing to do to it — a
 * session can appear in the remaining log through ONE channel while the cache
 * still holds three others. Replacing the whole block then deletes the two the
 * log no longer mentions, silently, and no later event restores them.
 *
 * Per channel there is nothing left to assume: a channel the log speaks for
 * takes the log's entry, a channel it does not is kept exactly as it was. The
 * residual is a counter, not a name — if the rotation cut away part of a
 * channel's history, that channel's `set_count` reflects what the log still
 * holds. That is the same answer `rebuild` gives and the same answer the log
 * being SSoT implies; it cannot lose a name.
 *
 * ## Why the legacy mirrors are rewritten here
 *
 * `session.alias` / `session.ai_title` are derived views of two channels. If
 * the merge moves those channels and the mirrors are left where they were, the
 * record disagrees with itself: `display_name` follows `names[]` while
 * `search`'s `alias` label and `prune`'s "was this ever named" check read the
 * mirror. One session, two answers, depending on which consumer asked. A
 * channel the merged block has no entry for leaves its mirror alone — that is
 * the pre-0.3.0 record shape, and the read path already falls back to it.
 *
 * The per-session channel cap is deliberately NOT enforced on the union. Both
 * inputs were produced under it, so the result is bounded by twice the cap —
 * still bounded, which is all the cap exists to guarantee — and the only way
 * to honour it exactly here would be to drop entries, i.e. to reintroduce the
 * defect this function exists to remove.
 *
 * @param {object} session cached record, mutated in place
 * @param {Array<object>|undefined} fromLog the same session's `names[]` as
 *   folded from events.jsonl
 * @returns {object} the same session reference
 */
export function mergeNamesFromLog(session, fromLog) {
  const logged = (Array.isArray(fromLog) ? fromLog : [])
    .filter((e) => e && typeof e === 'object' && typeof e.channel === 'string');
  const spokenFor = new Set(logged.map((e) => e.channel));
  const cacheOnly = (Array.isArray(session.names) ? session.names : [])
    .filter((e) => e && typeof e === 'object' && !spokenFor.has(e.channel));
  session.names = [...logged, ...cacheOnly];

  for (const [channel, field] of Object.entries(DERIVED_FIELD_BY_CHANNEL)) {
    const entry = findNameEntry(session, channel);
    if (entry) session[field] = entry.value ?? null;
  }

  refreshDerivedNames(session);
  return session;
}

/**
 * `session_progress` reducer — the per-turn heartbeat written by the
 * `UserPromptSubmit` hook.
 *
 * Payload shape:
 *   { claude_session_id: string,
 *     first_prompt_preview?: string|null,
 *     branch_current?: string|null,
 *     head_last_seen?: string|null,
 *     worktree_path_observed?: string|null,
 *     cwd?: string }
 *
 * Field semantics — deliberately asymmetric:
 *
 *  - `first_prompt_preview` is **first-write-wins**. This hook fires on every
 *    prompt, so last-write-wins would leave the session titled by whatever
 *    the user happened to type most recently ("ok", "continue", "now fix the
 *    test") instead of by the question that opened it. The opening prompt is
 *    the one a human recognises the session by, so the first non-empty value
 *    latches and every later prompt is ignored for this field.
 *
 *  - `branch_current` / `head_last_seen` are **last-write-wins**: a session
 *    that starts on `master` and moves to a feature branch should read as the
 *    feature branch. These are exactly the fields that drift mid-session,
 *    which is why the hook pays for a (single-spawn) git probe at all.
 *
 *  - `last_progress_at` is NOT touched here — the generic bump in
 *    `applyEvent` already advances it to the event ts for every non-sweep,
 *    non-prune op. That bump is the entire point of this event: before it
 *    existed, a session that was never resumed had `last_progress_at` frozen
 *    at `created_at` forever, so "sort by recent activity" actually sorted by
 *    "who got resumed", not by who was working.
 *
 * Never creates identity: `claude_session_ids` is appended (deduped) exactly
 * like `session_seen` does, because a progress event can be the first thing
 * that ever mentions a csid on the promotion path.
 */
function reduceSessionProgress(session, event) {
  const p = event.payload ?? {};

  if (typeof p.claude_session_id === 'string' && p.claude_session_id.length > 0) {
    if (!session.claude_session_ids.includes(p.claude_session_id)) {
      session.claude_session_ids.push(p.claude_session_id);
    }
  }

  // First-write-wins — see docstring. `setIfMissing` treats null/undefined as
  // absent on both sides, so a hook that could not read the prompt (privacy
  // opt-out) leaves an earlier preview intact and does not latch an empty one.
  setIfMissing(session, p, 'first_prompt_preview');

  // Last-write-wins.
  setIfPresent(session, p, 'branch_current');
  setIfPresent(session, p, 'head_last_seen');
  setIfPresent(session, p, 'worktree_path_observed');

  if (typeof p.cwd === 'string' && session.cwd == null) {
    session.cwd = p.cwd;
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
