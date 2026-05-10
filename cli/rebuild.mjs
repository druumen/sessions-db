/**
 * `sessions-db rebuild` — rebuild the projection cache from events.jsonl.
 *
 * Use cases:
 *  - Recover after a corrupted projection (loadProjection auto-falls back to
 *    rebuild on parse failure, but a manual rebuild gives ops visible
 *    confirmation).
 *  - After a hand-edit of events.jsonl (rare; e.g. removing a poisoned event).
 *  - During schema migration when the reducer changes meaning of an existing
 *    op.
 *
 * Output: human-readable summary by default, machine-readable JSON with
 * --json. Tolerated tail-partial corruptions (interrupted writes) are
 * surfaced as a count so ops can correlate against hook failures. Middle-
 * line corruptions throw and exit 1.
 */

import { rebuildProjection } from '../storage.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { formatJSON } from './format.mjs';

const SPEC = {
  positional: [],
  flags: {
    '--json': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db rebuild [--json] [--root <p>]',
  summary: 'Rebuild the projection cache from events.jsonl (full fold).',
  flags: [
    { name: '--json',     desc: 'JSON output' },
    { name: '--root <p>', desc: 'override storage root' },
  ],
  examples: [
    'sessions-db rebuild',
    'sessions-db rebuild --root /tmp/sessions-isolation-test',
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

  const root = parsed.flags['--root'];
  const quiet = parsed.flags['--quiet'] === true;
  const json = parsed.flags['--json'] === true;

  let result;
  try {
    result = await rebuildProjection(root ? { root } : {});
  } catch (err) {
    // Middle-line corruption (or other rebuild failure) — surface and exit 1.
    process.stderr.write(`error: rebuild failed: ${err && err.message ? err.message : String(err)}\n`);
    if (err && Array.isArray(err.corruptions) && err.corruptions.length > 0) {
      for (const c of err.corruptions.slice(0, 5)) {
        process.stderr.write(`  line ${c.lineNumber}: ${c.error}\n`);
      }
    }
    process.exit(1);
  }

  if (quiet) return;

  if (json) {
    process.stdout.write(formatJSON({ ok: true, ...result }));
    return;
  }

  // P5: surface toleratedCorruptions on a SECOND line prefixed with "warning:"
  // so log scrapers can grep for `^warning:` (or the parent token) without
  // reading past the "ok:" header. Format aligned with the P5 ticket §5.
  process.stdout.write(
    `ok: rebuilt projection — ${result.sessionCount} session${result.sessionCount === 1 ? '' : 's'}, ` +
    `${result.eventCount} event${result.eventCount === 1 ? '' : 's'}\n`,
  );
  if (result.toleratedCorruptions > 0) {
    process.stdout.write(
      `  (warning: ${result.toleratedCorruptions} tail-partial event line${result.toleratedCorruptions === 1 ? '' : 's'} tolerated)\n`,
    );
  }
}
