/**
 * The session **name model** — channels, sources, precedence, history.
 *
 * A session is named by several independent parties, and before this module
 * existed only two of them reached the database, each as a single flat field
 * that the next observation overwrote. That lost two different things: the
 * names nobody collected (`custom-title`, the one a human typed by hand), and
 * every value a channel ever held before its current one.
 *
 * The model here is one **entry per channel**, plus the history that produced
 * it:
 *
 *   { channel, value, set_at, source, observed_from? }
 *
 * Two axes, deliberately not collapsed into one:
 *
 *  - `channel` — WHICH naming surface this value came from. Open string (see
 *    "Channel registry" below): adding a namer must be a non-event, and
 *    pre-reserving names would only encode today's guesses into the schema.
 *  - `source`  — WHO authored the value: `human` | `llm` | `harvest`. NOT a
 *    synonym for channel. `cc_ai_title` and `cc_custom_title` both arrive via
 *    the same harvesting hook, but one was written by a model and the other
 *    typed by a person. Without this axis you cannot ask "show me only the
 *    names a human ever gave this session", which is the question that
 *    distinguishes intent from drift.
 *
 * ## Channel registry (documented, not enumerated in code)
 *
 * | channel            | who sets it                          | source    | in display chain |
 * |--------------------|--------------------------------------|-----------|------------------|
 * | `alias`            | `sessions-db alias` (operator)       | `human`   | yes — highest    |
 * | `cc_custom_title`  | Claude Code UI rename (user typed)   | `human`   | yes              |
 * | `cc_ai_title`      | Claude Code LLM-generated title      | `llm`     | yes              |
 * | `agent_name`       | agent-team badge on the transcript   | `harvest` | **no**           |
 * | `first_prompt`     | pseudo-channel: `first_prompt_preview` | —       | yes — last resort|
 *
 * `agent_name` is deliberately outside the display chain: measured on the
 * reference machine, all 7 sessions carrying that record had an `agent_name`
 * byte-identical to their `ai_title` — it is a mirror, not an independent
 * name, and promoting it would only add a way for the display to flip
 * between two spellings of the same string. It is still recorded, because a
 * badge ("this session is agent X") is a real fact about the session.
 *
 * `first_prompt` is a pseudo-channel: it never appears in `session.names[]`
 * (nobody "sets" it — it is latched from the first prompt by the
 * `session_progress` / `session_seen` reducers). It exists as a channel name
 * only so the precedence engine can take ONE uniform map and answer with the
 * channel that won, including when the winner is the fallback.
 *
 * ## Forward compatibility: unknown channels are DATA, not noise
 *
 * Because the channel set is open, an older reader will meet channels it has
 * never heard of. It must keep them. The failure mode otherwise is silent and
 * delayed: an old `rebuild` (or any load → save round-trip) drops the names it
 * does not recognise, no error is raised, and the loss only surfaces when
 * somebody notices a name they set is gone. So `isKnownChannel()` exists for
 * *display ordering only* and nothing in the write path may filter on it.
 *
 * What IS filtered is malformed input — `channel` / `source` are bounded in
 * length and restricted to an identifier charset so a name entry cannot become
 * a general-purpose payload smuggling lane, and `value` is length-capped so a
 * runaway writer cannot inflate the projection. Unknown ≠ invalid: the first
 * is preserved, the second is refused.
 *
 * This module is pure (no IO, no clock, no randomness).
 */

// ---------------------------------------------------------------------------
// Channels / sources
// ---------------------------------------------------------------------------

/** Channels this version knows about by name. Open set — see module docs. */
export const CHANNEL_ALIAS = 'alias';
export const CHANNEL_CC_CUSTOM_TITLE = 'cc_custom_title';
export const CHANNEL_CC_AI_TITLE = 'cc_ai_title';
export const CHANNEL_AGENT_NAME = 'agent_name';

/**
 * Pseudo-channel for `first_prompt_preview`. Never stored in `names[]` —
 * see module docs.
 */
export const CHANNEL_FIRST_PROMPT = 'first_prompt';

/** Authorship of a name value. Open set, same rules as channels. */
export const SOURCE_HUMAN = 'human';
export const SOURCE_LLM = 'llm';
export const SOURCE_HARVEST = 'harvest';

