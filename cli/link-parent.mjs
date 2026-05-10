/**
 * `sessions-db link-parent <child> <parent>` — explicitly promote a hub-spoke
 * parent relationship (sets `parent_session_id` on child).
 * `sessions-db link-parent <child> --remove` — clear parent (set null).
 *
 * Day 3 refactor: all child / parent existence checks AND multi-hop cycle
 * detection live in `lib/operations.setParent`. This handler is a thin
 * wrapper that maps argv → operation call → exit code, so the cycle
 * defense exists in exactly one place.
 *
 * Cycle defense semantics (preserved from earlier phases):
 *   - direct: child === parent (1-cycle) — rejected
 *   - multi-hop: walk the proposed parent's ancestor chain (via the
 *     projection's parent_session_id pointers) and refuse if we ever
 *     encounter `child` — that would close the loop, e.g. A→B already
 *     exists and someone runs `link-parent B A` would form A→B→A.
 *   - bound: MAX_PARENT_CHAIN_DEPTH = 50 in operations.mjs to defend
 *     against a stale projection cycle.
 */

import { setParent } from '../lib/operations.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { renderDryRun, reportResult, reportStableIdNotFound } from './_write-helpers.mjs';

const SPEC = {
  positional: [
    { name: 'child', required: true },
    { name: 'parent', required: false },
  ],
  flags: {
    '--remove': { type: 'boolean' },
    '--dry-run': { type: 'boolean' },
    '--json': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db link-parent <child> <parent>  |  sessions-db link-parent <child> --remove',
  summary: 'Promote a hub-spoke parent relationship (or clear it).',
  flags: [
    { name: '--remove',    desc: 'clear parent_session_id (set null)' },
    { name: '--dry-run',   desc: 'print event but do not write' },
    { name: '--json',      desc: 'JSON output' },
    { name: '--root <p>',  desc: 'override storage root' },
  ],
  examples: [
    'sessions-db link-parent sess_child-... sess_parent-...',
    'sessions-db link-parent sess_child-... --remove',
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

  const child = parsed.positional.child;
  const parent = parsed.positional.parent;
  const remove = parsed.flags['--remove'] === true;
  const root = parsed.flags['--root'];
  const dryRun = parsed.flags['--dry-run'] === true;
  const json = parsed.flags['--json'] === true;
  const quiet = parsed.flags['--quiet'] === true;

  if (remove && parent !== undefined) {
    process.stderr.write(`error: parent positional and --remove are mutually exclusive\n`);
    process.exit(2);
  }
  if (!remove && parent === undefined) {
    process.stderr.write(`error: provide a parent stable_id or --remove\n`);
    process.exit(2);
  }
  if (!remove && parent === child) {
    // Self-cycle would render as "(circular reference)" and serve no
    // purpose. Operations.setParent rejects it too, but the historical
    // CLI message is "cannot be the same stable_id" — preserve it.
    process.stderr.write(`error: parent and child cannot be the same stable_id\n`);
    process.exit(1);
  }

  if (dryRun) {
    const payload = remove ? { parent_session_id: null } : { parent_session_id: parent };
    renderDryRun({ op: 'parent_set', stableId: child, payload, json });
    return;
  }

  const opts = root ? { root } : {};
  const result = remove
    ? await setParent({ childId: child, clear: true, ...opts })
    : await setParent({ childId: child, parentId: parent, ...opts });

  if (!result.ok && typeof result.error === 'string') {
    if (result.error.startsWith('stable_id not found:')) {
      if (!quiet) {
        const code = reportStableIdNotFound(result.error);
        process.exit(code);
      }
      process.exit(1);
    }
    if (result.error.startsWith('setParent: would create a cycle:')) {
      if (!quiet) {
        // Strip the `setParent: ` prefix to keep the historical CLI
        // wording (`error: link-parent would create a cycle: ...`). The
        // operation phrasing is `would create a cycle:` — match the test
        // regex `/would create a cycle/` either way; we re-prefix so
        // the operator-facing message names the CLI subcommand.
        const tail = result.error.slice('setParent: '.length);
        process.stderr.write(`error: link-parent ${tail}\n`);
      }
      process.exit(1);
    }
  }

  const code = reportResult({
    result, op: 'parent_set', stableId: child, json, quiet,
    extra: remove ? { cleared: true } : { parent: parent },
  });
  if (code !== 0) process.exit(code);
}
