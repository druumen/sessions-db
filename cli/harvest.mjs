/**
 * `sessions-db harvest` — backfill names and MR links from transcripts that
 * are already on disk.
 *
 * The planning and the write both live in `lib/harvest.mjs` — the SAME
 * function the hooks call, which is the point: a backfill that re-implemented
 * the harvest would drift from it, and the drift would show up as records
 * that disagree depending on which path wrote them.
 *
 * Dry run by default (see `runHarvest`). This command is not destructive, but
 * it appends to an append-only log, so the default is to show first.
 */

import { runHarvest } from '../lib/harvest.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { formatJSON } from './format.mjs';

const SPEC = {
  positional: [],
  flags: {
    '--yes': { type: 'boolean' },
    '--dry-run': { type: 'boolean' },
    '--limit': { type: 'number' },
    '--json': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db harvest [--yes] [--limit <n>]',
  summary:
    'Backfill session names (ai-title / custom-title / agent-name) and the MRs\n' +
    'a session opened (pr-link) from transcripts already on disk.\n' +
    'DRY RUN BY DEFAULT: pass --yes to write the events.\n\n' +
    'The hooks only ever harvest sessions that are still in use. Records that\n' +
    'predate the harvest have a transcript carrying a title and a projection\n' +
    'carrying nothing, and no hook will fire for them again — this closes that\n' +
    'gap. Transcripts are resolved by claude_session_id (exact filename), not\n' +
    'through transcript_files[], which is known to mis-attribute.',
  flags: [
    { name: '--yes',        desc: 'actually write the events (without this, report only)' },
    { name: '--dry-run',    desc: 'force report-only (the default; explicit for scripts)' },
    { name: '--limit <n>',  desc: 'stop after n sessions that had a transcript (try a small run first)' },
    { name: '--json',       desc: 'JSON output (machine-readable)' },
    { name: '--root <p>',   desc: 'override storage root (default cwd)' },
    { name: '--quiet',      desc: 'silent stdout (exit code only)' },
  ],
  examples: [
    'sessions-db harvest --limit 5        # preview what 5 sessions would gain',
    'sessions-db harvest --json           # preview everything, machine-readable',
    'sessions-db harvest --yes            # write it',
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

  const explicitDryRun = parsed.flags['--dry-run'] === true;
  const confirmed = parsed.flags['--yes'] === true;
  // Same reasoning as prune: guessing which one the operator meant is the
  // wrong instinct for a command that writes.
  if (explicitDryRun && confirmed) {
    process.stderr.write('error: --dry-run and --yes are mutually exclusive\n');
    process.exit(2);
  }

  const root = parsed.flags['--root'];
  const result = await runHarvest({
    dryRun: !confirmed,
    ...(parsed.flags['--limit'] !== undefined ? { limit: parsed.flags['--limit'] } : {}),
    ...(root ? { root } : {}),
  });

  if (parsed.flags['--quiet'] === true) return;

  if (parsed.flags['--json'] === true) {
    process.stdout.write(formatJSON(result));
    return;
  }

  const lines = [];
  lines.push(result.dryRun
    ? `DRY RUN — nothing was written. ${result.changed} of ${result.withTranscript} sessions with a transcript would gain ${result.events} event(s).`
    : `Wrote ${result.events} event(s) across ${result.changed} session(s).`);
  lines.push(`  considered ${result.scanned} · transcript on disk ${result.withTranscript}`);
  for (const s of result.sessions.slice(0, 20)) {
    lines.push(`  ${s.stable_id}  ${s.ops.join(' ')}`);
  }
  if (result.sessions.length > 20) lines.push(`  … and ${result.sessions.length - 20} more`);
  if (result.dryRun && result.events > 0) lines.push('Run again with --yes to write.');
  process.stdout.write(lines.join('\n') + '\n');
}
