/**
 * `sessions-db prune` — remove ghost records (sessions that were never used).
 *
 * Planning + criteria live in `lib/prune.mjs` (which documents WHY each
 * criterion is there, including the two that are not obvious). This handler
 * is the thin CLI shell: argparse, rendering, exit codes.
 *
 * ## Safety posture
 *
 * This is the only destructive command in the CLI, so the default is
 * deliberately inverted relative to every other subcommand: **running it with
 * no flags performs a dry run**. Deleting requires typing `--yes`. There is
 * no `-y` short alias and no config setting that flips the default — if
 * removing history ever becomes a one-keystroke accident, the safety is
 * decorative.
 *
 * What "delete" means here is also narrower than it sounds: we append a
 * `session_prune` tombstone and let the reducer drop the record. events.jsonl
 * is never rewritten, so the original observations remain readable and a
 * `rebuild` reproduces exactly the same pruned state.
 *
 * Second inversion, same reasoning: a delete is refused outright when the
 * transcript scan is not trustworthy (empty result or read errors — see
 * `assessScanTrust` in lib/prune.mjs). Every other subcommand degrades
 * gracefully when the disk disagrees with it; this one stops, because the
 * scan IS the evidence that a record is a ghost.
 */

import { parseDuration, runPrune, DEFAULT_OLDER_THAN_MS } from '../lib/prune.mjs';
import { ArgparseError, formatHelp, parseArgs } from './argparse.mjs';
import { formatJSON } from './format.mjs';

const SPEC = {
  positional: [],
  flags: {
    '--dry-run': { type: 'boolean' },
    '--yes': { type: 'boolean' },
    '--older-than': { type: 'string' },
    '--reason': { type: 'string' },
    '--json': { type: 'boolean' },
    '--root': { type: 'string' },
    '--quiet': { type: 'boolean' },
    '--accept-untrusted-scan': { type: 'boolean' },
  },
};

