/**
 * `sessions-db sweep` — compute and apply activity_state transitions
 * (active → idle → archived) by recency.
 *
 * Day 3 refactor: the planning + commit loop lives in
 * `lib/operations.runSweep`. This handler is a thin wrapper that handles
 * argparse, output rendering (human / JSON / quiet), and exit code mapping.
 *
 * Threshold validation (positive numbers; archive >= idle) stays in the
 * CLI as exit-2 argparse errors so the test suite can pin both message
 * and code without a library prefix in the message.
 */

import { runSweep } from '../lib/operations.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { formatJSON } from './format.mjs';

const SPEC = {
  positional: [],
  flags: {
    '--dry-run': { type: 'boolean' },
    '--idle-threshold-days': { type: 'number' },
    '--archive-threshold-days': { type: 'number' },
    '--json': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db sweep [--dry-run] [--idle-threshold-days N] [--archive-threshold-days N]',
  summary: 'Compute activity_state transitions (active → idle → archived) and write sweep events.',
  flags: [
    { name: '--dry-run',                   desc: 'print planned transitions without writing events' },
    { name: '--idle-threshold-days <N>',   desc: 'override idle threshold (default: _meta.idle_threshold_days || 14)' },
    { name: '--archive-threshold-days <N>', desc: 'override archive threshold (default: _meta.archive_threshold_days || 30)' },
    { name: '--json',                      desc: 'JSON output (machine-readable)' },
    { name: '--root <p>',                  desc: 'override storage root (default cwd)' },
    { name: '--quiet',                     desc: 'silent stdout (exit code only)' },
  ],
  examples: [
    'sessions-db sweep --dry-run                  # preview transitions',
    'sessions-db sweep                            # apply transitions',
    'sessions-db sweep --idle-threshold-days 7    # one-off override',
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
  const dryRun = parsed.flags['--dry-run'] === true;
  const json = parsed.flags['--json'] === true;
  const quiet = parsed.flags['--quiet'] === true;

  // Argparse-class threshold validation. parseArgs already rejected
  // non-numeric values; we additionally reject 0 / negative so a typo
  // like `--idle-threshold-days 0` does not silently disable the
  // threshold (which would auto-archive every session). These exit codes
  // (2, "must be a positive number" / "must be >= --idle-threshold-days")
  // are what the test suite pins against.
  const idleThresholdDays = parsed.flags['--idle-threshold-days'];
  if (idleThresholdDays !== undefined
      && (!Number.isFinite(idleThresholdDays) || idleThresholdDays <= 0)) {
    process.stderr.write(
      `error: --idle-threshold-days must be a positive number (got: ${idleThresholdDays})\n`,
    );
    process.exit(2);
  }
  const archiveThresholdDays = parsed.flags['--archive-threshold-days'];
  if (archiveThresholdDays !== undefined
      && (!Number.isFinite(archiveThresholdDays) || archiveThresholdDays <= 0)) {
    process.stderr.write(
      `error: --archive-threshold-days must be a positive number (got: ${archiveThresholdDays})\n`,
    );
    process.exit(2);
  }
  if (idleThresholdDays !== undefined
      && archiveThresholdDays !== undefined
      && archiveThresholdDays < idleThresholdDays) {
    process.stderr.write(
      `error: --archive-threshold-days (${archiveThresholdDays}) must be >= --idle-threshold-days (${idleThresholdDays})\n`,
    );
    process.exit(2);
  }

  const opts = {
    idleThresholdDays,
    archiveThresholdDays,
    dryRun,
    ...(root ? { root } : {}),
  };
  const result = await runSweep(opts);

  // Dry-run path — print plan and bail. ok is always true for dry-run.
  if (dryRun) {
    const transitions = result.transitions || [];
    if (json) {
      process.stdout.write(formatJSON({
        ok: true,
        dry_run: true,
        transitions,
        count: transitions.length,
      }));
    } else if (!quiet) {
      if (transitions.length === 0) {
        process.stdout.write('ok: sweep dry-run — no transitions needed\n');
      } else {
        process.stdout.write(
          `ok: sweep dry-run — ${transitions.length} transition${transitions.length === 1 ? '' : 's'} planned:\n`,
        );
        for (const t of transitions) {
          process.stdout.write(
            `  ${t.stable_id}  ${t.from_state} → ${t.to_state}  (age ${t.age_days}d, last_progress ${t.effective_last_progress})\n`,
          );
        }
      }
    }
    return;
  }

  const applied = result.applied || [];
  const failed = result.failed || [];
  const summary = result.summary || {
    total: 0, applied: 0, failed: 0, to_idle: 0, to_archived: 0,
  };

  if (json) {
    process.stdout.write(formatJSON({
      ok: failed.length === 0,
      applied,
      failed,
      summary,
    }));
  } else if (!quiet) {
    if (summary.total === 0) {
      process.stdout.write('ok: sweep — no transitions needed\n');
    } else {
      process.stdout.write(
        `ok: sweep — ${applied.length} of ${summary.total} transition${summary.total === 1 ? '' : 's'} applied (${summary.to_idle} to idle, ${summary.to_archived} to archived)\n`,
      );
      for (const a of applied) {
        process.stdout.write(
          `  ${a.stable_id}  ${a.from_state} → ${a.to_state}  (age ${a.age_days}d)\n`,
        );
      }
      if (failed.length > 0) {
        process.stderr.write(`error: ${failed.length} transition${failed.length === 1 ? '' : 's'} failed:\n`);
        for (const f of failed) {
          process.stderr.write(`  ${f.stable_id}  ${f.from_state} → ${f.to_state}: ${f.error}\n`);
        }
      }
    }
  }

  if (failed.length > 0) process.exit(1);
}
