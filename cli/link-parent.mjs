/**
 * `sessions-db link-parent <child> <parent>` — explicitly promote a hub-spoke
 * parent relationship (sets `parent_session_id` on child).
 * `sessions-db link-parent <child> --remove` — clear parent (set null).
 *
 * Writes a `parent_set` event. Both child and parent must exist (when not
 * removing). We refuse anything that would create a cycle:
 *   - direct: child === parent (1-cycle)
 *   - multi-hop: walk the proposed parent's ancestor chain (via the
 *     projection's parent_session_id pointers) and refuse if we ever
 *     encounter `child` — that would close the loop, e.g. A→B already
 *     exists and someone runs `link-parent B A` would form A→B→A.
 *
 * We bound the ancestor walk at MAX_PARENT_CHAIN_DEPTH because the
 * projection might already contain a stale cycle (rare; would require a
 * bypass of this guard, but we don't want a corrupt projection to hang the
 * CLI). 50 is generous — real hub-spoke chains are 1-3 hops.
 */

import { loadProjection } from '../storage.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { commitEvent, loadAndVerify, renderDryRun, reportResult } from './_write-helpers.mjs';

const MAX_PARENT_CHAIN_DEPTH = 50;

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
    // Self-cycle would render as "(circular reference)" and serve no purpose.
    process.stderr.write(`error: parent and child cannot be the same stable_id\n`);
    process.exit(1);
  }

  // Always verify child exists.
  await loadAndVerify(child, root ? { root } : {});
  // Verify parent exists too (when not removing).
  if (!remove) {
    await loadAndVerify(parent, root ? { root } : {});

    // P4 round-1 review fix: walk the proposed parent's ancestor chain
    // and refuse if we encounter `child` (would close a cycle of length
    // > 1, e.g. existing A→B + proposed `link-parent B A` → A→B→A).
    // The 1-cycle (parent === child) was already rejected above.
    const projection = await loadProjection(root ? { root } : {});
    let cursor = parent;
    for (let depth = 0; depth < MAX_PARENT_CHAIN_DEPTH && cursor; depth++) {
      if (cursor === child) {
        process.stderr.write(
          `error: link-parent would create a cycle: `
          + `proposed parent ${parent} reaches child ${child} after ${depth} hop(s)\n`,
        );
        process.exit(1);
      }
      const ancestor = projection.sessions && projection.sessions[cursor];
      cursor = ancestor && ancestor.parent_session_id ? ancestor.parent_session_id : null;
    }
  }

  const payload = remove ? { parent_session_id: null } : { parent_session_id: parent };

  if (dryRun) {
    renderDryRun({ op: 'parent_set', stableId: child, payload, json });
    return;
  }

  const result = await commitEvent({ op: 'parent_set', stableId: child, payload, root });
  const code = reportResult({
    result, op: 'parent_set', stableId: child, json, quiet,
    extra: remove ? { cleared: true } : { parent: parent },
  });
  if (code !== 0) process.exit(code);
}
