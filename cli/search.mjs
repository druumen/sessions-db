/**
 * `sessions-db search <query>` — find past sessions by a free-text query.
 * Read-only: never appends to events.jsonl.
 *
 * Built for AI-tool consumption: an agent runs `sessions-db search "<q>" --json`
 * over Bash to locate the session that discussed/decided something, at minimal
 * context cost (no MCP schema tax). Two tiers:
 *
 *   - default      metadata only — substring match across alias / first prompt /
 *                  branch / cwd / task / project / ids. Fast (projection only).
 *   - --content    ALSO scan transcript message text (.jsonl) and return a
 *                  snippet. Slower (reads transcript files); --deep is an alias.
 *
 * A session matches if EITHER tier hits; `matched_in` reports which, and a
 * `snippet` is included for content hits.
 *
 * Output:
 *   - default: compact human list
 *   - --json:  array of { stable_id, alias, first_prompt_preview, activity_state,
 *              last_progress_at, claude_session_ids, matched_in, snippet }
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { loadProjection } from '../lib/storage.mjs';
import { matchSessionMetadata, recordText, extractSnippet } from '../lib/search.mjs';
import {
  listTranscriptFiles,
  parseTranscriptFile,
  workspaceHashFromCwd,
} from '../lib/transcript.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { formatJSON, pickLabel, relTime, shouldUseColor, truncateStableId } from './format.mjs';

const VALID_STATES = new Set(['active', 'idle', 'archived']);

const SPEC = {
  positional: [{ name: 'query', required: true }],
  flags: {
    '--content': { type: 'boolean' },
    '--deep': { type: 'boolean' }, // alias for --content
    '--state': { type: 'string' },
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
  ],
});

/**
 * Pure metadata pass — exposed for unit tests. Returns matched sessions with
 * their matched field labels, sorted by last_progress_at DESC.
 *
 * @returns {Array<{ session: object, matched_in: string[] }>}
 */
export function searchByMetadata(projection, query, { state } = {}) {
  const sessions = projection && projection.sessions ? projection.sessions : {};
  const out = [];
  for (const s of Object.values(sessions)) {
    if (state && s.activity_state !== state) continue;
    const hits = matchSessionMetadata(s, query);
    if (hits.length > 0) out.push({ session: s, matched_in: hits });
  }
  return sortByRecencyDesc(out);
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

  const state = parsed.flags['--state'];
  const limit = parsed.flags['--limit'] > 0 ? parsed.flags['--limit'] : 20;
  const wantContent = parsed.flags['--content'] === true || parsed.flags['--deep'] === true;

  const root = parsed.flags['--root'];
  const projection = await loadProjection(root ? { root } : {});

  // Tier 1 — metadata. Build a map so the content pass can merge matched_in.
  const byId = new Map();
  for (const { session, matched_in } of searchByMetadata(projection, query, { state })) {
    byId.set(session.stable_id, { session, matched_in: [...matched_in], snippet: null });
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
      const hit = await scanSessionContent(s, query, { maxFileMb, cache });
      if (!hit) continue;
      // Tag disk-discovered hits so coverage gaps are visible in output.
      const label = hit.fromDisk ? 'content(disk)' : 'content';
      const existing = byId.get(s.stable_id);
      if (existing) {
        existing.matched_in.push(label);
        existing.snippet = hit.snippet;
      } else {
        byId.set(s.stable_id, { session: s, matched_in: [label], snippet: hit.snippet });
      }
    }
  }

  const results = sortByRecencyDesc([...byId.values()]).slice(0, limit);

  if (parsed.flags['--quiet']) return;

  if (parsed.flags['--json']) {
    process.stdout.write(
      formatJSON(
        results.map((r) => ({
          stable_id: r.session.stable_id,
          alias: r.session.alias ?? null,
          first_prompt_preview: r.session.first_prompt_preview ?? null,
          activity_state: r.session.activity_state ?? null,
          last_progress_at: r.session.last_progress_at ?? null,
          claude_session_ids: r.session.claude_session_ids ?? [],
          matched_in: r.matched_in,
          snippet: r.snippet,
        })),
      ),
    );
    return;
  }

  const useColor = shouldUseColor(process.stdout.isTTY, process.env, parsed.flags['--no-color'] === true);
  process.stdout.write(formatSearchList(results, { useColor, wantContent }));
}

function formatSearchList(results, { wantContent } = {}) {
  if (results.length === 0) {
    return wantContent
      ? 'No sessions matched (metadata + content).\n'
      : 'No sessions matched metadata. Try --content to scan transcript text.\n';
  }
  const lines = [];
  for (const r of results) {
    const id = truncateStableId(r.session.stable_id);
    const state = r.session.activity_state || '?';
    const label = pickLabel(r.session).text;
    const when = relTime(r.session.last_progress_at);
    lines.push(`${id}  ${state.padEnd(8)}  ${label}  (${when})`);
    lines.push(`    matched: ${r.matched_in.join(', ')}`);
    if (r.snippet) lines.push(`    … ${r.snippet}`);
  }
  return lines.join('\n') + '\n';
}
