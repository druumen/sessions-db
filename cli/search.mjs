/**
 * `sessions-db search <query>` — find past sessions by a free-text query.
 * Read-only: never appends to events.jsonl.
 *
 * Built for AI-tool consumption: an agent runs `sessions-db search "<q>" --json`
 * over Bash to locate the session that discussed/decided something, at minimal
 * context cost (no MCP schema tax). Two tiers:
 *
 *   - default          metadata only — substring match across the CURRENT value
 *                      of every naming channel plus first prompt / branch /
 *                      cwd / task / project / ids. Fast (projection only).
 *   - --include-history ALSO match names the session no longer has. Folds
 *                      events.jsonl (the only place history lives).
 *   - --content        ALSO scan transcript message text (.jsonl) and return a
 *                      snippet. Slower (reads transcript files); --deep is an
 *                      alias.
 *
 * A session matches if ANY tier hits; `matched_in` reports which, `snippet` is
 * included for content hits, and `name_hits` says for each matched name which
 * channel it came from and whether it is the current value or a former one —
 * without that, "search found it" cannot be told apart from "search found a
 * name it used to have", which is exactly the question the history flag is
 * there to answer.
 *
 * Output:
 *   - default: compact human list
 *   - --json:  array of { stable_id, alias, display_name, display_name_channel,
 *              first_prompt_preview, activity_state, last_progress_at,
 *              claude_session_ids, pr_links, names, matched_in, snippet,
 *              name_hits }
 */

import { formatPrLink } from '../lib/pr-links.mjs';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { CHANNEL_FIRST_PROMPT, displayNameForSession, foldNameHistory } from '../lib/names.mjs';
import { loadProjection, readAllEvents } from '../lib/storage.mjs';
import {
  distinctCurrentNames,
  extractSnippet,
  matchCurrentNames,
  matchNameHistory,
  matchSessionMetadata,
  recordText,
} from '../lib/search.mjs';
import {
  listTranscriptFiles,
  parseTranscriptFile,
  workspaceHashFromCwd,
} from '../lib/transcript.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { formatJSON, pickLabel, relTime, shouldUseColor, truncateStableId } from './format.mjs';

const VALID_STATES = new Set(['active', 'idle', 'archived']);
/** Sources a session can come from. Open in the data model (a future agent
 * adds a value), closed at the CLI so a typo is an error rather than an empty
 * result. Extend both this set and the help text together. */
const VALID_SOURCES = new Set(['claude', 'codex']);

const SPEC = {
  positional: [{ name: 'query', required: true }],
  flags: {
    '--content': { type: 'boolean' },
    '--deep': { type: 'boolean' }, // alias for --content
    '--include-history': { type: 'boolean' },
    '--state': { type: 'string' },
    '--source': { type: 'string' },
    '--limit': { type: 'number', default: 20 },
    '--max-file-mb': { type: 'number', default: 32 },
    '--json': { type: 'boolean' },
    '--no-color': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db search <query> [--content] [--state s] [--limit N] [--json]',
  summary: 'Find sessions by free-text query (metadata; --content also scans transcript text).',
  flags: [
    { name: '--content',       desc: 'also scan transcript message text + return a snippet (slow)' },
    { name: '--deep',          desc: 'alias for --content' },
    { name: '--include-history', desc: 'also search names the sessions no longer have (folds the event log)' },
    { name: '--source <s>',   desc: 'only claude or only codex sessions (default: both)' },
    { name: '--state <s>',     desc: 'restrict to active | idle | archived' },
    { name: '--limit <N>',     desc: 'cap result count (default 20)' },
    { name: '--max-file-mb <N>', desc: 'skip transcript files larger than N MB (default 32)' },
    { name: '--json',          desc: 'machine-readable JSON (recommended for AI tools)' },
    { name: '--no-color',      desc: 'disable ANSI color' },
    { name: '--root <path>',   desc: 'override storage root (default cwd)' },
  ],
  examples: [
    'sessions-db search "pricing overhaul" --json',
    'sessions-db search "RLS regression" --content --limit 5 --json',
    'sessions-db search bm-canvas --state active',
    'sessions-db search "Fix HTTP 400" --include-history   # find it under a name it lost',
  ],
});

