/** @returns {boolean} well-formed channel token (NOT "is a known channel") */
export function isValidChannel(channel: any): boolean;
/** @returns {boolean} well-formed source token (NOT "is a known source") */
export function isValidSource(source: any): boolean;
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
export function isValidNameValue(value: any): boolean;
/** @returns {boolean} well-formed ISO 8601 instant */
export function isIso8601(value: any): boolean;
/**
 * Provenance string, or null. Same charset freedom as a path needs, bounded
 * by `MAX_OBSERVED_FROM_LEN` and sanitised — it is rendered by `names --json`
 * consumers and has no more claim to trust than the value it accompanies.
 */
export function normalizeObservedFrom(value: any): string;
/** Is this channel one this build has a name for? Ordering / docs only. */
export function isKnownChannel(channel: any): boolean;
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
export function nameChangeFromEvent(event: {
    op?: string;
    ts?: string;
    event_id?: string;
    payload?: object;
}): {
    channel: string;
    value: string | null;
    source: string;
    set_at: string | null;
    observed_from: string | null;
    op: string;
    event_id: string | null;
} | null;
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
export function nameSetPayload({ channel, value, source, observedFrom, observedAt }?: {
    channel: string;
    value: string | null;
    source?: string;
    observedFrom?: string | null;
    observedAt?: string | null;
}): {
    channel: string;
    value: string;
    source: string;
};
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
export function applyNameToSession(session: any, change: any): boolean;
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
 *
 * ## Known boundary: comparison is by code units, not by Unicode equivalence
 *
 * "normalised" above means *shape*, not *Unicode*. `é` written NFC (U+00E9)
 * and `é` written NFD (U+0065 U+0301) look identical in every terminal and
 * compare unequal here, so a macOS filesystem or an IME that hands over the
 * decomposed form re-records a name that visibly did not change — one extra
 * `set_count`, one extra history row, same displayed string.
 *
 * Left alone deliberately, for now. NFC-folding at this comparison only would
 * make the predicate disagree with the value actually stored (which is not
 * folded), so the honest fix normalises on the WRITE path — and that changes
 * the bytes going into `events.jsonl`, which is an append-only log whose
 * existing rows would then compare unequal to everything written after. That
 * is a migration, not a one-line change, and the failure mode it prevents is
 * a duplicate history row rather than a wrong name.
 *
 * The write-side sanitiser is the place to do it if it is ever worth doing:
 * `sanitizeFirstPrompt` already NFKC-normalises, so the precedent and the
 * placement both exist.
 */
export function isSameNaming(a: any, b: any): boolean;
/** The stored entry for one channel, or null. */
export function findNameEntry(session: any, channel: any): any;
/**
 * Current value for one channel, falling back to the legacy derived field.
 *
 * The fallback is what lets this version read a projection written before
 * `names[]` existed: those records still carry `alias` / `ai_title`, and
 * without the fallback every such session would look unnamed until something
 * rewrote it — which would also make the hook's change-detection re-emit an
 * event for all 355 of them.
 *
 * The fallback is sanitised for the same reason it exists. Its consumer in
 * this repo is the harvester's "has this channel changed?" check, and the
 * value it is compared against was cleaned on the way in. A legacy mirror holding raw
 * bytes would therefore never compare equal to the cleaned observation of the
 * same name, and the suppression this fallback was written to provide would
 * invert into an event on every single SessionStart, forever.
 */
export function currentNameValue(session: any, channel: any): any;
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
export function hasAnyName(session: any): any;
/**
 * Build the `{ channel: value }` map the precedence engine consumes, from a
 * session record. Includes the `first_prompt` pseudo-channel.
 */
export function nameValuesFromSession(session: any): {};
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
export function resolveDisplayName(valuesByChannel: Record<string, string | null | undefined>, opts?: {
    precedence?: string[];
}): {
    display_name: string | null;
    display_name_channel: string | null;
};
/**
 * Convenience wrapper: resolve straight from a session record, with optional
 * per-channel overrides for consumers holding fresher observations.
 *
 * @param {object} session
 * @param {{ overrides?: Record<string, string|null>, precedence?: string[] }} [opts]
 */
