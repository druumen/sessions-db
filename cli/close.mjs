/**
 * `sessions-db close <stable_id> --outcome X [--reason "..."]` — mark a
 * session closed with a terminal outcome.
 *
 * Day 3 refactor: routes through `lib/operations.closeSession`. The CLI
 * keeps the historical exit-2 path for missing / invalid `--outcome`
 * (an argparse-class error) so the test suite can pin both the message
 * and the code without depending on operations' return shape for those
 * pre-call validations.
 *
 * Outcome enum is enforced (matches projection schema):
 *   open | done | blocked | abandoned | merged | superseded
 */

import { closeSession } from '../lib/operations.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { renderDryRun, reportResult, reportStableIdNotFound } from './_write-helpers.mjs';

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

  // Argparse-class checks (exit 2). The library would also reject these,
  // but routing through CLI keeps the historical message + exit code that
  // tests pin against.
  if (!outcome) {
    process.stderr.write(`error: --outcome is required\n`);
    process.exit(2);
  }
  if (!VALID_OUTCOMES.has(outcome)) {
    process.stderr.write(`error: --outcome must be one of: ${[...VALID_OUTCOMES].join(', ')}\n`);
    process.exit(2);
  }

  if (dryRun) {
    const payload = { outcome };
    if (reason !== undefined) payload.closed_reason = reason;
    renderDryRun({ op: 'close', stableId, payload, json });
    return;
  }

  const opts = root ? { root } : {};
  const result = await closeSession({
    stableId,
    outcome,
    reason,
    ...opts,
  });

  if (!result.ok && typeof result.error === 'string'
      && result.error.startsWith('stable_id not found:')) {
    if (!quiet) {
      const code = reportStableIdNotFound(result.error);
      process.exit(code);
    }
    process.exit(1);
  }

  const extra = { outcome };
  if (reason !== undefined) extra.reason = reason;
  const code = reportResult({
    result, op: 'close', stableId, json, quiet, extra,
  });
  if (code !== 0) process.exit(code);
}
