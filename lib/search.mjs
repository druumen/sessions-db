/**
 * Pure search helpers for `sessions-db search`. No IO — unit tested.
 *
 * Two tiers (the CLI wires both):
 *   - metadata: substring match across projection session fields (fast).
 *   - content : substring match across transcript message text (slow; the CLI
 *     does the file IO and calls `recordText` + `extractSnippet` here).
 *
 * Designed for AI-tool consumption: an agent runs `sessions-db search "<q>"
 * --json` over Bash to locate the past session that discussed something,
 * instead of a human digging through the cockpit list.
 *
 * Names are indexed on BOTH tiers, but not by default on both:
 *   - the current value of every naming channel is metadata (fast, projection
 *     only) — this is what closes the hole where the title you actually see in
 *     Claude Code was the one thing you could not search for;
 *   - names a session USED to have are opt-in (`--include-history`, wired in
 *     cli/search.mjs) because reading them means folding the event log, the
 *     same cost shape as `--content` scanning transcripts. Keeping the default
 *     path projection-only is also what keeps "why did this match?" trivially
 *     answerable without a flag.
 */
import { sessionMatchesPrQuery } from './pr-links.mjs';
import {
  CHANNEL_ALIAS,
  CHANNEL_FIRST_PROMPT,
  findNameEntry,
  nameValuesFromSession,
  sortChannels,
  splitChannelHistory,
} from './names.mjs';
import { sanitizeNameValue } from './sanitize.mjs';

/**
 * The session's current names, one entry per DISTINCT value.
 *
 * Channels are visited in registry order (`sortChannels`) and the first one
 * holding a given string wins it. That is not cosmetic dedup: `agent_name` is
 * documented as a mirror of `ai_title` — on the reference machine every
 * session carrying an agent badge had the two byte-identical — so without
 * this, every such session answers a search with two `matched_in` labels and
 * two `name_hits` for one name, and a caller counting hits counts the same
 * name twice. Registry order also makes the surviving label the meaningful
 * one (`cc_ai_title` over `agent_name`) rather than whichever the object key
 * order happened to yield.
 *
 * @returns {Array<[string, string]>} [channel, value] pairs, deduped by value
 */
function distinctCurrentNames(session) {
  const values = nameValuesFromSession(session);
  const seen = new Set();
  const out = [];
  for (const channel of sortChannels(Object.keys(values))) {
    const value = values[channel];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push([channel, value]);
  }
  return out;
}

/**
 * Labelled metadata strings a session exposes to search. Skips empty values.
 *
 * The two name-bearing fields go through `sanitizeNameValue` first. These are
 * the raw legacy mirrors — `alias` as `alias_set` wrote it, `first_prompt_preview`
 * as the user typed it — and everything else that reads them for display
 * (`nameValuesFromSession`, and through it `find`'s label and this module's
 * `matchCurrentNames`) cleans them. Searching the raw bytes while showing the
 * cleaned ones produces a hit the caller cannot account for: the query matched
 * an escape sequence that appears nowhere in the row they are looking at. The
 * text searched has to be the text shown.
 *
 * @returns {Array<[string, string]>} [label, value] pairs
 */
export function sessionMetadataFields(session) {
  const fields = [];
  const push = (label, val) => {
    if (typeof val === 'string' && val.length > 0) fields.push([label, val]);
  };
  push('stable_id', session.stable_id);
  push('alias', sanitizeNameValue(session.alias ?? ''));
  push('first_prompt', sanitizeNameValue(session.first_prompt_preview ?? ''));
  push('branch', session.branch_current);
  push('branch', session.branch_at_start);
  push('cwd', session.cwd);
  push('worktree', session.worktree_realpath);
  push('worktree', session.worktree_path_observed);
  for (const t of Array.isArray(session.tasks) ? session.tasks : []) push('task', t);
  for (const p of Array.isArray(session.projects) ? session.projects : []) push('project', p);
  for (const id of Array.isArray(session.claude_session_ids) ? session.claude_session_ids : []) {
    push('claude_session_id', id);
  }
  // Current value of every naming channel, labelled `name:<channel>` so a hit
  // says which surface named it. `nameValuesFromSession` falls back to the
  // legacy top-level fields, so a projection written before `names[]` existed
  // is searched just as well.
  //
  // Two channels are skipped because they are already pushed above under their
  // historical labels, and duplicating them would only make `matched_in` noisy
  // for the two oldest consumers of that field.
  for (const [channel, value] of distinctCurrentNames(session)) {
    if (channel === CHANNEL_ALIAS || channel === CHANNEL_FIRST_PROMPT) continue;
    push(`name:${channel}`, value);
  }
  return fields;
}