/**
 * Display precedence — defined **once**, here. `cli/format.mjs` and any
 * consumer (cockpit) resolve through `resolveDisplayName` rather than
 * re-implementing the chain; two implementations is exactly how `find` and
 * the cockpit panel ended up disagreeing about what a session is called.
 *
 * `alias` stays highest by operator decision: it is the only channel a
 * machine never rewrites. `cc_ai_title` is rewritten by the model as the
 * conversation drifts (51 real renames on the reference database), and
 * `cc_custom_title`, though typed by a human, lives in Claude Code's own
 * state where later operations can carry it away.
 *
 * The known cost of that ordering: rename a session in Claude Code while an
 * old `alias` exists and the display does not change. That is why
 * `display_name_channel` is part of the model and not a debugging extra —
 * the UI has to be able to answer "because an alias outranks it".
 */
export const NAME_PRECEDENCE = Object.freeze([
  CHANNEL_ALIAS,
  CHANNEL_CC_CUSTOM_TITLE,
  CHANNEL_CC_AI_TITLE,
  CHANNEL_FIRST_PROMPT,
]);

/**
 * Channels this build recognises, in a stable display order. Used ONLY for
 * ordering / documentation — never to filter what gets stored.
 */
export const KNOWN_CHANNELS = Object.freeze([
  CHANNEL_ALIAS,
  CHANNEL_CC_CUSTOM_TITLE,
  CHANNEL_CC_AI_TITLE,
  CHANNEL_AGENT_NAME,
]);

/**
 * Channels whose current value is ALSO mirrored onto a legacy top-level
 * field, kept so existing consumers (`find`, `search`, cockpit view-model)
 * survive this schema change untouched. The mirrors are derived views of
 * `names[]`, not a second source of truth; removal is a later, separate
 * migration once every consumer reads `names[]`.
 */
export const DERIVED_FIELD_BY_CHANNEL = Object.freeze({
  [CHANNEL_ALIAS]: 'alias',
  [CHANNEL_CC_AI_TITLE]: 'ai_title',
});

// ---------------------------------------------------------------------------
// Bounds — the price of an open channel set (see module docs)
// ---------------------------------------------------------------------------

export const MAX_CHANNEL_LEN = 64;
export const MAX_SOURCE_LEN = 32;
/**
 * Cap on a stored name. The longest `ai_title` on the reference database is
 * 62 characters, so 512 leaves two orders of magnitude of headroom while
 * still bounding what one session can push into the projection.
 */
export const MAX_NAME_VALUE_LEN = 512;
/**
 * Cap on DISTINCT channels per session. The flatness invariant is
 * "projection size is O(channels), not O(renames)"; without a ceiling on
 * channels that is O(unbounded) again, just more slowly. Existing channels
 * keep updating past the cap — only brand-new ones are refused — so a real
 * namer can never be starved by junk that arrived first.
 */
export const MAX_CHANNELS_PER_SESSION = 32;

/**
 * Identifier charset for channel / source: ASCII alnum plus `_ - .`, must
 * start alnum. Rejects whitespace, quotes, control bytes, and anything that
 * would make a channel awkward to type as a CLI argument or a JSON key.
 */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** @returns {boolean} well-formed channel token (NOT "is a known channel") */
export function isValidChannel(channel) {
  return typeof channel === 'string' &&
    channel.length > 0 &&
    channel.length <= MAX_CHANNEL_LEN &&
    TOKEN_RE.test(channel);
}

/** @returns {boolean} well-formed source token (NOT "is a known source") */
export function isValidSource(source) {
  return typeof source === 'string' &&
    source.length > 0 &&
    source.length <= MAX_SOURCE_LEN &&
    TOKEN_RE.test(source);
}

/**
 * A name value is either a non-empty string within the length cap, or `null`.
 *
 * `null` is load-bearing: clearing a name is "a history entry whose value is
 * null", not "delete the entry". Otherwise a clear is indistinguishable from
 * "never named", and the fact that somebody deliberately removed the name is
 * unrecoverable.
 */
export function isValidNameValue(value) {
  if (value === null) return true;
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_NAME_VALUE_LEN;
}

/** Is this channel one this build has a name for? Ordering / docs only. */
export function isKnownChannel(channel) {
  return KNOWN_CHANNELS.includes(channel);
}

// ---------------------------------------------------------------------------
// Event → name change (the ONE mapping, shared by reducer and history reader)
// ---------------------------------------------------------------------------

