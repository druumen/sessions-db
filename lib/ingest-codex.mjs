/**
 * Register codex sessions into the same database as the Claude Code ones.
 *
 * ## Why a one-shot ingest instead of a hook
 *
 * The Claude side is written by two hooks that Claude Code fires. Codex fires
 * nothing we control, so the only way in is to read what it already wrote:
 * `~/.codex/sessions/**\/rollout-*.jsonl`. That makes this a scan, and a scan
 * over other people's files needs to say NO far more often than it says yes —
 * see the two gates below.
 *
 * ## The gates, and why the second one exists
 *
 * 1. `isDruumenWorkspace(cwd)` — the same acceptance rule both hooks use.
 * 2. cwd must be INSIDE the workspace that owns the database being written.
 *
 * Gate 2 is not redundant. Measured on the reference machine 2026-09-08, the
 * 896 rollouts carry 162 distinct cwds; 511 are this workspace and **111 are
 * a personal (non-work) directory**. Gate 1 alone would keep the personal
 * ones out only if they happen to lack a Druumen marker; gate 2 is what makes
 * "this database only ever gets sessions from its own workspace" true by
 * construction — the same invariant the 2026-08-03 cross-workspace pollution
 * fix established for the hooks.
 *
 * ## Timestamps
 *
 * The event `ts` is the rollout's own newest record time, never the ingest
 * clock. Backfilling months of history with `Date.now()` would date every
 * session to the moment it was indexed — the defect 0.4.0 shipped, measured
 * at a median +50 days, and had to fix.
 */

import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { listRolloutFiles, parseRollout, codexSessionsRoot } from './codex.mjs';
import { isDruumenWorkspace } from './hook-common.mjs';
import { sanitizeFirstPrompt } from './sanitize.mjs';
import { loadProjection, newEvent, tryUpdateProjection } from './storage.mjs';
import { generateSessionId } from './uuid.mjs';

/**
 * Is `child` the same path as `parent` or inside it?
 *
 * String prefix with an explicit separator, not `startsWith(parent)`:
 * `/a/workspace-old` starts with `/a/workspace` and is a DIFFERENT directory.
 */
export function isInside(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * @param {{workspaceRoot: string, storage?: object, dryRun?: boolean,
 *   limit?: number, codexRoot?: string, now?: string}} opts
 * @returns {Promise<{ok: boolean, dryRun: boolean, scanned: number,
 *   unparseable: number, skippedNotWorkspace: number, skippedOtherWorkspace: number,
 *   alreadyKnown: number, ingested: number,
 *   sessions: Array<{codex_session_id: string, stable_id: string, cwd: string,
 *     started_at: string|null, last_activity_at: string|null,
 *     originator: string|null, first_prompt_preview: string|null}>}>}
 */
export async function runIngestCodex(opts = {}) {
  const workspaceRoot = opts.workspaceRoot;
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new TypeError('runIngestCodex: workspaceRoot required');
  }
  const storage = opts.storage ?? {};
  const dryRun = opts.dryRun !== false;
  const codexRoot = opts.codexRoot ?? codexSessionsRoot();

  const out = {
    ok: true,
    dryRun,
    scanned: 0,
    unparseable: 0,
    skippedNotWorkspace: 0,
    skippedOtherWorkspace: 0,
    alreadyKnown: 0,
    ingested: 0,
    sessions: [],
  };

  const projection = await loadProjection(storage);
  const known = new Set();
  for (const s of Object.values((projection && projection.sessions) || {})) {
    for (const id of Array.isArray(s.codex_session_ids) ? s.codex_session_ids : []) known.add(id);
  }

  let budget = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : Infinity;

  for (const file of listRolloutFiles(codexRoot)) {
    if (budget <= 0) break;
    out.scanned += 1;

    const roll = parseRollout(file);
    if (!roll) {
      // "We could not read it" — counted, never silently dropped, because a
      // parser regression would otherwise look exactly like an empty corpus.
      out.unparseable += 1;
      continue;
    }
    if (!roll.cwd || !existsSync(roll.cwd) || !isDruumenWorkspace(roll.cwd)) {
      out.skippedNotWorkspace += 1;
      continue;
    }
    if (!isInside(workspaceRoot, roll.cwd)) {
      out.skippedOtherWorkspace += 1;
      continue;
    }
    if (known.has(roll.id)) {
      out.alreadyKnown += 1;
      continue;
    }

    budget -= 1;
    const stableId = generateSessionId();
    const preview = roll.firstPrompt ? sanitizeFirstPrompt(roll.firstPrompt) : '';
    const record = {
      codex_session_id: roll.id,
      stable_id: stableId,
      cwd: roll.cwd,
      started_at: roll.startedAt,
      last_activity_at: roll.lastActivityAt,
      originator: roll.originator,
      first_prompt_preview: preview.length > 0 ? preview : null,
    };
    out.ingested += 1;
    out.sessions.push(record);
    known.add(roll.id);

    if (dryRun) continue;

    const event = newEvent({
      op: 'codex_session_seen',
      stable_id: stableId,
      // The rollout's own clock. `startedAt` is the fallback for a file whose
      // body carried no timestamps at all; `now` exists only so tests can pin
      // the last-resort value.
      ts: roll.lastActivityAt ?? roll.startedAt ?? opts.now ?? new Date().toISOString(),
      payload: {
        codex_session_id: roll.id,
        cwd: roll.cwd,
        started_at: roll.startedAt,
        originator: roll.originator,
        thread_source: roll.threadSource,
        cli_version: roll.cliVersion,
        record_count: roll.recordCount,
        transcript_file: file,
        first_prompt_preview: record.first_prompt_preview,
      },
    });
    try {
      await tryUpdateProjection(event, { ...storage, lockTimeoutMs: 1500 });
    } catch {
      // Same contract as every other writer here: the SSoT-first ordering
      // inside tryUpdateProjection leaves a durable event for `rebuild`.
    }
  }

  return out;
}
