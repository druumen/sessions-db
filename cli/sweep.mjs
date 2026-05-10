/**
 * `sessions-db sweep` — compute and apply activity_state transitions
 * (active → idle → archived) by recency.
 *
 * Reads the projection cache, asks the pure `computeSweepTransitions` planner
 * which sessions need a state change, and writes one `sweep` event per
 * transition through the standard `tryUpdateProjection` lock-and-apply path.
 * Idempotent: re-running on the same projection (same `now`) yields zero
 * transitions.
 *
 * The sweep operator (cron, manual ops, post-task hook) does not need to know
 * which signals contributed to the recency calculation — that's encapsulated
 * in `computeEffectiveLastProgress`. Today: max of (last_progress_at,
 * transcript mtimes, hive_watcher_last_seen). Future signals just extend the
 * planner without changing the CLI surface.
 *
 * Locking: each transition acquires the projection lock independently via
 * `tryUpdateProjection`. For typical sweep volumes (single digits per run)
 * this is fine; if the workspace grows huge a future `--batch` mode can fold
 * all transitions into a single under-lock pass. P5 keeps it simple — one
 * lock per transition matches the existing event semantics (one event = one
 * audit-trail row) and avoids partial-batch failure modes.
 */

import { computeSweepTransitions } from '../sweep.mjs';
import { loadProjection, newEvent, tryUpdateProjection } from '../storage.mjs';
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

  // Threshold flags must be a positive number when provided. parseArgs
  // already rejected non-numeric values; we additionally reject 0 / negative
  // so a typo like `--idle-threshold-days 0` does not silently disable the
  // threshold (which would auto-archive every session).
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

  // Load the current projection — sweep is read-mostly, the rare write side
  // re-acquires the lock per transition via tryUpdateProjection.
  const projection = await loadProjection(root ? { root } : {});

  const transitions = computeSweepTransitions(projection, {
    idleThresholdDays,
    archiveThresholdDays,
  });

  // Dry-run path — print and bail. We do not need the lock for any of this.
  if (dryRun) {
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

  // Real sweep — write one event per transition. We accumulate failures so
  // a single hung lock does not silently hide the others; the operator sees
  // exactly which transitions landed and which did not.
  const applied = [];
  const failed = [];
  for (const t of transitions) {
    const event = newEvent({
      op: 'sweep',
      stable_id: t.stable_id,
      payload: {
        activity_state: t.to_state,
        effective_last_progress: t.effective_last_progress,
      },
    });
    const result = await tryUpdateProjection(event, root ? { root } : {});
    if (result.ok) {
      applied.push({ ...t, event_id: event.event_id });
    } else {
      failed.push({ ...t, error: result.error });
    }
  }

  // Tally for the summary line. Accept both "to idle" and "to archived" as
  // discrete buckets — operators care about how many sessions just rotated
  // out of "active triage" (idle) vs out of the workspace entirely (archived).
  const toIdle = applied.filter((a) => a.to_state === 'idle').length;
  const toArchived = applied.filter((a) => a.to_state === 'archived').length;

  if (json) {
    process.stdout.write(formatJSON({
      ok: failed.length === 0,
      applied,
      failed,
      summary: {
        total: transitions.length,
        applied: applied.length,
        failed: failed.length,
        to_idle: toIdle,
        to_archived: toArchived,
      },
    }));
  } else if (!quiet) {
    if (transitions.length === 0) {
      process.stdout.write('ok: sweep — no transitions needed\n');
    } else {
      process.stdout.write(
        `ok: sweep — ${applied.length} of ${transitions.length} transition${transitions.length === 1 ? '' : 's'} applied (${toIdle} to idle, ${toArchived} to archived)\n`,
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