/**
 * Pure metadata pass — exposed for unit tests. Returns matched sessions with
 * their matched field labels, sorted by last_progress_at DESC.
 *
 * @returns {Array<{ session: object, matched_in: string[] }>}
 */
/**
 * `source` filters by which agent produced the session (`claude` / `codex`).
 * Records written before that field existed are treated as `claude` — they
 * could not have been anything else — so the filter never hides history.
 */
export function searchByMetadata(projection, query, { state, source } = {}) {
  const sessions = projection && projection.sessions ? projection.sessions : {};
  const out = [];
  for (const s of Object.values(sessions)) {
    if (state && s.activity_state !== state) continue;
    if (source && sessionSource(s) !== source) continue;
    const hits = matchSessionMetadata(s, query);
    if (hits.length > 0) out.push({ session: s, matched_in: hits });
  }
  return sortByRecencyDesc(out);
}

/** @param {object} s @returns {string} the session's source, defaulting to claude */
export function sessionSource(s) {
  return typeof s.source === 'string' && s.source.length > 0 ? s.source : 'claude';
}

function sortByRecencyDesc(rows) {
  return rows.sort((a, b) => {
    const la = a.session.last_progress_at || '';
    const lb = b.session.last_progress_at || '';
    if (la === lb) return 0;
    return la < lb ? 1 : -1;
  });
}

/**
 * Per-invocation cache so a `--content` run scanning many empty sessions in the
 * same workspace doesn't re-readdir / re-parse transcripts repeatedly.
 */
export function makeDiskCache() {
  return { listByHash: new Map(), sessionIdByPath: new Map() };
}

function listFilesCached(cwd, cache) {
  let hash;
  try {
    hash = workspaceHashFromCwd(cwd);
  } catch {
    return [];
  }
  if (cache.listByHash.has(hash)) return cache.listByHash.get(hash);
  let paths = [];
  try {
    paths = listTranscriptFiles(hash);
  } catch {
    paths = [];
  }
  cache.listByHash.set(hash, paths);
  return paths;
}

async function sessionIdForPath(path, cache) {
  if (cache.sessionIdByPath.has(path)) return cache.sessionIdByPath.get(path);
  let sid = null;
  try {
    const meta = await parseTranscriptFile(path);
    sid = meta && typeof meta.sessionId === 'string' ? meta.sessionId : null;
  } catch {
    sid = null;
  }
  cache.sessionIdByPath.set(path, sid);
  return sid;
}

/**
 * Coverage fallback: locate transcripts for a session that has NO recorded
 * transcript_files, by deriving the workspace dir from cwd
 * (workspaceHashFromCwd → listTranscriptFiles) and keeping only files whose
 * embedded sessionId is one of the session's claude_session_ids. Best-effort:
 * returns [] on missing cwd/ids, bad cwd, or absent workspace dir.
 */
export async function discoverTranscriptPaths(session, cache, { maxFileMb = 32 } = {}) {
  if (
    !session.cwd ||
    !Array.isArray(session.claude_session_ids) ||
    session.claude_session_ids.length === 0
  ) {
    return [];
  }
  const ids = new Set(session.claude_session_ids);
  const out = [];
  for (const p of listFilesCached(session.cwd, cache)) {
    try {
      if (statSync(p).size > maxFileMb * 1024 * 1024) continue;
    } catch {
      continue;
    }
    const sid = await sessionIdForPath(p, cache);
    if (sid && ids.has(sid)) out.push(p);
  }
  return out;
}

/**
 * IO: scan one session's transcripts for the query. Prefers the projection's
 * recorded transcript_files; when empty, falls back to disk discovery (cwd →
 * workspace hash → claude_session_id match) so sessions the hook never linked
 * are still content-searchable. Returns the first snippet (+ file) or null.
 */