export function displayNameForSession(session: object, opts?: {
    overrides?: Record<string, string | null>;
    precedence?: string[];
}): {
    display_name: string | null;
    display_name_channel: string | null;
};
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
export function foldNameHistory(events: Array<object>, opts?: {
    stableId?: string;
}): Map<string, Map<string, Array<object>>>;
/**
 * Split one channel's history into `{ current, history }` — the last entry is
 * current, everything before it is history.
 *
 * A value can legitimately appear in both (renamed away and back), and the
 * split reports it in both: it IS the current name and it WAS an older one.
 */
export function splitChannelHistory(entries: any): {
    current: any;
    history: any[];
};
/**
 * Order channels for display: the ones in `KNOWN_CHANNELS` first, in registry
 * order, then unknown ones alphabetically. Unknown channels are shown, never
 * hidden — that is the whole contract behind an open channel set.
 */
export function sortChannels(channels: any): any[];
/** Channels this version knows about by name. Open set — see module docs. */
export const CHANNEL_ALIAS: "alias";
export const CHANNEL_CC_CUSTOM_TITLE: "cc_custom_title";
export const CHANNEL_CC_AI_TITLE: "cc_ai_title";
export const CHANNEL_AGENT_NAME: "agent_name";
/**
 * Pseudo-channel for `first_prompt_preview`. Never stored in `names[]` —
 * see module docs.
 */
export const CHANNEL_FIRST_PROMPT: "first_prompt";
/** Authorship of a name value. Open set, same rules as channels. */
export const SOURCE_HUMAN: "human";
export const SOURCE_LLM: "llm";
export const SOURCE_HARVEST: "harvest";
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
export const NAME_PRECEDENCE: readonly string[];
/**
 * Channels this build recognises, in a stable display order. Used ONLY for
 * ordering / documentation — never to filter what gets stored.
 */
export const KNOWN_CHANNELS: readonly string[];
/**
 * Channels whose current value is ALSO mirrored onto a legacy top-level
 * field, kept so existing consumers (`find`, `search`, cockpit view-model)
 * survive this schema change untouched. The mirrors are derived views of
 * `names[]`, not a second source of truth; removal is a later, separate
 * migration once every consumer reads `names[]`.
 */
export const DERIVED_FIELD_BY_CHANNEL: Readonly<{
    alias: "alias";
    cc_ai_title: "ai_title";
}>;
export const MAX_CHANNEL_LEN: 64;
export const MAX_SOURCE_LEN: 32;
/**
 * Cap on a stored name. The longest `ai_title` on the reference database is
 * 62 characters, so 512 leaves two orders of magnitude of headroom while
 * still bounding what one session can push into the projection.
 */
export const MAX_NAME_VALUE_LEN: 512;
/**
 * Cap on DISTINCT channels per session. The flatness invariant is
 * "projection size is O(channels), not O(renames)"; without a ceiling on
 * channels that is O(unbounded) again, just more slowly. Existing channels
 * keep updating past the cap — only brand-new ones are refused — so a real
 * namer can never be starved by junk that arrived first.
 */
export const MAX_CHANNELS_PER_SESSION: 32;
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
export const MAX_OBSERVED_FROM_LEN: 512;
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
export const NAMES_MODEL_VERSION: 1;
/**
 * Event ops that carry a name change. `alias_set` and `ai_title_seen` are the
 * pre-0.3.0 spellings; `name_set` is the general form every new write uses.
 * Both legacy ops keep working forever — an events log is append-only, so the
 * 406 `ai_title_seen` rows already on disk are not rewritable and are in fact
 * where the first batch of history comes from.
 */
export const NAME_BEARING_OPS: readonly string[];