/**
 * Event ops that carry a name change. `alias_set` and `ai_title_seen` are the
 * pre-0.3.0 spellings; `name_set` is the general form every new write uses.
 * Both legacy ops keep working forever — an events log is append-only, so the
 * 406 `ai_title_seen` rows already on disk are not rewritable and are in fact
 * where the first batch of history comes from.
 */
export const NAME_BEARING_OPS = Object.freeze([
  'name_set',
  'alias_set',
  'ai_title_seen',
]);

/**
 * Translate one event into a normalized name change, or `null` when the event
 * carries none (wrong op, malformed channel/source/value).
 *
 * This is the single definition of "which channel does this op write" — the
 * projection reducer and the `names` history reader both call it, so the
 * history a user reads can never disagree with the current value they see.
 *
 * `set_at` prefers `payload.observed_at` over `event.ts`: for harvested names
 * the observation time is the closer approximation of "when this became the
 * name", and the legacy `ai_title_seen` payloads already carry it. `event.ts`
 * is the fallback (and in practice they are milliseconds apart).
 *
 * @param {{op?: string, ts?: string, event_id?: string, payload?: object}} event
 * @returns {{channel: string, value: string|null, source: string,
 *   set_at: string|null, observed_from: string|null, op: string,
 *   event_id: string|null}|null}
 */
export function nameChangeFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const p = (event.payload && typeof event.payload === 'object') ? event.payload : {};

  let channel = null;
  let value;
  let source = null;
  let observedFrom = null;

  switch (event.op) {
    case 'name_set':
      channel = p.channel;
      value = p.value;
      // An explicit source is required to be well-formed, but a MISSING one
      // is tolerated as `harvest`: a name whose author we cannot name is
      // still a name, and dropping it would be a worse answer than recording
      // it with the weakest authorship claim.
      source = p.source === undefined || p.source === null ? SOURCE_HARVEST : p.source;
      observedFrom = typeof p.observed_from === 'string' ? p.observed_from : null;
      break;
    case 'alias_set':
      channel = CHANNEL_ALIAS;
      value = p.alias;
      source = SOURCE_HUMAN;
      break;
    case 'ai_title_seen':
      channel = CHANNEL_CC_AI_TITLE;
      value = p.ai_title;
      source = SOURCE_LLM;
      // The legacy payload's provenance field, kept under the general name.
      observedFrom = typeof p.source_transcript === 'string' ? p.source_transcript : null;
      break;
    default:
      return null;
  }

  // `undefined` means "this event says nothing about the name" (the historical
  // no-op case for `alias_set` with an empty payload). `null` means "cleared"
  // and IS a change.
  if (value === undefined) return null;
  if (!isValidChannel(channel)) return null;
  if (!isValidSource(source)) return null;
  if (!isValidNameValue(value)) return null;

  const observedAt = typeof p.observed_at === 'string' && p.observed_at.length > 0
    ? p.observed_at
    : null;

  return {
    channel,
    value,
    source,
    set_at: observedAt ?? (typeof event.ts === 'string' ? event.ts : null),
    observed_from: observedFrom,
    op: event.op,
    event_id: typeof event.event_id === 'string' ? event.event_id : null,
  };
}

/**
 * Build a canonical `name_set` payload.
 *
 * Exported so the write path and the CLI's `--dry-run` renderer produce the
 * same bytes from the same inputs — a dry run that prints a payload the real
 * write would not have produced is worse than no dry run.
 *
 * @param {{channel: string, value: string|null, source?: string,
 *   observedFrom?: string|null, observedAt?: string|null}} input
 */
