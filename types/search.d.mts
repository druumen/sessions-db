/**
 * Labelled metadata strings a session exposes to search. Skips empty values.
 * @returns {Array<[string, string]>} [label, value] pairs
 */
export function sessionMetadataFields(session: any): Array<[string, string]>;
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
export function matchCurrentNames(session: any, query: any): Array<{
    channel: string;
    value: string;
    set_at: string | null;
    source: string | null;
    kind: "current";
}>;
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
export function matchNameHistory(byChannel: any, query: any): Array<{
    channel: string;
    value: string;
    set_at: string | null;
    source: string;
    kind: "history";
}>;
/**
 * Case-insensitive substring match across a session's metadata fields.
 * @returns {string[]} distinct field labels that matched ([] = no match)
 */
export function matchSessionMetadata(session: any, query: any): string[];
/**
 * Extract searchable text from one transcript JSONL record. Only user/assistant
 * messages carry conversation text; `content` is either a string or an array of
 * blocks ({ type, text }). Returns '' for anything else (tool_use, thinking,
 * queue-operation, attachment, ...).
 */
export function recordText(record: any): string;
/**
 * Return a whitespace-collapsed snippet around the first case-insensitive
 * occurrence of `query` in `text`, with `ctx` chars of context each side and
 * ellipses when truncated. Null if not found.
 */
export function extractSnippet(text: any, query: any, ctx?: number): string;