/**
 * Case-insensitive substring match against a session's CURRENT names, one
 * channel at a time.
 *
 * The metadata tier already reports these as `name:<channel>` labels; this
 * returns the matched values themselves so a machine consumer does not have to
 * re-derive which string caused the hit. `first_prompt` is excluded: it is the
 * display fallback, not a name anybody gave the session, and it is already
 * reported under its own historical label.
 *
 * @returns {Array<{channel: string, value: string, set_at: string|null,
 *   source: string|null, kind: 'current'}>}
 */
export function matchCurrentNames(session, query) {
  if (!session || typeof query !== 'string' || query.length === 0) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const [channel, value] of distinctCurrentNames(session)) {
    if (channel === CHANNEL_FIRST_PROMPT) continue;
    if (!value.toLowerCase().includes(q)) continue;
    const entry = findNameEntry(session, channel);
    out.push({
      channel,
      value,
      set_at: entry?.set_at ?? null,
      source: entry?.source ?? null,
      kind: 'current',
    });
  }
  return out;
}

/**
 * Case-insensitive substring match against the names a session USED to have.
 *
 * Input is one session's `channel → entries[]` map from
 * `foldNameHistory`; the last entry per channel is the current value and is
 * excluded here — it is already covered by the metadata tier, and the whole
 * point of reporting these separately is that the caller can tell "this is
 * what it is called" from "this is what it was called".
 *
 * A value that was used, dropped, and later restored legitimately matches on
 * both tiers; that is not a bug, it is both facts being true.
 *
 * @returns {Array<{channel: string, value: string, set_at: string|null,
 *   source: string, kind: 'history'}>}
 */
export function matchNameHistory(byChannel, query) {
  if (!byChannel || typeof query !== 'string' || query.length === 0) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const [channel, entries] of byChannel) {
    const { history } = splitChannelHistory(entries);
    for (const entry of history) {
      if (typeof entry.value !== 'string') continue;
      if (!entry.value.toLowerCase().includes(q)) continue;
      out.push({
        channel,
        value: entry.value,
        set_at: entry.set_at ?? null,
        source: entry.source,
        kind: 'history',
      });
    }
  }
  return out;
}

/**
 * Case-insensitive substring match across a session's metadata fields.
 * @returns {string[]} distinct field labels that matched ([] = no match)
 */
export function matchSessionMetadata(session, query) {
  if (!session || typeof session !== 'object' || typeof query !== 'string' || query.length === 0) {
    return [];
  }
  const q = query.toLowerCase();
  const hits = new Set();
  for (const [label, val] of sessionMetadataFields(session)) {
    if (val.toLowerCase().includes(q)) hits.add(label);
  }
  // Merge requests are matched by their own predicate rather than by pushing
  // them into `sessionMetadataFields`, because substring is the wrong rule for
  // a number: `722` must find `#722`, and `72` must NOT — while the url and
  // repository halves stay substring-matched like every other field. Keeping
  // the links out of the metadata tier is what makes that split possible;
  // pushing the url in would have re-admitted `72` through the back door.
  if (sessionMatchesPrQuery(session, query)) hits.add('pr');
  return [...hits];
}

/**
 * Extract searchable text from one transcript JSONL record. Only user/assistant
 * messages carry conversation text; `content` is either a string or an array of
 * blocks ({ type, text }). Returns '' for anything else (tool_use, thinking,
 * queue-operation, attachment, ...).
 */
export function recordText(record) {
  if (!record || (record.type !== 'user' && record.type !== 'assistant')) return '';
  const content = record.message && record.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .filter((t) => t.length > 0)
      .join(' ');
  }
  return '';
}

/**
 * Return a whitespace-collapsed snippet around the first case-insensitive
 * occurrence of `query` in `text`, with `ctx` chars of context each side and
 * ellipses when truncated. Null if not found.
 */
export function extractSnippet(text, query, ctx = 60) {
  if (typeof text !== 'string' || text.length === 0 || typeof query !== 'string' || query.length === 0) {
    return null;
  }
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - ctx);
  const end = Math.min(text.length, idx + query.length + ctx);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return (prefix + text.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();
}