export function nameSetPayload({ channel, value, source, observedFrom, observedAt } = {}) {
  const payload = {
    channel,
    value: value ?? null,
    source: source ?? SOURCE_HARVEST,
  };
  if (typeof observedFrom === 'string' && observedFrom.length > 0) {
    payload.observed_from = observedFrom;
  }
  if (typeof observedAt === 'string' && observedAt.length > 0) {
    payload.observed_at = observedAt;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Projection-side helpers (current value per channel — no history, ever)
// ---------------------------------------------------------------------------

/**
 * Apply a name change to a session record's `names[]`, in place.
 *
 * The projection stores the CURRENT value per channel and nothing else. The
 * history lives in `events.jsonl`, which is append-only and unbounded by
 * design; inlining it here would make the projection unbounded too — and the
 * projection is the file every cockpit refresh reads whole. A storage
 * decision would have quietly become a performance defect.
 *
 * `set_count` is the one concession: an O(1) counter that lets a UI say "this
 * has been renamed 4 times" without reading the event log.
 *
 * @returns {boolean} whether the record changed
 */
export function applyNameToSession(session, change) {
  if (!session || typeof session !== 'object' || !change) return false;
  const { channel, value, source, set_at: setAt, observed_from: observedFrom } = change;
  if (!isValidChannel(channel) || !isValidSource(source) || !isValidNameValue(value)) {
    return false;
  }
  if (!Array.isArray(session.names)) session.names = [];

  const idx = session.names.findIndex((n) => n && n.channel === channel);
  if (idx === -1) {
    // New channel — subject to the per-session channel cap. Existing channels
    // (idx >= 0) are never refused, so the cap can only ever turn away a
    // channel this session has not used before.
    if (session.names.length >= MAX_CHANNELS_PER_SESSION) return false;
    const entry = { channel, value, set_at: setAt ?? null, source, set_count: 1 };
    if (observedFrom) entry.observed_from = observedFrom;
    session.names.push(entry);
    return true;
  }

  const prev = session.names[idx];
  const next = {
    channel,
    value,
    set_at: setAt ?? prev.set_at ?? null,
    source,
    set_count: (typeof prev.set_count === 'number' ? prev.set_count : 0) + 1,
  };
  if (observedFrom) next.observed_from = observedFrom;
  else if (prev.observed_from) next.observed_from = prev.observed_from;
  session.names[idx] = next;
  return true;
}

/** The stored entry for one channel, or null. */
export function findNameEntry(session, channel) {
  if (!session || !Array.isArray(session.names)) return null;
  return session.names.find((n) => n && n.channel === channel) ?? null;
}

/**
 * Current value for one channel, falling back to the legacy derived field.
 *
 * The fallback is what lets this version read a projection written before
 * `names[]` existed: those records still carry `alias` / `ai_title`, and
 * without the fallback every such session would look unnamed until something
 * rewrote it — which would also make the hook's change-detection re-emit an
 * event for all 355 of them.
 */
export function currentNameValue(session, channel) {
  const entry = findNameEntry(session, channel);
  if (entry) return entry.value ?? null;
  const derived = DERIVED_FIELD_BY_CHANNEL[channel];
  if (derived && typeof session?.[derived] === 'string' && session[derived].length > 0) {
    return session[derived];
  }
  return null;
}

/**
 * Build the `{ channel: value }` map the precedence engine consumes, from a
 * session record. Includes the `first_prompt` pseudo-channel.
 */
export function nameValuesFromSession(session) {
  const values = {};
  if (!session || typeof session !== 'object') return values;
  for (const entry of Array.isArray(session.names) ? session.names : []) {
    if (!entry || !isValidChannel(entry.channel)) continue;
    values[entry.channel] = entry.value ?? null;
  }
  // Legacy mirrors for records written before `names[]` existed.
  for (const [channel, field] of Object.entries(DERIVED_FIELD_BY_CHANNEL)) {
    if (values[channel] === undefined && typeof session[field] === 'string' && session[field].length > 0) {
      values[channel] = session[field];
    }
  }
  if (typeof session.first_prompt_preview === 'string' && session.first_prompt_preview.length > 0) {
    values[CHANNEL_FIRST_PROMPT] = session.first_prompt_preview;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Precedence engine — one map in, one decision out
// ---------------------------------------------------------------------------

/**
 * Resolve the display name from a **`{ channel: value }` map**.
 *
 * The map shape is the whole point of this signature, and it is what keeps
 * two requirements from having to be traded against each other:
 *
 *  - sessions-db is the source of truth for name **history**;
 *  - the Claude Code transcript is the source of truth for the **current**
 *    value of its own channels — the database copy is only refreshed on
 *    SessionStart, so it is structurally behind.
 *
 * A consumer that just read a fresher `custom-title` off disk therefore has to
 * be able to use the shared rule WITHOUT being forced back onto the stale
 * copy. Because the input is a plain per-channel map, it simply overrides that
 * channel:
 *
 *     resolveDisplayName({ ...nameValuesFromSession(s), cc_custom_title: fresh })
 *
 * The alternative — a `resolveDisplayName(session)` that reads the record —
 * would have forced the choice between "the rule lives in one place" and
 * "consumers are not stuck with stale data". Both were required.
 *
 * Returns `{ display_name: null, display_name_channel: null }` when no channel
 * in the chain has a value. Rendering a placeholder ("Untitled abc123") is a
 * presentation decision and stays with the renderer — this function does not
 * invent a name.
 *
 * @param {Record<string, string|null|undefined>} valuesByChannel
 * @param {{ precedence?: string[] }} [opts]
 * @returns {{ display_name: string|null, display_name_channel: string|null }}
 */
export function resolveDisplayName(valuesByChannel, opts = {}) {
  const chain = Array.isArray(opts.precedence) && opts.precedence.length > 0
    ? opts.precedence
    : NAME_PRECEDENCE;
  const values = valuesByChannel && typeof valuesByChannel === 'object' ? valuesByChannel : {};
  for (const channel of chain) {
    const v = values[channel];
    // Trim-aware: a whitespace-only name is not a name. Matches what the
    // cockpit label builder already did for `alias`.
    if (typeof v === 'string' && v.trim().length > 0) {
      return { display_name: v, display_name_channel: channel };
    }
  }
  return { display_name: null, display_name_channel: null };
}

/**
 * Convenience wrapper: resolve straight from a session record, with optional
 * per-channel overrides for consumers holding fresher observations.
 *
 * @param {object} session
 * @param {{ overrides?: Record<string, string|null>, precedence?: string[] }} [opts]
 */
export function displayNameForSession(session, opts = {}) {
  const values = nameValuesFromSession(session);
  if (opts.overrides && typeof opts.overrides === 'object') {
    for (const [channel, value] of Object.entries(opts.overrides)) {
      if (!isValidChannel(channel)) continue;
      values[channel] = value;
    }
  }
  return resolveDisplayName(values, { precedence: opts.precedence });
}

// ---------------------------------------------------------------------------
// History — derived by replaying events, never stored in the projection
// ---------------------------------------------------------------------------

/**
 * Fold an event array into per-session, per-channel name history.
 *
 * Entries are in event order (oldest first), and the LAST entry of a channel
 * is that channel's current value — which is how a reader distinguishes "you
 * matched the name it has now" from "you matched a name it used to have".
 *
 * @param {Array<object>} events
 * @param {{ stableId?: string }} [opts] restrict to one session (cheaper)
 * @returns {Map<string, Map<string, Array<object>>>} stable_id → channel → entries
 */
export function foldNameHistory(events, opts = {}) {
  const out = new Map();
  if (!Array.isArray(events)) return out;
  const only = typeof opts.stableId === 'string' && opts.stableId.length > 0
    ? opts.stableId
    : null;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const stableId = event.stable_id;
    if (typeof stableId !== 'string' || stableId.length === 0) continue;
    if (only && stableId !== only) continue;

    // A tombstone erases the record; its name history goes with it, or
    // `names <id>` would keep answering for a session `find` says is gone.
    // Replaying the log twice must land in the same place, and this is the
    // same reading the projection reducer takes.
    if (event.op === 'session_prune') {
      out.delete(stableId);
      continue;
    }

    const change = nameChangeFromEvent(event);
    if (!change) continue;
    if (!out.has(stableId)) out.set(stableId, new Map());
    const byChannel = out.get(stableId);
    if (!byChannel.has(change.channel)) byChannel.set(change.channel, []);
    byChannel.get(change.channel).push(change);
  }
  return out;
}

/**
 * Split one channel's history into `{ current, history }` — the last entry is
 * current, everything before it is history.
 *
 * A value can legitimately appear in both (renamed away and back), and the
 * split reports it in both: it IS the current name and it WAS an older one.
 */
export function splitChannelHistory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return { current: null, history: [] };
  return { current: list[list.length - 1], history: list.slice(0, -1) };
}

/**
 * Order channels for display: the ones in `KNOWN_CHANNELS` first, in registry
 * order, then unknown ones alphabetically. Unknown channels are shown, never
 * hidden — that is the whole contract behind an open channel set.
 */
export function sortChannels(channels) {
  const known = [...KNOWN_CHANNELS];
  return [...channels].sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
