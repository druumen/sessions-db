/**
 * Identity of a link. `repository` may be null (an older Claude Code, or a
 * record we could not normalize) — those group under the bare number, which
 * is the best identity available for them.
 *
 * @param {{repository: (string|null), number: number}} link
 * @returns {string}
 */
export function prLinkKey(link: {
    repository: (string | null);
    number: number;
}): string;
/**
 * Human form: `druumen/cn/drummen#722`, or `#722` when the repository is
 * unknown. This is what CLI output and search snippets print.
 *
 * @param {{repository: (string|null), number: number}} link
 * @returns {string}
 */
export function formatPrLink(link: {
    repository: (string | null);
    number: number;
}): string;
/**
 * Build the `pr_link_seen` payload. Normalizes at the write side so what
 * lands in `events.jsonl` is already clean; the read side normalizes again
 * for rows written before this existed, and the two agree because every
 * normalizer here is idempotent.
 *
 * @returns {object|null} null when the record carries no usable number —
 *   there is nothing to record about a link you cannot address.
 */
export function prLinkSeenPayload({ repository, number, url, observedAt, observedFrom }?: {}): object | null;
/**
 * Read a `pr_link_seen` event back into a normalized link.
 *
 * @param {object} event
 * @returns {{repository: (string|null), number: number, url: (string|null),
 *   first_seen_at: (string|null), observed_from: (string|null)}|null}
 */
export function prLinkFromEvent(event: object): {
    repository: (string | null);
    number: number;
    url: (string | null);
    first_seen_at: (string | null);
    observed_from: (string | null);
} | null;
/**
 * Merge a link into a session's `pr_links[]`.
 *
 * Union semantics, earliest-wins on the timestamp: the same MR is re-emitted
 * on every harvest, and "when did this session open it" is the question the
 * field answers. A later observation may still FILL a field that was null
 * (an older record without the repository or url), because gaining a fact is
 * not the same as overwriting one.
 *
 * @param {object} session
 * @param {object} link normalized, from `prLinkFromEvent`
 * @returns {boolean} true when the session changed
 */
export function applyPrLinkToSession(session: object, link: object): boolean;
export function sessionMatchesPrQuery(session: any, query: any): any;
/** Bounds. Same reasoning as the name model: a record must not become a
 * general-purpose payload lane, and a value that is printed on a terminal
 * must not be able to drive it. */
export const MAX_PR_REPOSITORY_LEN: 200;
export const MAX_PR_URL_LEN: 1024;
/**
 * A forge number is small; anything larger is a parser error, not an MR.
 *
 * Seven digits, and the search predicate's `\d{1,7}` is derived from this
 * constant rather than written next to it — they were written separately once
 * and disagreed by exactly one value (10000000 stored fine and was
 * unsearchable), which is the whole failure mode of two hand-kept bounds.
 */
export const MAX_PR_NUMBER: 9999999;
export const MAX_PR_NUMBER_DIGITS: number;
/** Cap per session, mirroring MAX_CHANNELS_PER_SESSION. Sessions that open
 * more MRs than this exist in theory; the cap keeps one runaway writer from
 * inflating the projection every consumer reads whole. */
export const MAX_PR_LINKS_PER_SESSION: 64;
