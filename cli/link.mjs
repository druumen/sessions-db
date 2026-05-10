/**
 * `sessions-db link <stable_id> --task X|--project X` — link a session to a
 * task or project (additive). Pass `--remove` to dispatch a `session_unlink`
 * event that removes the named tasks / projects.
 *
 * P5 changes (compared to P4):
 *   - `--remove --task X` now ships: writes a `session_unlink` event whose
 *     P5 reducer filters tasks[]/projects[] in place (set-based, idempotent).
 *     The P4 fast-fail path (refusing --remove with exit 2 + "not implemented"
 *     message) was retired — earlier divergence-from-projection fix is no
 *     longer needed because the unlink reducer + event op now exist.
 *   - `--remove` with no `--task` / `--project` still rejects with exit 2 +
 *     "requires at least one --task or --project" so an operator running
 *     `link <id> --remove` (no targets) does not get a confusing no-op event.
 */

import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { commitEvent, loadAndVerify, renderDryRun, reportResult } from './_write-helpers.mjs';

const SPEC = {
  positional: [{ name: 'stable_id', required: true }],
  flags: {
    '--task': { type: 'string', repeatable: true },
    '--project': { type: 'string', repeatable: true },
    '--remove': { type: 'boolean' },
    '--dry-run': { type: 'boolean' },
    '--json': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db link <stable_id> [--task T ...] [--project P ...] [--remove]',
  summary: 'Link / unlink a session from one or more tasks / projects.',
  flags: [
    { name: '--task <id>',    desc: 'task filename to link (or unlink with --remove); repeatable' },
    { name: '--project <id>', desc: 'project key to link (or unlink with --remove); repeatable' },
    { name: '--remove',       desc: 'unlink instead of link — writes session_unlink event' },
    { name: '--dry-run',      desc: 'print event but do not write' },
    { name: '--json',         desc: 'JSON output' },
    { name: '--root <p>',     desc: 'override storage root' },
  ],
  examples: [
    'sessions-db link sess_01970000-... --task feat-foo.md',
    'sessions-db link sess_01970000-... --project proj-bar --task feat-foo.md',
    'sessions-db link sess_01970000-... --remove --task feat-foo.md',
  ],
});

function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
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

  const stableId = parsed.positional.stable_id;
  const tasks = asArray(parsed.flags['--task']);
  const projects = asArray(parsed.flags['--project']);
  const remove = parsed.flags['--remove'] === true;
  const root = parsed.flags['--root'];
  const dryRun = parsed.flags['--dry-run'] === true;
  const json = parsed.flags['--json'] === true;
  const quiet = parsed.flags['--quiet'] === true;

  if (tasks.length === 0 && projects.length === 0) {
    // Same message regardless of remove vs add — both modes need targets.
    if (remove) {
      process.stderr.write(
        `error: link --remove requires at least one --task or --project\n`,
      );
    } else {
      process.stderr.write(`error: provide at least one --task or --project\n`);
    }
    process.exit(2);
  }

  await loadAndVerify(stableId, root ? { root } : {});

  // P5: --remove writes a session_unlink event (set-based filter). Otherwise
  // we keep the P1 session_link path (additive).
  const op = remove ? 'session_unlink' : 'session_link';
  const payload = {};
  if (tasks.length > 0) payload.tasks = tasks;
  if (projects.length > 0) payload.projects = projects;

  if (dryRun) {
    renderDryRun({ op, stableId, payload, json });
    return;
  }

  const result = await commitEvent({ op, stableId, payload, root });
  const extra = {};
  if (tasks.length > 0) extra.tasks = tasks;
  if (projects.length > 0) extra.projects = projects;
  if (remove) extra.removed = true;
  const code = reportResult({
    result, op, stableId, json, quiet, extra,
  });
  if (code !== 0) process.exit(code);
}
