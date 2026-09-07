/**
 * Merge-request / pull-request links a session opened.
 *
 * ## What this models, and what it deliberately does not
 *
 * Claude Code writes one record per MR a session opens, re-emitting it as the
 * conversation goes on:
 *
 *   { "type": "pr-link", "prNumber": 722,
 *     "prUrl": "https://gitlab.tinfant.org/druumen/cn/drummen/-/merge_requests/722",
 *     "prRepository": "druumen/cn/drummen", "timestamp": "2026-09-07T16:04:20.294Z" }
 *
 * Until 0.4.0 sessions-db did not model it at all, so "which MR did this
 * session open" was answerable only by reading the transcript by hand — while
 * the reverse question (`scripts/mr-session-lookup.mjs` in the monorepo, which
 * reads the `Session:` UUID out of an MR description) had a tool. The two
 * directions are independent evidence and both are worth keeping: the
 * description line is written by whoever opened the MR and is missing on every
 * MR that predates that convention; this record is written by Claude Code
 * itself and cannot be forgotten.
 *
 * A LIST, not a field: a session opens more than one MR (this machine has one
 * carrying #672 and #722). Identity is `(repository, number)` — the number
 * alone is ambiguous the moment a workspace touches two repos.
 *
 * Deliberately NOT modelled here: MR state (open/merged/closed) and title.
 * Those change after the transcript was written, so anything we stored would
 * be a snapshot that silently goes stale — ask the forge instead, with the
 * number this record gives you.
 */

import { isIso8601, normalizeObservedFrom } from './names.mjs';
import { sanitizeNameValue } from './sanitize.mjs';

/** Bounds. Same reasoning as the name model: a record must not become a
 * general-purpose payload lane, and a value that is printed on a terminal
 * must not be able to drive it. */
export const MAX_PR_REPOSITORY_LEN = 200;
export const MAX_PR_URL_LEN = 1024;
/**
 * A forge number is small; anything larger is a parser error, not an MR.
 *
 * Seven digits, and the search predicate's `\d{1,7}` is derived from this
 * constant rather than written next to it — they were written separately once
 * and disagreed by exactly one value (10000000 stored fine and was
 * unsearchable), which is the whole failure mode of two hand-kept bounds.
 */
export const MAX_PR_NUMBER = 9_999_999;
export const MAX_PR_NUMBER_DIGITS = String(MAX_PR_NUMBER).length;
/** Cap per session, mirroring MAX_CHANNELS_PER_SESSION. Sessions that open
 * more MRs than this exist in theory; the cap keeps one runaway writer from
 * inflating the projection every consumer reads whole. */
export const MAX_PR_LINKS_PER_SESSION = 64;

/**
 * Only http(s) survives. A `javascript:` or `data:` URL in a field that
 * cockpit renders as a link is the one shape of this record that could do
 * something; dropping the url while KEEPING number + repository means a
 * hostile record degrades to a less useful entry rather than to a hole.
 */
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const clean = sanitizeNameValue(raw);
  if (clean.length === 0 || clean.length > MAX_PR_URL_LEN) return null;
  if (!/^https?:\/\/\S+$/.test(clean)) return null;
  return clean;
}

function normalizeRepository(raw) {
  if (typeof raw !== 'string') return null;
  const clean = sanitizeNameValue(raw);
  if (clean.length === 0 || clean.length > MAX_PR_REPOSITORY_LEN) return null;
  // Forge paths are `group/subgroup/project`. Anything with whitespace or a
  // control byte already lost it in sanitizeNameValue; this rejects the rest.
  if (!/^[A-Za-z0-9._~\-]+(?:\/[A-Za-z0-9._~\-]+)*$/.test(clean)) return null;
  return clean;
}

function normalizeNumber(raw) {
  if (!Number.isInteger(raw)) return null;
  if (raw <= 0 || raw > MAX_PR_NUMBER) return null;
  return raw;
}

/**
 * Identity of a link. `repository` may be null (an older Claude Code, or a
 * record we could not normalize) — those group under the bare number, which
 * is the best identity available for them.
 *
 * @param {{repository: (string|null), number: number}} link
 * @returns {string}
 */
export function prLinkKey(link) {
  return `${link.repository ?? ''}#${link.number}`;
}

/**
 * Human form: `druumen/cn/drummen#722`, or `#722` when the repository is
 * unknown. This is what CLI output and search snippets print.
 *
 * @param {{repository: (string|null), number: number}} link
 * @returns {string}
 */
