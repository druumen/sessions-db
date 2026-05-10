/**
 * `sessions-db close <stable_id> --outcome X [--reason "..."]` — mark a
 * session closed with a terminal outcome. Writes a `close` event whose
 * P1 reducer sets `outcome`, `closed_at = event.ts`, and `closed_reason`.
 *
 * Outcome enum is enforced (matches projection schema):
 *   open | done | blocked | abandoned | merged | superseded
 *
 * `open` is allowed via close so an operator can REOPEN a previously-closed
 * session (sets outcome back to open, clears closed_reason if --reason
 * "(reopened)" is passed). The reducer's closed_at always tracks the
 * latest close event's ts, which preserves the reopen history in the jsonl.
 */

import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { commitEvent, loadAndVerify, renderDryRun, reportResult } from './_write-helpers.mjs';

const VALID_OUTCOMES = new Set(['open', 'done', 'blocked', 'abandoned', 'merged', 'superseded']);

const SPEC = {
  positional: [{ name: 'stable_id', required: true }],
  flags: {
    '--outcome': { type: 'string' },
    '--reason': { type: 'string' },
    '--dry-run': { type: 'boolean' },
    '--json': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db close <stable_id> --outcome <outcome> [--reason "..."]',
  summary: 'Close (or reopen) a session with a terminal outcome.',
  flags: [
    { name: '--outcome <s>', desc: 'open | done | blocked | abandoned | merged | superseded' },
    { name: '--reason <s>',  desc: 'human-readable reason (free text)' },
    { name: '--dry-run',     desc: 'print event but do not write' },
    { name: '--json',        desc: 'JSON output' },
    { name: '--root <p>',    desc: 'override storage root' },
  ],
  examples: [
    'sessions-db close sess_01970000-... --outcome done --reason "merged into master"',
    'sessions-db close sess_01970000-... --outcome blocked --reason "waiting on infra"',
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
  const outcome = parsed.flags['--outcome'];
  const reason = parsed.flags['--reason'];
  const root = parsed.flags['--root'];
  const dryRun = parsed.flags['--dry-run'] === true;
  const json = parsed.flags['--json'] === true;
  const quiet = parsed.flags['--quiet'] === true;

  if (!outcome) {
    process.stderr.write(`error: --outcome is required\n`);
    process.exit(2);
  }
  if (!VALID_OUTCOMES.has(outcome)) {
    process.stderr.write(`error: --outcome must be one of: ${[...VALID_OUTCOMES].join(', ')}\n`);
    process.exit(2);
  }

  await loadAndVerify(stableId, root ? { root } : {});

  const payload = { outcome };
  if (reason !== undefined) payload.closed_reason = reason;

  if (dryRun) {
    renderDryRun({ op: 'close', stableId, payload, json });
    return;
  }

  const result = await commitEvent({ op: 'close', stableId, payload, root });
  const extra = { outcome };
  if (reason !== undefined) extra.reason = reason;
  const code = reportResult({
    result, op: 'close', stableId, json, quiet, extra,
  });
  if (code !== 0) process.exit(code);
}
