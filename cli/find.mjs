/**
 * `sessions-db find` — filter sessions by task / project / alias / branch /
 * cwd / state / outcome. Read-only: never appends to events.jsonl.
 *
 * Filter semantics:
 *   - All flags AND together (intersection).
 *   - String filters are exact match. cwd uses substring match because the
 *     stored cwd is an absolute path and operators usually remember the
 *     trailing dir name only.
 *   - state / outcome are validated against the projection's enum
 *     (active|idle|archived for state, open|done|blocked|abandoned|
 *      merged|superseded for outcome). Invalid values exit 2 (argparse-class).
 *   - --limit defaults to 50 to keep a `find` with no filters readable. Sort
 *     is last_progress_at DESC (most recent first) — matches the UX where
 *     ops staff want to see "what's been touched lately" by default.
 *
 * Output:
 *   - default: ASCII table (formatSessionTable)
 *   - --json: array of full session records
 */

import { loadProjection } from '../storage.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { formatJSON, formatSessionTable, shouldUseColor } from './format.mjs';

const VALID_STATES = new Set(['active', 'idle', 'archived']);
const VALID_OUTCOMES = new Set(['open', 'done', 'blocked', 'abandoned', 'merged', 'superseded']);

const SPEC = {
  positional: [],
  flags: {
    '--task': { type: 'string' },
    '--project': { type: 'string' },
    '--alias': { type: 'string' },
    '--branch': { type: 'string' },
    '--cwd': { type: 'string' },
    '--state': { type: 'string' },
    '--outcome': { type: 'string' },
    '--limit': { type: 'number', default: 50 },
    '--json': { type: 'boolean' },
    '--no-color': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db find [filters] [--limit N] [--json]',
  summary: 'Filter sessions by task / project / alias / branch / cwd / state / outcome.',
  flags: [
    { name: '--task <id>',    desc: 'task filename match (e.g. feat-foo-DDMMYYYY.md)' },
    { name: '--project <id>', desc: 'project key/dirname match' },
    { name: '--alias <s>',    desc: 'exact alias match' },
    { name: '--branch <b>',   desc: 'branch_current or branch_at_start exact match' },
    { name: '--cwd <s>',      desc: 'cwd / worktree_path substring match' },
    { name: '--state <s>',    desc: 'active | idle | archived' },
    { name: '--outcome <s>',  desc: 'open | done | blocked | abandoned | merged | superseded' },
    { name: '--limit <N>',    desc: 'cap result count (default 50)' },
    { name: '--json',         desc: 'machine-readable JSON output' },
    { name: '--no-color',     desc: 'disable ANSI color' },
    { name: '--root <path>',  desc: 'override storage root (default cwd)' },
  ],
  examples: [
    'sessions-db find --task feat-pricing-overhaul-04052026.md',
    'sessions-db find --state active --limit 10',
    'sessions-db find --branch master --outcome open --json',
  ],
});

/**
 * Pure filter — exposed so the integration test (and tree-style debugging
 * tools) can drive the same query plane without the CLI shell.
 *
 * @param {object} projection
 * @param {{ task?: string, project?: string, alias?: string, branch?: string,
 *   cwd?: string, state?: string, outcome?: string, limit?: number }} filters
 * @returns {Array<object>}
 */
export function searchSessions(projection, filters = {}) {
  const sessions = projection && projection.sessions ? projection.sessions : {};
  const limit = typeof filters.limit === 'number' && filters.limit > 0 ? filters.limit : 50;

  const out = [];
  for (const s of Object.values(sessions)) {
    if (!matches(s, filters)) continue;
    out.push(s);
  }
  // Sort by last_progress_at DESC (string compare on ISO 8601 is lexically
  // correct for descending recency).
  out.sort((a, b) => {
    const la = a.last_progress_at || '';
    const lb = b.last_progress_at || '';
    if (la === lb) return 0;
    return la < lb ? 1 : -1;
  });
  return out.slice(0, limit);
}

function matches(session, filters) {
  if (!session || typeof session !== 'object') return false;

  if (filters.task) {
    if (!Array.isArray(session.tasks) || !session.tasks.includes(filters.task)) return false;
  }
  if (filters.project) {
    if (!Array.isArray(session.projects) || !session.projects.includes(filters.project)) return false;
  }
  if (filters.alias) {
    if (session.alias !== filters.alias) return false;
  }
  if (filters.branch) {
    if (session.branch_current !== filters.branch
        && session.branch_at_start !== filters.branch) return false;
  }
  if (filters.cwd) {
    const candidates = [session.cwd, session.worktree_path_observed, session.worktree_realpath]
      .filter((v) => typeof v === 'string' && v.length > 0);
    if (!candidates.some((v) => v.includes(filters.cwd))) return false;
  }
  if (filters.state) {
    if (session.activity_state !== filters.state) return false;
  }
  if (filters.outcome) {
    if (session.outcome !== filters.outcome) return false;
  }
  return true;
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

  // Validate enum-typed flags.
  if (parsed.flags['--state'] !== undefined && !VALID_STATES.has(parsed.flags['--state'])) {
    process.stderr.write(`error: --state must be one of: ${[...VALID_STATES].join(', ')}\n`);
    process.exit(2);
  }
  if (parsed.flags['--outcome'] !== undefined && !VALID_OUTCOMES.has(parsed.flags['--outcome'])) {
    process.stderr.write(`error: --outcome must be one of: ${[...VALID_OUTCOMES].join(', ')}\n`);
    process.exit(2);
  }

  const root = parsed.flags['--root'];
  const projection = await loadProjection(root ? { root } : {});

  const filters = {
    task: parsed.flags['--task'],
    project: parsed.flags['--project'],
    alias: parsed.flags['--alias'],
    branch: parsed.flags['--branch'],
    cwd: parsed.flags['--cwd'],
    state: parsed.flags['--state'],
    outcome: parsed.flags['--outcome'],
    limit: parsed.flags['--limit'],
  };

  const matched = searchSessions(projection, filters);

  if (parsed.flags['--quiet']) return;

  if (parsed.flags['--json']) {
    process.stdout.write(formatJSON(matched));
    return;
  }

  const useColor = shouldUseColor(
    process.stdout.isTTY,
    process.env,
    parsed.flags['--no-color'] === true,
  );
  process.stdout.write(formatSessionTable(matched, { useColor }));
}
