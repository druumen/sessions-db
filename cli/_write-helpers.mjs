/**
 * Shared helpers for write subcommands (alias / link / link-parent / close).
 *
 * Day 3: the actual mutation logic lives in `lib/operations.mjs`. These
 * helpers handle the CLI surface only:
 *   - rendering planned events for `--dry-run`
 *   - mapping the library result `{ ok, event_id?, error? }` into stdout /
 *     stderr / exit code in three formats: human (default), `--json`,
 *     `--quiet`.
 *
 * Why keep the helpers? The five write handlers all share the same
 * presentation logic — centralizing it keeps each handler focused on flag
 * plumbing + the operations-call signature mapping.
 *
 * Note on output messages: the test suite regex-matches phrases like
 * `ok: <op> written for <stable_id>` and `error: stable_id not found`. Any
 * change to wording here MUST be paired with a sweep of __tests__/cli/*.
 */

import { newEvent } from '../lib/storage.mjs';
import { formatJSON } from './format.mjs';

/**
 * Render a planned event for --dry-run. Always returns the event so callers
 * can post-process if they need to. Output goes to stdout for easy piping.
 *
 * The intent is that the rendered output be machine-grep-able (op + stable_id
 * + payload as JSON) so pipelines can audit what would change without
 * actually writing.
 */
export function renderDryRun({ op, stableId, payload, json = false }) {
  const event = newEvent({ op, stable_id: stableId, payload });
  if (json) {
    process.stdout.write(formatJSON({ dry_run: true, event }));
  } else {
    process.stdout.write(`[dry-run] would write event:\n`);
    process.stdout.write(`  op:        ${op}\n`);
    process.stdout.write(`  stable_id: ${stableId}\n`);
    process.stdout.write(`  payload:   ${JSON.stringify(payload)}\n`);
  }
  return event;
}

/**
 * Standard success / failure feedback for write commands.
 *
 * Result shape comes straight from `lib/operations.mjs` —
 * `{ ok, event_id?, error? }`. We render and return the exit code the caller
 * should hand to process.exit().
 *
 * Exit code policy:
 *   - 0 = success
 *   - 1 = business error (stable_id not found, validation failure, lock
 *     timeout, cycle detection — anything `operations.*` returned with
 *     `{ ok: false }`)
 *
 * `--quiet` swallows stdout but preserves the exit code so cron / scripted
 * usage stays observable via `$?`.
 */
export function reportResult({ result, op, stableId, json, quiet, extra = {} }) {
  if (quiet) return result.ok ? 0 : 1;
  if (json) {
    process.stdout.write(formatJSON({
      ok: result.ok,
      op,
      stable_id: stableId,
      event_id: result.event_id,
      error: result.error,
      ...extra,
    }));
  } else if (result.ok) {
    process.stdout.write(`ok: ${op} written for ${stableId} (event_id=${result.event_id})\n`);
    for (const [k, v] of Object.entries(extra)) {
      process.stdout.write(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
    }
  } else {
    process.stderr.write(`error: ${op} failed for ${stableId}: ${result.error}\n`);
  }
  return result.ok ? 0 : 1;
}

/**
 * Special-case the "stable_id not found" error so the CLI prints the
 * historical exact phrase the tests pin against:
 *
 *   error: stable_id not found: <id>
 *
 * The operations layer uses the same wording for that error, but it embeds
 * it inside the call's `result.error`. When the wrapper detects this prefix
 * it re-emits the bare phrase to stderr so the existing test regex
 * `/stable_id not found/` and operator muscle memory keep working.
 *
 * Returns the exit code the handler should hand to process.exit() —
 * typically 1 for a not-found, but the caller may pass `code` to override.
 */
export function reportStableIdNotFound(error, code = 1) {
  process.stderr.write(`error: ${error}\n`);
  return code;
}