async function scanSessionContent(session, query, { maxFileMb = 32, cache } = {}) {
  const recorded = Array.isArray(session.transcript_files) ? session.transcript_files : [];
  let paths;
  let fromDisk = false;
  if (recorded.length > 0) {
    paths = recorded.map((tf) => (tf && typeof tf.path === 'string' ? tf.path : null)).filter(Boolean);
  } else if (cache) {
    paths = await discoverTranscriptPaths(session, cache, { maxFileMb });
    fromDisk = true;
  } else {
    paths = [];
  }
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      if (statSync(p).size > maxFileMb * 1024 * 1024) continue;
    } catch {
      continue;
    }
    const snippet = await scanFile(p, query);
    if (snippet) return { snippet, file: p, fromDisk };
  }
  return null;
}

function scanFile(path, query) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try {
        rl.close();
        stream.destroy();
      } catch {
        // ignore
      }
      resolve(val);
    };
    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (done || !line) return;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      const snippet = extractSnippet(recordText(record), query);
      if (snippet) finish(snippet);
    });
    rl.on('close', () => finish(null));
    stream.on('error', () => finish(null));
  });
}

export async function run(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, SPEC);
  } catch (err) {
    if (err instanceof ArgparseError) {
      process.stderr.write(`error: ${err.message}\n\n${HELP}`);
      process.exit(err.exitCode);
    }
    throw err;
  }

  if (parsed.helpRequested) {
    process.stdout.write(HELP);
    return;
  }

  const query = parsed.positional.query;
  if (parsed.flags['--state'] !== undefined && !VALID_STATES.has(parsed.flags['--state'])) {
    process.stderr.write(`error: --state must be one of: ${[...VALID_STATES].join(', ')}\n`);
    process.exit(2);
  }

  // Validated the same way `--state` is: an unknown value must be an
  // argparse error, not a filter that silently matches nothing. A typo'd
  // `--source codx` returning zero rows looks exactly like "you have no codex
  // sessions", which is the wrong thing to learn from a typo.
  if (parsed.flags['--source'] !== undefined && !VALID_SOURCES.has(parsed.flags['--source'])) {
    process.stderr.write(`error: --source must be one of: ${[...VALID_SOURCES].join(', ')}\n`);
    process.exit(2);
  }

  const state = parsed.flags['--state'];
  const source = parsed.flags['--source'];
  const limit = parsed.flags['--limit'] > 0 ? parsed.flags['--limit'] : 20;
  const wantContent = parsed.flags['--content'] === true || parsed.flags['--deep'] === true;
  const wantHistory = parsed.flags['--include-history'] === true;

  const root = parsed.flags['--root'];
  const rootOpts = root ? { root } : {};
  const projection = await loadProjection(rootOpts);

  // Tier 1 — metadata (current names included). Build a map so the later
  // passes can merge matched_in.
  const byId = new Map();
  for (const { session, matched_in } of searchByMetadata(projection, query, { state, source })) {
    byId.set(session.stable_id, {
      session,
      matched_in: [...matched_in],
      snippet: null,
      name_hits: matchCurrentNames(session, query),
    });
  }

  // Tier 2 — former names (opt-in). This is the only tier that reads the
  // event log: the projection deliberately keeps just the current value per
  // channel, so a name a session no longer has exists nowhere else. Sessions
  // that matched nothing on tier 1 can enter the result set here — that is the
  // whole point ("I remember it was called X, then it got renamed").
  if (wantHistory) {
    const { events } = readAllEvents(rootOpts);
    const historyBySession = foldNameHistory(events);
    const sessions = (projection && projection.sessions) || {};
    for (const [stableId, byChannel] of historyBySession) {
      const session = sessions[stableId];
      // A session in the log but not in the projection was pruned or predates
      // the cache; there is nothing to render for it.
      if (!session) continue;
      if (state && session.activity_state !== state) continue;
      const hits = matchNameHistory(byChannel, query);
      if (hits.length === 0) continue;
      const existing = byId.get(stableId);
      const labels = hits.map((h) => `name_history:${h.channel}`);
      if (existing) {
        for (const label of labels) {
          if (!existing.matched_in.includes(label)) existing.matched_in.push(label);
        }
        existing.name_hits.push(...hits);
      } else {
        byId.set(stableId, {
          session,
          matched_in: [...new Set(labels)],
          snippet: null,
          name_hits: hits,
        });
      }
    }
  }

  // Tier 2 — content (opt-in). Scans EVERY in-state session's transcripts,
  // falling back to disk discovery for sessions with no recorded
  // transcript_files. A shared cache avoids re-listing/parsing per session.
  if (wantContent) {
    const maxFileMb = parsed.flags['--max-file-mb'] > 0 ? parsed.flags['--max-file-mb'] : 32;
    const cache = makeDiskCache();
    const sessions = projection && projection.sessions ? projection.sessions : {};
    for (const s of Object.values(sessions)) {
      if (state && s.activity_state !== state) continue;
      // The same filter as the metadata tier above. It has to be repeated
      // because this loop iterates the projection itself rather than the
      // metadata results — a filter applied on only one of the two tiers is
      // how `--source` would silently leak rows in `--content` mode.
      if (source && sessionSource(s) !== source) continue;
      const hit = await scanSessionContent(s, query, { maxFileMb, cache });
      if (!hit) continue;
      // Tag disk-discovered hits so coverage gaps are visible in output.
      const label = hit.fromDisk ? 'content(disk)' : 'content';
      const existing = byId.get(s.stable_id);
      if (existing) {
        existing.matched_in.push(label);
        existing.snippet = hit.snippet;
      } else {
        byId.set(s.stable_id, {
          session: s, matched_in: [label], snippet: hit.snippet, name_hits: [],
        });
      }
    }
  }

  const results = sortByRecencyDesc([...byId.values()]).slice(0, limit);

  if (parsed.flags['--quiet']) return;

  if (parsed.flags['--json']) {
    process.stdout.write(
      formatJSON(
        results.map((r) => {
          // Resolved rather than read off the record. A projection cache
          // written before 0.3.0 has no display_name field, but it does have
          // the legacy `alias` / `ai_title` mirrors — so computing gives the
          // right answer on an old cache instead of a null for every row.
          const display = displayNameForSession(r.session);
          return {
          stable_id: r.session.stable_id,
          alias: r.session.alias ?? null,
          display_name: display.display_name,
          display_name_channel: display.display_name_channel,
          // Every name the session currently answers to. `display_name` above
          // can only be ONE of them — the precedence chain picks a winner and
          // the losers become unreachable, which is what this closes: measured
          // on the reference database 2026-09-08 (688 sessions), 486 carry a
          // `cc_ai_title` and 32 of those are outranked by an `alias` or a
          // hand-typed `cc_custom_title`. For those 32, the title on the user's
          // own Claude Code tab was the one name a UUID / branch / cwd lookup
          // could not show them.
          //
          // NOT folded into `name_hits`: that field answers "which name caused
          // this hit", so a UUID query correctly reports none. Widening it
          // would destroy the only signal that separates a name match from any
          // other match.
          //
          // `[]` rather than omitted, for the same reason `pr_links` is below.
          //
          // Deliberately the STORED array and not the resolved display map: the
          // legacy `alias` / `ai_title` mirrors carry no `set_at` / `source`,
          // and synthesising those would make a derived guess indistinguishable
          // from a recorded fact. The consequence is real and worth knowing —
          // on that same database all 29 aliases live in the legacy mirror and
          // NONE as a `names[]` entry (a `rebuild` recovers all 29 from the
          // log), so a stale cache under-reports this array. It never costs the
          // caller the name itself: `alias` and `display_name` are on the row
          // either way, and the human formatter reads the display map.
          names: r.session.names ?? [],
          first_prompt_preview: r.session.first_prompt_preview ?? null,
          activity_state: r.session.activity_state ?? null,
          last_progress_at: r.session.last_progress_at ?? null,
          source: sessionSource(r.session),
          claude_session_ids: r.session.claude_session_ids ?? [],
          codex_session_ids: r.session.codex_session_ids ?? [],
          // MRs this session opened. Present as [] rather than omitted so a
          // consumer can tell "none" from "this row was written by a version
          // that did not know about them" — the same reason every other list
          // field here has a `?? []`.
          pr_links: r.session.pr_links ?? [],
          matched_in: r.matched_in,
          snippet: r.snippet,
          name_hits: r.name_hits ?? [],
          };
        }),
      ),
    );
    return;
  }

  const useColor = shouldUseColor(process.stdout.isTTY, process.env, parsed.flags['--no-color'] === true);
  process.stdout.write(formatSearchList(results, { useColor, wantContent }));
}