export const HELP = formatHelp({
  usage: 'sessions-db prune [--yes] [--older-than <dur>] [--dry-run]',
  summary:
    'Remove ghost records — sessions that were opened but never used.\n' +
    'DRY RUN BY DEFAULT: pass --yes to actually write the tombstones.\n\n' +
    'A record is pruned only when ALL of these hold:\n' +
    '  - first_prompt_preview is empty        (nobody ever typed)\n' +
    '  - both fingerprints are null           (no transcript content ever existed)\n' +
    '  - ai_title is empty                    (no conversation to title)\n' +
    '  - no transcript on disk for any of its claude_session_ids\n' +
    '  - created_at older than --older-than   (default 1h)\n' +
    '  - no alias / parent / child / task / project link, outcome still open\n\n' +
    'Refuses to delete when the transcript scan finds nothing or reports an\n' +
    'error — that scan is the only criterion telling a real never-resumed\n' +
    'session apart from a ghost.',
  flags: [
    { name: '--yes',              desc: 'actually prune (without this, the command only reports)' },
    { name: '--dry-run',          desc: 'force report-only (the default; explicit for scripts)' },
    { name: '--older-than <dur>', desc: 'age floor: 30m / 2h / 7d — unit required (default: 1h)' },
    { name: '--reason <text>',    desc: 'reason recorded in each tombstone payload' },
    { name: '--json',             desc: 'JSON output (machine-readable)' },
    { name: '--root <p>',         desc: 'override storage root (default cwd)' },
    { name: '--quiet',            desc: 'silent stdout (exit code only)' },
    {
      name: '--accept-untrusted-scan',
      desc: 'escape hatch: prune even though the transcript scan was empty / errored',
    },
  ],
  examples: [
    'sessions-db prune                          # report what would be removed',
    'sessions-db prune --older-than 24h --json  # report, machine-readable',
    'sessions-db prune --yes                    # actually remove them',
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
  const json = parsed.flags['--json'] === true;
  const quiet = parsed.flags['--quiet'] === true;
  const explicitDryRun = parsed.flags['--dry-run'] === true;
  const confirmed = parsed.flags['--yes'] === true;

  // `--dry-run --yes` is a contradiction, and guessing which one the operator
  // meant is exactly the wrong instinct for a delete. Reject as argparse.
  if (explicitDryRun && confirmed) {
    process.stderr.write('error: --dry-run and --yes are mutually exclusive\n');
    process.exit(2);
  }

  let olderThanMs = DEFAULT_OLDER_THAN_MS;
  const olderThanRaw = parsed.flags['--older-than'];
  if (olderThanRaw !== undefined) {
    const parsedMs = parseDuration(olderThanRaw);
    if (parsedMs === null) {
      process.stderr.write(
        `error: --older-than expects a duration with a unit — 30m / 2h / 7d ` +
        `(got: ${olderThanRaw})\n`,
      );
      process.exit(2);
    }
    olderThanMs = parsedMs;
  }

  const result = await runPrune({
    dryRun: !confirmed,
    olderThanMs,
    reason: parsed.flags['--reason'],
    acceptUntrustedScan: parsed.flags['--accept-untrusted-scan'] === true,
    ...(root ? { root } : {}),
  });

  if (!result.ok && result.error) {
    if (json) {
      process.stdout.write(formatJSON({
        ok: false,
        error: result.error,
        // Refusals carry the scan that caused them — an operator debugging
        // "why did my cron job stop pruning?" needs the root it looked at.
        ...(result.refused ? { refused: true, disk_scan: result.disk_scan } : {}),
      }));
    } else {
      process.stderr.write(`error: ${result.error}\n`);
    }
    process.exit(1);
  }

  if (result.dryRun) {
    const candidates = result.candidates || [];
    if (json) {
      process.stdout.write(formatJSON({
        ok: true,
        dry_run: true,
        candidates,
        count: candidates.length,
        scanned: result.scanned,
        spared: result.spared,
        disk_scan: result.disk_scan,
      }));
    } else if (!quiet) {
      // A dry run against an untrusted scan is still allowed (reporting is
      // not destructive) but the list it produces is meaningless — say so
      // ABOVE the list, before anyone reads it as a ghost inventory.
      if (result.disk_scan && result.disk_scan.trusted === false) {
        process.stdout.write(untrustedScanBanner(result.disk_scan));
      }
      if (candidates.length === 0) {
        process.stdout.write(
          `ok: prune dry-run — no ghost records among ${result.scanned} sessions\n`,
        );
      } else {
        process.stdout.write(
          `ok: prune dry-run — ${candidates.length} of ${result.scanned} session` +
          `${result.scanned === 1 ? '' : 's'} would be removed ` +
          `(disk scan: ${result.disk_scan.files} transcripts in ${result.disk_scan.dirs} dirs):\n`,
        );
        for (const c of candidates) {
          process.stdout.write(
            `  ${c.stable_id}  created ${c.created_at}  age ${c.age_hours}h  ` +
            `csid ${c.claude_session_ids.join(',') || '(none)'}\n`,
          );
        }
        // Do not tell the operator to run a command that will refuse.
        process.stdout.write(
          result.disk_scan && result.disk_scan.trusted === false
            ? '\nFix the transcript scan, then re-run with --yes ' +
              '(or --yes --accept-untrusted-scan to override).\n'
            : '\nRe-run with --yes to remove them.\n',
        );
      }
    }
    return;
  }

  const pruned = result.pruned || [];
  const failed = result.failed || [];
  if (json) {
    process.stdout.write(formatJSON({
      ok: failed.length === 0,
      dry_run: false,
      pruned,
      failed,
      count: pruned.length,
      scanned: result.scanned,
      spared: result.spared,
      disk_scan: result.disk_scan,
    }));
  } else if (!quiet) {
    // Reached only via --accept-untrusted-scan (the run would have been
    // refused otherwise). Records were deleted on evidence we told the
    // operator not to trust, so it belongs in the transcript of the run.
    if (result.disk_scan && result.disk_scan.trusted === false) {
      process.stdout.write(untrustedScanBanner(result.disk_scan));
    }
    if (pruned.length === 0 && failed.length === 0) {
      process.stdout.write(`ok: prune — no ghost records among ${result.scanned} sessions\n`);
    } else {
      process.stdout.write(
        `ok: prune — ${pruned.length} ghost record${pruned.length === 1 ? '' : 's'} removed ` +
        `(of ${result.scanned} scanned)\n`,
      );
      for (const p of pruned) {
        process.stdout.write(`  ${p.stable_id}  created ${p.created_at}  age ${p.age_hours}h\n`);
      }
      if (failed.length > 0) {
        process.stderr.write(`error: ${failed.length} tombstone(s) failed to write:\n`);
        for (const f of failed) {
          process.stderr.write(`  ${f.stable_id}: ${f.error}\n`);
        }
      }
    }
  }

  if (failed.length > 0) process.exit(1);
}

/**
 * Banner for a scan that proved nothing. Printed before the candidate list so
 * nobody reads that list as an inventory of ghosts: with an empty or failed
 * scan, "no transcript on disk" is true of every record, including every real
 * session that was simply never resumed.
 *
 * @param {{ root?: string|null, files?: number, dirs?: number,
 *   errors?: string[], untrusted_reasons?: string[] }} diskScan
 * @returns {string}
 */
function untrustedScanBanner(diskScan) {
  const reasons = Array.isArray(diskScan.untrusted_reasons) ? diskScan.untrusted_reasons : [];
  const detail = reasons.includes('empty_scan')
    ? `0 transcripts found under ${diskScan.root || '(unknown root)'}`
    : `${(diskScan.errors || []).length} scan error(s) under ${diskScan.root || '(unknown root)'}`;
  return (
    `warning: TRANSCRIPT SCAN NOT TRUSTWORTHY — ${detail}.\n` +
    'warning: every candidate below may be a real session that was simply ' +
    'never resumed.\n' +
    'warning: check DRUUMEN_CLAUDE_PROJECTS_ROOT / HOME before believing this ' +
    'list.\n\n'
  );
}
