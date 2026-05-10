/**
 * `sessions-db tree <stable_id>` — render the hub-spoke subtree rooted at
 * `stable_id` (parent + recursive children). Read-only.
 *
 * The tree is built by inverting `parent_session_id` across all sessions in
 * the projection. Depth is capped (formatTree internals) to defend against
 * accidental circular chains.
 *
 * Exit codes:
 *   0 — root rendered
 *   1 — root stable_id not found in projection
 *   2 — argparse error (missing positional, etc.)
 */

import { loadProjection } from '../storage.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { formatJSON, formatTree, shouldUseColor } from './format.mjs';

const SPEC = {
  positional: [{ name: 'stable_id', required: true }],
  flags: {
    '--json': { type: 'boolean' },
    '--no-color': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db tree <stable_id> [--json]',
  summary: 'Render the hub-spoke parent → children subtree rooted at stable_id.',
  flags: [
    { name: '--json',        desc: 'JSON output: { root, children: [{stable_id, alias, ...}] }' },
    { name: '--no-color',    desc: 'disable ANSI color' },
    { name: '--root <path>', desc: 'override storage root (default cwd)' },
  ],
  examples: [
    'sessions-db tree sess_01970000-0000-7000-8000-00000000000a',
  ],
});

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

  const stableId = parsed.positional.stable_id;
  const root = parsed.flags['--root'];
  const projection = await loadProjection(root ? { root } : {});

  if (!projection.sessions || !projection.sessions[stableId]) {
    process.stderr.write(`error: stable_id not found: ${stableId}\n`);
    process.exit(1);
  }

  if (parsed.flags['--quiet']) return;

  if (parsed.flags['--json']) {
    process.stdout.write(formatJSON(buildTreeJSON(stableId, projection)));
    return;
  }

  const useColor = shouldUseColor(
    process.stdout.isTTY,
    process.env,
    parsed.flags['--no-color'] === true,
  );
  process.stdout.write(formatTree(stableId, projection, { useColor }));
}

/**
 * Build a JSON-friendly tree object. Exposed for tests.
 */
export function buildTreeJSON(rootId, projection) {
  const sessions = projection && projection.sessions ? projection.sessions : {};
  const childIdx = new Map();
  for (const [sid, s] of Object.entries(sessions)) {
    const parent = s && s.parent_session_id;
    if (parent && parent !== sid) {
      if (!childIdx.has(parent)) childIdx.set(parent, []);
      childIdx.get(parent).push(sid);
    }
  }
  const visited = new Set();
  const MAX_DEPTH = 32;

  function build(sid, depth) {
    if (depth > MAX_DEPTH) return { stable_id: sid, truncated: 'max-depth' };
    if (visited.has(sid)) return { stable_id: sid, truncated: 'circular' };
    visited.add(sid);
    const s = sessions[sid];
    const kids = (childIdx.get(sid) || [])
      .slice()
      .sort((a, b) => {
        const ca = sessions[a] && sessions[a].created_at;
        const cb = sessions[b] && sessions[b].created_at;
        if (!ca && !cb) return 0;
        if (!ca) return 1;
        if (!cb) return -1;
        return ca < cb ? -1 : ca > cb ? 1 : 0;
      })
      .map((kid) => build(kid, depth + 1));
    return {
      stable_id: sid,
      alias: s ? s.alias : null,
      activity_state: s ? s.activity_state : null,
      outcome: s ? s.outcome : null,
      last_progress_at: s ? s.last_progress_at : null,
      branch_current: s ? s.branch_current : null,
      children: kids,
    };
  }

  return build(rootId, 0);
}
