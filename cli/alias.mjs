/**
 * `sessions-db alias <stable_id> <alias>` — set or change the human-readable
 * alias.
 * `sessions-db alias <stable_id> --clear` — remove the alias (sets to null).
 *
 * Writes an `alias_set` event. Existence-check is performed BEFORE the write
 * so a typo'd stable_id surfaces as a clean exit-1 message instead of a
 * synthesized empty session record.
 */

import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { commitEvent, loadAndVerify, renderDryRun, reportResult } from './_write-helpers.mjs';

const SPEC = {
  positional: [
    { name: 'stable_id', required: true },
    { name: 'alias', required: false },
  ],
  flags: {
    '--clear': { type: 'boolean' },
    '--dry-run': { type: 'boolean' },
    '--json': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db alias <stable_id> <alias>  |  sessions-db alias <stable_id> --clear',
  summary: 'Set, change, or clear the human-readable alias for a session.',
  flags: [
    { name: '--clear',     desc: 'remove the alias (sets to null)' },
    { name: '--dry-run',   desc: 'print the planned event but do not write' },
    { name: '--json',      desc: 'JSON output (machine-readable)' },
    { name: '--root <p>',  desc: 'override storage root (default cwd)' },
  ],
  examples: [
    'sessions-db alias sess_01970000-... pricing-overhaul-main',
    'sessions-db alias sess_01970000-... --clear',
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
  const aliasArg = parsed.positional.alias;
  const clear = parsed.flags['--clear'] === true;
  const root = parsed.flags['--root'];
  const dryRun = parsed.flags['--dry-run'] === true;
  const json = parsed.flags['--json'] === true;
  const quiet = parsed.flags['--quiet'] === true;

  // Mutually-exclusive intent check: must be EITHER alias positional OR
  // --clear. Both or neither is an argparse-class error.
  if (clear && aliasArg !== undefined) {
    process.stderr.write(`error: alias and --clear are mutually exclusive\n`);
    process.exit(2);
  }
  if (!clear && aliasArg === undefined) {
    process.stderr.write(`error: provide an alias positional or --clear\n`);
    process.exit(2);
  }

  // Verify session exists. We could skip this for --dry-run but consistency
  // with non-dry-run UX (same exit code on bad id) outweighs the speed.
  await loadAndVerify(stableId, root ? { root } : {});

  const payload = clear ? { alias: null } : { alias: aliasArg };

  if (dryRun) {
    renderDryRun({ op: 'alias_set', stableId, payload, json });
    return;
  }

  const result = await commitEvent({ op: 'alias_set', stableId, payload, root });
  const code = reportResult({
    result, op: 'alias_set', stableId, json, quiet,
    extra: clear ? { cleared: true } : { alias: aliasArg },
  });
  if (code !== 0) process.exit(code);
}
