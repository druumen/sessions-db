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
 * a general-purpose payload smuggling lane, `value` is length-capped so a
 * runaway writer cannot inflate the projection and passed through
 * `sanitizeNameValue` so it cannot drive the terminal it is printed on, and
 * `observed_from` is capped for the same reason `value` is. Unknown ≠
 * invalid: the first is preserved, the second is refused.
 *
 * ## Setting a name to what it already is, is not a change
 *
 * Everything here has to survive being applied twice. The projection is a
 * fold of an append-only log, so the same event legitimately reaches the
 * reducer more than once — a cold cache is rebuilt from a log that already
 * contains the event being applied, two hooks race the same observation, or a
 * user simply runs `alias <id> "X"` twice. Every other reducer in the
 * codebase is last-write-wins and therefore idempotent for free; the name
 * entries carry a counter, which is not.
 *
 * So the rule is enforced at the one place a name enters the model:
 * `applyNameToSession` treats an incoming change whose `(value, source)`
 * already match the stored entry as a no-op, and `foldNameHistory` drops the
 * same event from history for the same reason. Without that, a repeat costs a
 * phantom rename that `rebuild` cannot undo — the duplicate is in the log
 * forever, so the wrong answer is reproducible rather than transient.
 *
 * `set_at` is deliberately NOT part of that comparison. Two identical writes
 * differ only in when they happened, and "when did somebody re-assert the
 * same name" is not what `set_count` counts.
 *
 * This module is pure (no IO, no clock, no randomness).
 */

import { sanitizeNameValue } from './sanitize.mjs';

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
 * Cap on `observed_from`. The module documents name entries as bounded; that
 * claim did not cover this field, which holds a caller-supplied provenance
 * string (a transcript path today, a tool name tomorrow). An event is refused
 * outright above `MAX_EVENT_BYTES` (4 KiB), so an unbounded provenance string
 * could fail the whole write — and the failure would be reported as an
 * oversized event, never mentioning that a name was lost. Over-long
 * provenance is dropped instead: the name is the payload, the path is the
 * footnote.
 *
 * 512 covers a deep `~/.claude/projects/<workspace-hash>/<uuid>.jsonl` with
 * room to spare (measured ~150 chars on the reference machine).
 */
export const MAX_OBSERVED_FROM_LEN = 512;

/**
 * Version of the name model as materialised into the projection.
 *
 * The projection is a cache, and a cache written by a build that did not have
 * this model cannot be repaired in place: `set_count` and `observed_from` are
 * folds of the event log, so a record materialised from the legacy top-level
 * fields alone would claim one set for a channel the log says was set three
 * times. Stamping the version lets `loadProjection` notice that the cache
 * predates the model and rebuild it from the log — once, and then never
 * again, because the rebuilt file carries the stamp.
 *
 * Bump this whenever a change makes previously-written `names[]` blocks
 * wrong rather than merely older. The cost of a bump is one rebuild per
 * database (18 ms over the 2018-event reference log), which is why it is
 * preferable to shipping a schema whose derived fields quietly disagree with
 * the log they came from.
 */
export const NAMES_MODEL_VERSION = 1;

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
 * A name value is either a non-empty string within the length cap that is
 * already safe to print, or `null`.
 *
 * `null` is load-bearing: clearing a name is "a history entry whose value is
 * null", not "delete the entry". Otherwise a clear is indistinguishable from
 * "never named", and the fact that somebody deliberately removed the name is
 * unrecoverable.
 *
 * "Already safe" is defined as a fixed point of `sanitizeNameValue`: a value
 * carrying an ANSI escape, a NUL, a newline or a bidi override is refused
 * rather than stored. Both entry points into the model (`nameSetPayload` on
 * the write side, `nameChangeFromEvent` on the read side) sanitise before
 * they get here, so in normal operation this predicate only ever sees clean
 * input — which is exactly the point. It turns "we sanitise on the way in"
 * from a convention into an invariant something can fail on, and it is what
 * stops a caller reaching `applyNameToSession` directly with a value that
 * would drive the terminal it is printed on.
 */
export function isValidNameValue(value) {
  if (value === null) return true;
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_NAME_VALUE_LEN &&
    sanitizeNameValue(value) === value;
}

/**
 * ISO 8601 instant, of the shape every writer in this package emits
 * (`new Date().toISOString()`) plus the offset forms `Iso8601` documents as
 * accepted on input.
 *
 * Needed because `set_at` is typed `Iso8601|null` and was in practice "any
 * non-empty string the caller passed as `observed_at`". A name whose
 * `set_at` is `"not-a-date"` sorts by nothing in the history view, prints
 * verbatim in `search`, and lies to every consumer that trusts the declared
 * type. The regex pins the shape and `Date.parse` rejects the shapes that
 * look right but are not real instants (month 13, day 32).
 */
const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** @returns {boolean} well-formed ISO 8601 instant */
export function isIso8601(value) {
  return typeof value === 'string' &&
    ISO8601_RE.test(value) &&
    Number.isFinite(Date.parse(value));
}

/**
 * Provenance string, or null. Same charset freedom as a path needs, bounded
 * by `MAX_OBSERVED_FROM_LEN` and sanitised — it is rendered by `names --json`
 * consumers and has no more claim to trust than the value it accompanies.
 */
