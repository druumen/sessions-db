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
 * 2. the rollout's cwd must be INSIDE the workspace that owns **the database
 *    being written**.
 *
 * Gate 2 is not redundant. Measured on the reference machine 2026-09-08, the
 * 896 rollouts carry 162 distinct cwds; 511 are this workspace and **111 are
 * a personal (non-work) directory**. Gate 1 alone would keep the personal
 * ones out only if they happen to lack a Druumen marker; gate 2 is what keeps
 * "this database only ever gets sessions from its own workspace" true — the
 * same invariant the 2026-08-03 cross-workspace pollution fix established.
 *
 * ### Gate 2 is anchored on the DATABASE, not on where you are standing
 *
 * The first version compared against `process.cwd()`, which is a different
 * thing from the write target the moment either `--root` or
 * `DRUUMEN_SESSIONS_DB_ROOT` is in play — and the env var is the documented
 * way to point at a database (`CLAUDE.md` teaches it). Review reproduced both
 * bypasses: standing in workspace A and writing to B's database registered
 * A's sessions into B with the gate reporting `outside this workspace 0`.
 *
 * So the gate root is now DERIVED from the resolved storage location, and a
 * caller whose `workspaceRoot` is a different workspace than the database's
 * is REFUSED rather than silently re-pointed. Refusing is the loud half:
 * gating correctly but ingesting nothing would look like an empty corpus.
 *
 * The tests missed this for a reason worth keeping: every call passed
 * `{workspaceRoot: ws, storage: {root: ws}}` — the two parameters were always
 * EQUAL, and the defect lived only where they differ.
 *
 * ## Timestamps
 *
 * The event `ts` is the rollout's own newest record time, never the ingest
 * clock. Backfilling months of history with `Date.now()` would date every
 * session to the moment it was indexed — the defect 0.4.0 shipped, measured
 * at a median +50 days, and had to fix.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

import { listRolloutFiles, parseRollout, codexSessionsRoot } from './codex.mjs';
import { isDruumenWorkspace } from './hook-common.mjs';

import { sanitizeFirstPrompt } from './sanitize.mjs';
import { loadProjection, newEvent, resolveWritePaths, tryUpdateProjection } from './storage.mjs';
import { generateSessionId } from './uuid.mjs';

/**
 * The workspace that owns a database, derived from where the database
 * actually resolves to — the same resolver the writer uses, so the gate and
 * the write can never disagree about which workspace is in play.
 *
 * Layouts, both of which this repo writes:
 *   <workspace>/.dru-code/sessions-db.json      → workspace = dirname
 *   <workspace>/tickets/_logs/sessions-db.json  → workspace = dirname(dirname)
 * Anything else (a bare directory handed in by a test or an operator) is
 * treated as its own workspace root — conservative: it gates on exactly the
 * directory the data lands in.
 *
 * @param {{root?: string, rootPath?: string, paths?: object}} storage
 * @returns {string}
 */
export function storageWorkspaceRoot(storage = {}) {
  // `resolveWritePaths` is the writer's OWN resolver, re-exported from
  // storage.mjs. The first version asked `lib/paths.mjs` instead, which
  // ASCENDS to find an existing database while the writer, for `{root: X}`,
  // writes `X/tickets/_logs/` without ascending. Standing in a subdirectory
  // therefore gated on the workspace's real database while the events landed
  // in a brand-new one under the subdirectory — the gate vouching for a file
  // the run never touched. Two resolvers is the bug; there is now one.
  const dir = realPathOrSelf(resolve(dirname(resolveWritePaths(storage).projectionPath)));
  const base = basename(dir);
  if (base === '.dru-code') return dirname(dir);
  if (base === '_logs' && basename(dirname(dir)) === 'tickets') return dirname(dirname(dir));
  return dir;
}

/**
 * Resolve symlinks when the path exists, otherwise return it unchanged.
 *
 * Both sides of gate 2 have to be in the same namespace or the comparison is
 * meaningless. Two real ways they differ: macOS hands out `/var/...` while a
 * process started there reports `/private/var/...` (caught by the
 * subdirectory CLI test, which uses the OS temp dir), and a workspace reached
 * through a symlinked checkout gives the rollout one spelling and the running
 * command another. Not throwing on a missing path matters: a rollout whose
 * cwd has since been deleted must fall through to the existing gate that
 * rejects it, not blow up the whole scan.
 *
 * @param {string} p
 * @returns {string}
 */
function realPathOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Is `child` the same path as `parent` or inside it?
 *
 * String prefix with an explicit separator, not `startsWith(parent)`:
 * `/a/workspace-old` starts with `/a/workspace` and is a DIFFERENT directory.
 */
export function isInside(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  const p = realPathOrSelf(resolve(parent));
  const c = realPathOrSelf(resolve(child));
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
    failed: 0,
    sessions: [],
  };

  // Gate 2's anchor: the workspace that owns the database we are about to
  // write, not the one the operator happens to be standing in. See the module
  // header — comparing against cwd is what let `--root` and
  // DRUUMEN_SESSIONS_DB_ROOT drive sessions into another workspace's database.
  const dbWorkspace = storageWorkspaceRoot(storage);
  // The path events will actually land in, carried in the result so callers
  // (and tests) can assert the gate and the write agree. Review's acceptance
  // criterion for this fix, stated as data rather than as a promise.
  out.eventsPath = resolveWritePaths(storage).eventsPath;
  if (!isInside(dbWorkspace, workspaceRoot) && !isInside(workspaceRoot, dbWorkspace)) {
    return {
      ...out,
      ok: false,
      refused: 'workspace_mismatch',
      workspaceRoot: resolve(workspaceRoot),
      dbWorkspace,
    };
  }

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
    if (!isInside(dbWorkspace, roll.cwd)) {
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
    known.add(roll.id);

    if (dryRun) {
      // A dry run counts what it WOULD write. The real run counts what
      // actually landed — see below; incrementing before the write is how a
      // failed run still reported "Registered 1".
      out.ingested += 1;
      out.sessions.push(record);
      continue;
    }

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
    // `tryUpdateProjection` does NOT throw on failure — it returns
    // `{ok: false, error}`. The first version only wrapped it in try/catch and
    // ignored the return, so a lock timeout (1500 ms, and this loop can issue
    // hundreds of sequential writes while two hooks compete for the same lock)
    // printed "Registered N" with nothing in the database. Reachability was
    // measured during review: the payload-size ceiling is not reachable here
    // (largest event 1058 bytes against a 4096 cap), the lock timeout is.
    let result;
    try {
      result = await tryUpdateProjection(event, { ...storage, lockTimeoutMs: 1500 });
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (!result || result.ok !== true) {
      out.failed += 1;
      out.ok = false;
      record.error = (result && result.error) || 'unknown write failure';
      out.sessions.push(record);
      continue;
    }
    out.ingested += 1;
    out.sessions.push(record);
  }

  return out;
}
