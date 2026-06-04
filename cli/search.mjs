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
 * IO: scan one session's transcript files for the query. Returns the first
 * snippet found (and the file it came from), or null. Bails on files larger
 * than maxFileMb and on read errors (best-effort).
 */
async function scanSessionContent(session, query, { maxFileMb = 32 } = {}) {
  const files = Array.isArray(session.transcript_files) ? session.transcript_files : [];
  for (const tf of files) {
    const p = tf && typeof tf.path === 'string' ? tf.path : null;
    if (!p || !existsSync(p)) continue;
    try {
      if (statSync(p).size > maxFileMb * 1024 * 1024) continue;
    } catch {
      continue;
    }
    const snippet = await scanFile(p, query);
    if (snippet) return { snippet, file: p };
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

  // Tier 2 — content (opt-in). Scans EVERY in-state session's transcripts.
  if (wantContent) {
    const maxFileMb = parsed.flags['--max-file-mb'] > 0 ? parsed.flags['--max-file-mb'] : 32;
    const sessions = projection && projection.sessions ? projection.sessions : {};
    for (const s of Object.values(sessions)) {
      if (state && s.activity_state !== state) continue;
      const hit = await scanSessionContent(s, query, { maxFileMb });
      if (!hit) continue;
      const existing = byId.get(s.stable_id);
      if (existing) {
        existing.matched_in.push('content');
        existing.snippet = hit.snippet;
      } else {
        byId.set(s.stable_id, { session: s, matched_in: ['content'], snippet: hit.snippet });
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
