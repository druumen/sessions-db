/**
 * Shared helpers for write subcommands (alias / link / link-parent / close).
 *
 * Why a shared module instead of inlining? Three behaviors are identical
 * across all four:
 *   1. Verify the target stable_id exists in the projection BEFORE writing
 *      anything (no "create-on-write" magic — the contract is that hooks
 *      mint stable_ids; CLI only mutates known sessions).
 *   2. Render the planned event under --dry-run and return without touching
 *      disk.
 *   3. Build the canonical event via newEvent and route it through
 *      tryUpdateProjection (which handles the lock + jsonl-then-projection
 *      ordering invariant from P1 storage).
 *
 * Centralizing keeps the four subcommand handlers focused on flag plumbing
 * and post-write feedback messages.
 */

import { loadProjection, newEvent, tryUpdateProjection } from '../lib/storage.mjs';
import { formatJSON } from './format.mjs';

/**
 * Verify a stable_id exists in the projection. Returns the session record
 * on success; calls process.exit(1) with an error message on miss.
 *
 * The miss is a business error (1) not an argparse error (2) — the user
 * passed a syntactically-valid id that just doesn't exist; that's a runtime
 * lookup failure not a flag-parse failure.
 *
 * @param {string} stableId
 * @param {{ root?: string }} opts
 * @returns {Promise<{ projection: object, session: object }>}
 */
export async function loadAndVerify(stableId, opts = {}) {
  const projection = await loadProjection(opts);
  const session = projection.sessions && projection.sessions[stableId];
  if (!session) {
    process.stderr.write(`error: stable_id not found: ${stableId}\n`);
    process.exit(1);
  }
  return { projection, session };
}

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
 * Build the event + route through tryUpdateProjection. Surfaces the result
 * (ok or error) and returns the event_id on success.
 *
 * @returns {Promise<{ ok: boolean, event_id?: string, error?: string }>}
 */
export async function commitEvent({ op, stableId, payload, root }) {
  const event = newEvent({ op, stable_id: stableId, payload });
  const result = await tryUpdateProjection(event, root ? { root } : {});
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, event_id: event.event_id };
}

/**
 * Standard success / failure feedback for write commands.
 * Returns the exit code the caller should hand to process.exit().
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