/**
 * The current names a result row does not already show, one line each.
 *
 * A row displays exactly one name — the precedence chain's winner — so every
 * other channel is invisible on it. That is not a corner case: on the
 * reference database (688 sessions, measured 2026-09-08) 486 carry a
 * `cc_ai_title` and 32 of those are outranked, i.e. for 32 sessions the title
 * the user reads off their own tab is the one name the row could not show.
 * The other 656 print nothing extra, which is the point — this adds a line
 * only where a name was actually being hidden.
 *
 * Deduped by VALUE and against what this row already printed, not merely by
 * channel: `agent_name` mirrors `cc_ai_title` (on that database all 3 of the
 * agent-badged sessions whose badge differed from the display name held a
 * badge byte-identical to their ai title), and a `name [...]` line above has
 * already spelled out whatever the query matched. Both dedups are what keep
 * the same string from appearing twice under two labels.
 *
 * `first_prompt` is skipped for the same reason `matchCurrentNames` skips it:
 * it is the display fallback, not a name anybody gave the session.
 *
 * @param {object} session
 * @param {Set<string>} shown values already printed for this row
 */
function hiddenNameLines(session, shown) {
  const { display_name } = displayNameForSession(session);
  const seen = new Set(shown);
  if (display_name !== null) seen.add(display_name);
  const lines = [];
  for (const [channel, value] of distinctCurrentNames(session)) {
    if (channel === CHANNEL_FIRST_PROMPT) continue;
    // Whitespace-only is not a name — the same rule `resolveDisplayName`
    // applies when it decides a channel cannot win the display.
    if (value.trim().length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    lines.push(`    also ${channel}: ${value}`);
  }
  return lines;
}

function formatSearchList(results, { wantContent } = {}) {
  if (results.length === 0) {
    return wantContent
      ? 'No sessions matched (metadata + content).\n'
      : 'No sessions matched metadata. Try --include-history (former names) or '
        + '--content (transcript text).\n';
  }
  const lines = [];
  for (const r of results) {
    const id = truncateStableId(r.session.stable_id);
    const state = r.session.activity_state || '?';
    // Only codex rows are tagged. Tagging both would add a column to every
    // line of every existing user's output to state the default.
    const src = sessionSource(r.session) === 'codex' ? ' [codex]' : '';
    const label = pickLabel(r.session).text;
    const when = relTime(r.session.last_progress_at);
    lines.push(`${id}  ${state.padEnd(8)}  ${label}${src}  (${when})`);
    lines.push(`    matched: ${r.matched_in.join(', ')}`);
    // Spell out current-vs-former per matched name. A result whose only hit is
    // a name the session lost looks identical to any other hit otherwise, and
    // the user would have no way to see why the row does not contain the text
    // they searched for.
    const shownNames = new Set();
    for (const hit of r.name_hits ?? []) {
      // The timestamp is when that value was SET, not when it stopped being
      // current — the log records renames, not their expiry.
      const when = hit.set_at ? `, set ${hit.set_at}` : '';
      lines.push(`    name [${hit.kind}] ${hit.channel}${when}: ${hit.value}`);
      shownNames.add(hit.value);
    }
    // …and the names nothing above showed. A hit on a UUID / branch / cwd
    // produces no `name` line at all, so without this the row stays silent
    // about what the session is called beyond its single display label.
    lines.push(...hiddenNameLines(r.session, shownNames));
    // MRs the session opened. Printed for every result, not only for `pr`
    // hits: when you have found the session you almost always want the number,
    // and it is one short line.
    const links = Array.isArray(r.session.pr_links) ? r.session.pr_links : [];
    if (links.length > 0) lines.push(`    mr: ${links.map(formatPrLink).join(' ')}`);
    if (r.snippet) lines.push(`    … ${r.snippet}`);
  }
  return lines.join('\n') + '\n';
}