export function formatPrLink(link) {
  return link.repository ? `${link.repository}#${link.number}` : `#${link.number}`;
}

/**
 * Build the `pr_link_seen` payload. Normalizes at the write side so what
 * lands in `events.jsonl` is already clean; the read side normalizes again
 * for rows written before this existed, and the two agree because every
 * normalizer here is idempotent.
 *
 * @returns {object|null} null when the record carries no usable number —
 *   there is nothing to record about a link you cannot address.
 */
export function prLinkSeenPayload({ repository, number, url, observedAt, observedFrom } = {}) {
  const n = normalizeNumber(number);
  if (n === null) return null;
  const payload = {
    repository: normalizeRepository(repository),
    number: n,
    url: normalizeUrl(url),
  };
  const provenance = normalizeObservedFrom(observedFrom);
  if (provenance) payload.observed_from = provenance;
  if (isIso8601(observedAt)) payload.observed_at = observedAt;
  return payload;
}

/**
 * Read a `pr_link_seen` event back into a normalized link.
 *
 * @param {object} event
 * @returns {{repository: (string|null), number: number, url: (string|null),
 *   first_seen_at: (string|null), observed_from: (string|null)}|null}
 */
export function prLinkFromEvent(event) {
  const p = event && typeof event === 'object' ? event.payload : null;
  if (!p || typeof p !== 'object') return null;
  const number = normalizeNumber(p.number);
  if (number === null) return null;
  return {
    repository: normalizeRepository(p.repository),
    number,
    url: normalizeUrl(p.url),
    first_seen_at: isIso8601(p.observed_at) ? p.observed_at
      : (isIso8601(event.ts) ? event.ts : null),
    observed_from: normalizeObservedFrom(p.observed_from),
  };
}

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
export function applyPrLinkToSession(session, link) {
  if (!session || !link) return false;
  if (!Array.isArray(session.pr_links)) session.pr_links = [];
  const key = prLinkKey(link);
  const existing = session.pr_links.find((l) => prLinkKey(l) === key);

  if (!existing) {
    if (session.pr_links.length >= MAX_PR_LINKS_PER_SESSION) return false;
    session.pr_links.push({
      repository: link.repository,
      number: link.number,
      url: link.url,
      first_seen_at: link.first_seen_at,
    });
    sortPrLinks(session.pr_links);
    return true;
  }

  let changed = false;
  if (existing.url === null && link.url !== null) {
    existing.url = link.url;
    changed = true;
  }
  if (existing.repository === null && link.repository !== null) {
    existing.repository = link.repository;
    changed = true;
  }
  if (link.first_seen_at !== null &&
      (existing.first_seen_at === null || link.first_seen_at < existing.first_seen_at)) {
    existing.first_seen_at = link.first_seen_at;
    changed = true;
  }
  if (changed) sortPrLinks(session.pr_links);
  return changed;
}

/** Stable order so a projection round-trip is byte-identical. */
function sortPrLinks(links) {
  links.sort((a, b) => {
    const ra = a.repository ?? '';
    const rb = b.repository ?? '';
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.number - b.number;
  });
}

/**
 * Does this session carry a link the query refers to?
 *
 * Accepts the forms a person actually types: `722`, `#722`, `!722` (GitLab's
 * MR sigil), `druumen/cn/drummen#722`, a bare repository path, or any
 * substring of the url. The bare-number form matches on the NUMBER only —
 * `72` must not match `#722`, because a query that silently widens is worse
 * than one that finds nothing.
 *
 * @param {object} session
 * @param {string} query
 * @returns {boolean}
 */
const BARE_NUMBER_RE = new RegExp(`^[!#]?(\\d{1,${MAX_PR_NUMBER_DIGITS}})$`);

export function sessionMatchesPrQuery(session, query) {
  if (!session || typeof query !== 'string') return false;
  const links = Array.isArray(session.pr_links) ? session.pr_links : [];
  if (links.length === 0) return false;
  const q = query.trim();
  if (q.length === 0) return false;
  const lower = q.toLowerCase();

  const bare = BARE_NUMBER_RE.exec(q);
  if (bare) {
    const n = Number(bare[1]);
    return links.some((l) => l.number === n);
  }

  return links.some((l) => {
    if (formatPrLink(l).toLowerCase() === lower) return true;
    if (l.repository && l.repository.toLowerCase().includes(lower)) return true;
    if (l.url && l.url.toLowerCase().includes(lower)) return true;
    return false;
  });
}