export function normalizeObservedFrom(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const clean = sanitizeNameValue(value);
  if (clean.length === 0 || clean.length > MAX_OBSERVED_FROM_LEN) return null;
  return clean;
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
      observedFrom = normalizeObservedFrom(p.observed_from);
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
      observedFrom = normalizeObservedFrom(p.source_transcript);
      break;
    default:
      return null;
  }

  // `undefined` means "this event says nothing about the name" (the historical
  // no-op case for `alias_set` with an empty payload). `null` means "cleared"
  // and IS a change.
  if (value === undefined) return null;
  // Sanitise on the way OUT of the log as well as on the way in. The log is
  // append-only and older builds wrote whatever the transcript held, so the
  // write-side sanitiser cannot be the only one — a value that predates it
  // still has to be safe by the time it reaches a terminal.
  if (typeof value === 'string') value = sanitizeNameValue(value);
  if (!isValidChannel(channel)) return null;
  if (!isValidSource(source)) return null;
  if (!isValidNameValue(value)) return null;

  // A malformed `observed_at` falls back to the event ts rather than failing
  // the whole change: the event happened, we just do not believe its opinion
  // about when. Dropping the name over a bad timestamp would lose more than
  // it protects.
  const observedAt = isIso8601(p.observed_at) ? p.observed_at : null;

  return {
    channel,
    value,
    source,
    set_at: observedAt ?? (isIso8601(event.ts) ? event.ts : null),
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
  // Sanitised here, at the write side's single choke point, so what lands in
  // `events.jsonl` is already clean. The read side sanitises again for the
  // rows written before this existed; the two agree because the sanitiser is
  // idempotent.
  const clean = typeof value === 'string' ? sanitizeNameValue(value) : null;
  const payload = {
    channel,
    value: clean === null || clean.length === 0 ? null : clean,
    source: source ?? SOURCE_HARVEST,
  };
  const provenance = normalizeObservedFrom(observedFrom);
  if (provenance) payload.observed_from = provenance;
  // An unparseable `observed_at` is dropped rather than written through. The
  // field is typed `Iso8601|null`; storing "not-a-date" in it makes the type
  // a lie for every consumer downstream, and the fallback (the event ts) is
  // both correct and already implemented.
  if (isIso8601(observedAt)) payload.observed_at = observedAt;
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
 * has been renamed 4 times" without reading the event log. It is also the
 * only field in the whole projection that counts rather than overwrites,
 * which is why the no-op check below is not an optimisation — it is what
 * keeps this reducer idempotent like every other one. See the module header.
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
  // Naming a channel what it is already called changes nothing — not the
  // value, not the count, not the provenance. Leaving the entry byte-identical
  // (rather than rewriting it with a fresh `set_at`) is what makes this
  // checkable: a caller can assert "the record did not change" from the
  // `false` return alone.
  if (isSameNaming(prev, change)) return false;

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

/**
 * Do these two describe the same naming?
 *
 * Compared on `value` and `source` only. `value` because that is the name;
 * `source` because authorship is a documented axis of the model — the same
 * string attested by a person is a different fact from the same string
 * scraped by a harvester, and collapsing them would lose the one question
 * the axis exists to answer. `set_at` and `observed_from` are excluded:
 * they say when and where the name was seen, not what it is, and including
 * them would make every re-observation a rename again.
 *
 * Both sides are already-normalised shapes (`{value, source}`), so the same
 * predicate serves the projection reducer and the history fold — the two must
 * agree, or `names` reports a superseded value that is still current.
 */
export function isSameNaming(a, b) {
  if (!a || !b) return false;
  return (a.value ?? null) === (b.value ?? null) && a.source === b.source;
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
 * Has ANY namer ever spoken about this session?
 *
 * Channel-agnostic on purpose. The channel set is open, so an enumerated
 * "did somebody set an alias or a title" check goes stale the moment a new
 * namer ships — and the consumer of this question is `prune`, where going
 * stale means deleting a record whose only name came through a channel the
 * pruner had not heard of.
 *
 * A cleared entry (`value: null`) counts. The entry exists precisely because
 * somebody named the session and then unnamed it; that is a person having
 * touched the record, which is the thing being tested for.
 */
export function hasAnyName(session) {
  if (!session || !Array.isArray(session.names)) return false;
  return session.names.some((n) => n && isValidChannel(n.channel));
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
  // Sanitised on the way into the display map, not on the stored field.
  // `first_prompt_preview` is the last resort of the display chain, so it
  // reaches a terminal like any other name — but unlike the others it holds
  // raw user input, and `sanitizeFirstPrompt` (which strips harness wrappers,
  // not control bytes) leaves newlines and escapes in place. Rewriting the
  // stored field is not an option: `first_human_prompt_v1` hashes it, and
  // changing what is hashed re-keys every fingerprint already on disk and
  // breaks identity reconciliation. Cleaning the DISPLAY value costs nothing
  // and touches neither the field nor the hash.
  const preview = sanitizeNameValue(session.first_prompt_preview ?? '');
  if (preview.length > 0) values[CHANNEL_FIRST_PROMPT] = preview;
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
 * An event that re-asserts the value a channel already holds is skipped, for
 * the same reason `applyNameToSession` treats it as a no-op: it is not a
 * rename. Skipping it here is not cosmetic — without it, running
 * `alias <id> "X"` twice makes `names` report "1 superseded" and list the
 * live value under both `current` and `history`, i.e. exactly the state the
 * `kind` flag exists to rule out.
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
    const entries = byChannel.get(change.channel);
    // Same naming as the one this channel currently holds ⇒ nothing changed,
    // so there is nothing to record. Only the immediately preceding entry is
    // compared: renamed-away-and-back is two real renames and both stay.
    if (entries.length > 0 && isSameNaming(entries[entries.length - 1], change)) continue;
    entries.push(change);
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
